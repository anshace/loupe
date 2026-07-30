/**
 * Integration test for Batch-4 actionability feature #18 (multi-line committable
 * suggestion ranges) wired through the full pipeline: a reviewer finding that
 * carries `startLine` + a multi-line `suggestedRange` over a contiguous block of
 * commentable lines must post an inline comment anchored with start_line/
 * start_side and a range ```suggestion; when the range isn't a clean contiguous
 * swap the pipeline falls back to the single-line suggestion / prose.
 */
import { describe, expect, it } from "vitest";
import type { RepoReader } from "./agentic";
import type { ExistingComments } from "./dedupe";
import type { FetchLike } from "./diff";
import { MockProvider } from "./model";
import { runReview } from "./run";
import type { RunDeps } from "./run";
import type { AuthToken, EngineConfig, PrIdentity, ReviewPayload } from "./types";

const pr = { owner: "anshace", repo: "demo", prNumber: 18 };
const NO_COMMENTS: ExistingComments = { reviewComments: [], issueComments: [] };

function diffFetch(diff: string): FetchLike {
  return async () => ({ ok: true, status: 200, text: async () => diff });
}

function newFileDiff(path: string, lines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..2222222 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    lines.map((l) => `+${l}`).join("\n"),
  ].join("\n");
}

function capture(): { posts: ReviewPayload[]; deps: RunDeps } {
  const posts: ReviewPayload[] = [];
  return {
    posts,
    deps: {
      post: async (_pr: PrIdentity, _auth: AuthToken, payload: ReviewPayload) => {
        posts.push(payload);
      },
      upsertSummary: async () => {},
      repoFiles: {},
      existingComments: NO_COMMENTS,
      headFiles: {},
    },
  };
}

const base: EngineConfig = { event: { headSha: "abc123" }, minSeverity: "low", escalation: false };

// A 5-line new file → commentable lines 1..5 (all added, all exact).
const FILE_LINES = [
  "export function guard(ok: boolean) {",
  "  if (ok) {",
  "    return early;",
  "  }",
  "}",
];
const DIFF = newFileDiff("src/guard.ts", FILE_LINES);

describe("runReview — multi-line committable suggestion range (#18)", () => {
  it("posts a range comment with start_line/start_side + a range ```suggestion", async () => {
    const model = new MockProvider(
      JSON.stringify([
        {
          severity: "high",
          category: "bug",
          file: "src/guard.ts",
          line: 4, // END of the range
          startLine: 2, // START of the range
          title: "Inverted guard",
          body: "The guard returns on the success path; lines 2-4 must be inverted.",
          suggestedRange: "  if (!ok) {\n    return early;\n  }",
        },
      ]),
    );
    const { posts, deps } = capture();
    await runReview(pr, "tok", base, { ...deps, fetchImpl: diffFetch(DIFF), model });

    expect(posts).toHaveLength(1);
    expect(posts[0].comments).toHaveLength(1);
    const c = posts[0].comments[0];
    expect(c).toMatchObject({ path: "src/guard.ts", startLine: 2, startSide: "RIGHT", line: 4, side: "RIGHT" });
    expect(c.body).toContain("```suggestion\n  if (!ok) {\n    return early;\n  }\n```");
  });

  it("falls back to a single-line suggestion when no startLine/range is emitted", async () => {
    const model = new MockProvider(
      JSON.stringify([
        {
          severity: "high",
          category: "bug",
          file: "src/guard.ts",
          line: 2,
          title: "Wrong condition",
          body: "Should guard the failure path.",
          suggestedLine: "  if (!ok) {",
        },
      ]),
    );
    const { posts, deps } = capture();
    await runReview(pr, "tok", base, { ...deps, fetchImpl: diffFetch(DIFF), model });

    const c = posts[0].comments[0];
    expect(c.startLine).toBeUndefined(); // no range
    expect(c.line).toBe(2);
    expect(c.body).toContain("```suggestion\n  if (!ok) {\n```");
  });
});

describe("runReview — repo-map priming + ctags-lite symbol index (rounding-out items)", () => {
  const treeFiles: Record<string, string> = {
    "src/guard.ts": FILE_LINES.join("\n"),
    "src/other.ts": "export function other() {}",
    "docs/readme.md": "# docs",
  };
  const repoReader: RepoReader = {
    listTree: async () => Object.keys(treeFiles),
    readFile: async (p) => treeFiles[p],
  };

  it("fills {{REPO_MAP}} and {{SYMBOL_INDEX}} in the reviewer prompt when both flags are on", async () => {
    const model = new MockProvider("[]");
    const { deps } = capture();
    await runReview(
      pr,
      "tok",
      { ...base, repoMap: true, ctagsIndex: true },
      {
        ...deps,
        fetchImpl: diffFetch(DIFF),
        model,
        repoReader,
        headFiles: { "src/guard.ts": FILE_LINES.join("\n") },
        // let it load the real reviewer-v13 from prompts/ (no promptTemplate override)
        promptTemplate: undefined,
      },
    );
    const user = model.requests[0].user;
    // repo map: top-level structure + exported symbols from the changed file
    expect(user).toContain("Top-level structure:");
    expect(user).toContain("- src/ (2 file(s))");
    expect(user).toContain("- src/guard.ts: guard");
    // ctags-lite: the touched symbol's declaration location
    expect(user).toContain("`guard` — defined at src/guard.ts:1 (function)");
  });

  it("stays on the v9 default (no repo-map block) when the flags are off", async () => {
    const model = new MockProvider("[]");
    const { deps } = capture();
    await runReview(pr, "tok", base, {
      ...deps,
      fetchImpl: diffFetch(DIFF),
      model,
      repoReader,
      headFiles: { "src/guard.ts": FILE_LINES.join("\n") },
      promptTemplate: undefined,
    });
    expect(model.requests[0].user).not.toContain("Top-level structure:");
  });
});
