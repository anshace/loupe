/** run.ts wiring for feedback observability (#12) + learned-rule queue (#31). */
import { describe, expect, it } from "vitest";
import type { ExistingComment, ExistingComments } from "./dedupe";
import type { FetchLike } from "./diff";
import type { ModelRequest, ModelResponse, ReviewModel } from "./model";
import type { RunLogRecord } from "./runlog";
import { runReview } from "./run";
import type { RunDeps } from "./run";
import type { PrIdentity } from "./types";

const pr: PrIdentity = { owner: "anshace", repo: "demo", prNumber: 7 };

const DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 export { x };`;

const diffFetch: FetchLike = async () => ({ ok: true, status: 200, text: async () => DIFF });

class ReplayModel implements ReviewModel {
  readonly name = "mock";
  constructor(private readonly responses: string[]) {}
  private i = 0;
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const text = this.responses[Math.min(this.i, this.responses.length - 1)];
    this.i += 1;
    return { text, inputTokens: 10, outputTokens: 5 };
  }
}

// Two prior disputed (👎) inline findings by the bot, in the same directory.
const priorDisputed: ExistingComment[] = [
  { path: "src/gen/a.ts", line: 2, body: "**[high] Bug A**\n\n...", id: 101, reactions: { up: 0, down: 2, eyes: 0, confused: 0 } },
  { path: "src/gen/b.ts", line: 2, body: "**[high] Bug B**\n\n...", id: 102, reactions: { up: 0, down: 1, eyes: 0, confused: 0 } },
];

function baseDeps(over: Partial<RunDeps> = {}): RunDeps {
  const existingComments: ExistingComments = { reviewComments: [], issueComments: [] };
  return {
    fetchImpl: diffFetch,
    model: new ReplayModel(["[]"]),
    repoFiles: {},
    existingComments,
    headFiles: {},
    prIntent: undefined,
    post: async () => {},
    upsertSummary: async () => {},
    ...over,
  };
}

describe("runReview — feedback observability (#12)", () => {
  it("is off by default: no feedback captured, no GraphQL call attempted", async () => {
    const urls: string[] = [];
    const spyFetch: FetchLike = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => DIFF };
    };
    const result = await runReview(
      pr,
      "tok",
      { botIdentity: "bot" },
      baseDeps({ fetchImpl: spyFetch, existingComments: { reviewComments: priorDisputed, issueComments: [] } }),
    );
    expect(result.feedback).toBeUndefined();
    expect(urls.some((u) => u.includes("/graphql"))).toBe(false);
  });

  it("classifies prior comments and records them to the run log when on", async () => {
    const logLines: string[] = [];
    const result = await runReview(
      pr,
      "tok",
      { botIdentity: "bot", feedbackCapture: true, runLogPath: "run.log" },
      baseDeps({
        existingComments: { reviewComments: priorDisputed, issueComments: [] },
        reviewThreadResolution: new Map(), // injected → no GraphQL call
        runLogIo: { appendFile: (_p, line) => logLines.push(line) },
      }),
    );
    expect(result.feedback?.disputed).toBe(2);
    expect(result.feedback?.total).toBe(2);

    const record = JSON.parse(logLines[0]) as RunLogRecord;
    expect(record.feedback?.disputed).toBe(2);
    expect(record.feedback?.items?.map((i) => i.path)).toEqual(["src/gen/a.ts", "src/gen/b.ts"]);
  });

  it("is skipped without botIdentity (cannot tell Loupe's own comments apart)", async () => {
    const result = await runReview(
      pr,
      "tok",
      { feedbackCapture: true },
      baseDeps({
        existingComments: { reviewComments: priorDisputed, issueComments: [] },
        reviewThreadResolution: new Map(),
      }),
    );
    expect(result.feedback).toBeUndefined();
  });
});

describe("runReview — learned-rule suggestion queue (#31)", () => {
  it("writes suggestions from the run-log feedback when suggestionsPath is set", async () => {
    const logLines: string[] = [];
    let written: { path: string; content: string } | undefined;
    await runReview(
      pr,
      "tok",
      {
        botIdentity: "bot",
        feedbackCapture: true,
        runLogPath: "run.log",
        suggestionsPath: ".aireview-suggestions.md",
        suggestionMinSupport: 2,
      },
      baseDeps({
        existingComments: { reviewComments: priorDisputed, issueComments: [] },
        reviewThreadResolution: new Map(),
        runLogIo: { appendFile: (_p, line) => logLines.push(line) },
        // Feed the just-appended run-log line back as the suggestions source.
        suggestionsIo: {
          readFile: () => logLines.join(""),
          writeFile: (path, content) => (written = { path, content }),
        },
      }),
    );
    expect(written?.path).toBe(".aireview-suggestions.md");
    expect(written?.content).toContain("src/gen/**"); // 2 disputes across 2 files in the dir
    expect(written?.content).toContain("suggestions only");
  });

  it("does not generate suggestions without a run-log path", async () => {
    let wrote = false;
    await runReview(
      pr,
      "tok",
      { suggestionsPath: ".aireview-suggestions.md" }, // no runLogPath
      baseDeps({ suggestionsIo: { readFile: () => "", writeFile: () => (wrote = true) } }),
    );
    expect(wrote).toBe(false);
  });
});
