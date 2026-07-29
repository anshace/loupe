import { describe, expect, it } from "vitest";
import type { RepoReader } from "./agentic";
import {
  DEFAULT_AGENTIC_CAPS,
  agenticComplete,
  executeToolCalls,
  githubRepoReader,
  newAgenticUsage,
} from "./agentic";
import { CostTracker } from "./cost";
import type { ModelRequest, ModelResponse, ReviewModel } from "./model";

function fakeReader(files: Record<string, string>): RepoReader {
  return {
    listTree: async () => Object.keys(files),
    readFile: async (path) => files[path],
  };
}

/** Provider that replays a fixed sequence of responses. */
class ReplayModel implements ReviewModel {
  readonly name = "mock";
  readonly requests: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly responses: string[]) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const text = this.responses[Math.min(this.i, this.responses.length - 1)];
    this.i += 1;
    return { text, inputTokens: 10, outputTokens: 5 };
  }
}

const FILES = {
  "src/a.ts": "export function target(x: number) {\n  return x + 1;\n}\n",
  "src/caller.ts": 'import { target } from "./a";\nexport const y = target(1);\n',
  "img/logo.png": "binary-ish",
};

const PROMPT = { system: "sys", user: "user" };

describe("executeToolCalls", () => {
  it("read_file returns numbered content and counts reads/bytes", async () => {
    const usage = newAgenticUsage();
    const out = await executeToolCalls(
      [{ tool: "read_file", path: "src/a.ts" }],
      fakeReader(FILES),
      DEFAULT_AGENTIC_CAPS,
      usage,
    );
    expect(out).toContain("[read_file src/a.ts]");
    expect(out).toContain("    1| export function target(x: number) {");
    expect(usage.fileReads).toBe(1);
    expect(usage.bytesRead).toBe(FILES["src/a.ts"].length);
  });

  it("read_file reports missing files without consuming the read budget", async () => {
    const usage = newAgenticUsage();
    const out = await executeToolCalls(
      [{ tool: "read_file", path: "nope.ts" }],
      fakeReader(FILES),
      DEFAULT_AGENTIC_CAPS,
      usage,
    );
    expect(out).toContain("file not found");
    expect(usage.fileReads).toBe(0);
  });

  it("grep reports matching paths and matching lines, skipping binary-ish files", async () => {
    const usage = newAgenticUsage();
    const out = await executeToolCalls(
      [{ tool: "grep", pattern: "target" }],
      fakeReader(FILES),
      DEFAULT_AGENTIC_CAPS,
      usage,
    );
    expect(out).toContain("src/a.ts:1: export function target(x: number) {");
    expect(out).toContain("src/caller.ts:2: export const y = target(1);");
    expect(out).not.toContain("logo.png:");
  });

  it("enforces the file-read cap and marks the budget exhausted", async () => {
    const usage = newAgenticUsage();
    const caps = { ...DEFAULT_AGENTIC_CAPS, maxFileReads: 1 };
    const out = await executeToolCalls(
      [
        { tool: "read_file", path: "src/a.ts" },
        { tool: "read_file", path: "src/caller.ts" },
      ],
      fakeReader(FILES),
      caps,
      usage,
    );
    expect(out).toContain("refused: tool budget exhausted");
    expect(usage.fileReads).toBe(1);
    expect(usage.cappedOut).toBe(true);
  });

  it("truncates read_file content at the byte cap", async () => {
    const usage = newAgenticUsage();
    const caps = { ...DEFAULT_AGENTIC_CAPS, maxTotalBytes: 10 };
    const out = await executeToolCalls(
      [{ tool: "read_file", path: "src/a.ts" }],
      fakeReader(FILES),
      caps,
      usage,
    );
    expect(out).toContain("truncated at byte cap");
    expect(usage.bytesRead).toBe(10);
    expect(usage.cappedOut).toBe(true);
  });

  it("rejects invalid grep patterns without throwing", async () => {
    const usage = newAgenticUsage();
    const out = await executeToolCalls(
      [{ tool: "grep", pattern: "([" }],
      fakeReader(FILES),
      DEFAULT_AGENTIC_CAPS,
      usage,
    );
    expect(out).toContain("invalid pattern");
  });
});

describe("agenticComplete", () => {
  it("returns the first response directly when it is not a tool call", async () => {
    const model = new ReplayModel(["[]"]);
    const tracker = new CostTracker();
    const result = await agenticComplete(model, PROMPT, tracker, {
      reader: fakeReader(FILES),
    });
    expect(result.response?.text).toBe("[]");
    expect(result.usage.hops).toBe(0);
    expect(tracker.inputTokens).toBe(10);
  });

  it("executes tool calls, re-prompts with results, then returns findings", async () => {
    const model = new ReplayModel([
      '{"tool_calls": [{"tool": "grep", "pattern": "target"}]}',
      "[]",
    ]);
    const tracker = new CostTracker();
    const result = await agenticComplete(model, PROMPT, tracker, { reader: fakeReader(FILES) });
    expect(result.response?.text).toBe("[]");
    expect(result.usage.hops).toBe(1);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].user).toContain("Tool results:");
    expect(model.requests[1].user).toContain("src/caller.ts:2");
  });

  it("ignores tool calls entirely when agentic options are absent", async () => {
    const model = new ReplayModel(['{"tool_calls": [{"tool": "read_file", "path": "src/a.ts"}]}']);
    const result = await agenticComplete(model, PROMPT, new CostTracker());
    expect(model.requests).toHaveLength(1);
    expect(result.response?.text).toContain("tool_calls");
  });

  it("forces a findings answer when the hop cap is exhausted", async () => {
    const toolCall = '{"tool_calls": [{"tool": "read_file", "path": "src/a.ts"}]}';
    const model = new ReplayModel([toolCall, toolCall, "[]"]);
    const tracker = new CostTracker();
    const result = await agenticComplete(model, PROMPT, tracker, {
      reader: fakeReader(FILES),
      caps: { maxHops: 1 },
    });
    expect(result.usage.hops).toBe(1);
    expect(result.response?.text).toBe("[]");
    expect(model.requests[2].user).toContain("The tool budget is exhausted");
  });

  it("gives up after one forced re-prompt if the model keeps asking for tools", async () => {
    const toolCall = '{"tool_calls": [{"tool": "read_file", "path": "src/a.ts"}]}';
    const model = new ReplayModel([toolCall]);
    const result = await agenticComplete(model, PROMPT, new CostTracker(), {
      reader: fakeReader(FILES),
      caps: { maxHops: 0 },
    });
    // First call → forced re-prompt → second call still tools → hand it downstream.
    expect(model.requests).toHaveLength(2);
    expect(result.response?.text).toBe(toolCall);
    expect(result.usage.hops).toBe(0);
  });

  it("stops on the cost cap without a model call and reports costStopped", async () => {
    const model = new ReplayModel(["[]"]);
    const tracker = new CostTracker({ maxInputTokens: 0 });
    const result = await agenticComplete(model, PROMPT, tracker, { reader: fakeReader(FILES) });
    expect(result.response).toBeUndefined();
    expect(result.costStopped).toBe(true);
    expect(model.requests).toHaveLength(0);
  });

  it("stops mid-loop when a hop pushes usage over the token cap", async () => {
    const toolCall = '{"tool_calls": [{"tool": "grep", "pattern": "target"}]}';
    const model = new ReplayModel([toolCall, "[]"]);
    const tracker = new CostTracker({ maxInputTokens: 15 });
    const result = await agenticComplete(model, PROMPT, tracker, { reader: fakeReader(FILES) });
    // First call records 10 input tokens; second call would fit (10 < 15)…
    // after it records, cap hit — but it already returned findings.
    expect(result.response?.text).toBe("[]");
    expect(tracker.canProceed()).toBe(false);
  });
});

describe("githubRepoReader", () => {
  it("lists blob paths from git/trees and caches the tree", async () => {
    let treeCalls = 0;
    const reader = githubRepoReader({ owner: "o", repo: "r", prNumber: 1 }, "tok", "sha1", async (url) => {
      if (url.includes("/git/trees/")) {
        treeCalls += 1;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              tree: [
                { path: "src/a.ts", type: "blob" },
                { path: "src", type: "tree" },
              ],
            }),
        };
      }
      return { ok: true, status: 200, text: async () => "content" };
    });
    expect(await reader.listTree()).toEqual(["src/a.ts"]);
    expect(await reader.listTree()).toEqual(["src/a.ts"]);
    expect(treeCalls).toBe(1);
    expect(await reader.readFile("src/a.ts")).toBe("content");
  });

  it("returns an empty tree on API errors", async () => {
    const reader = githubRepoReader({ owner: "o", repo: "r", prNumber: 1 }, "tok", undefined, async () => ({
      ok: false,
      status: 500,
      text: async () => "boom",
    }));
    expect(await reader.listTree()).toEqual([]);
  });
});
