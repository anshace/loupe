import { describe, expect, it } from "vitest";
import type { FetchLike } from "./diff";
import { MULTI_FILE_DIFF, MODIFIED_FILE_DIFF } from "./fixtures";
import { MockProvider } from "./model";
import { buildSummary, runReview } from "./run";
import type { AuthToken, PrIdentity, ReviewPayload } from "./types";

const pr = { owner: "anshace", repo: "demo", prNumber: 5 };

/** fetch stub that serves the given diff for the PR GET. */
function diffFetch(diff: string): FetchLike {
  return async () => ({ ok: true, status: 200, text: async () => diff });
}

function capturePosts(): {
  posts: ReviewPayload[];
  post: (pr: PrIdentity, auth: AuthToken, payload: ReviewPayload) => Promise<void>;
} {
  const posts: ReviewPayload[] = [];
  return {
    posts,
    post: async (_pr, _auth, payload) => {
      posts.push(payload);
    },
  };
}

describe("runReview", () => {
  it("runs the full pipeline and posts exactly one batched review", async () => {
    const model = new MockProvider(
      JSON.stringify([
        {
          severity: "high",
          category: "bug",
          file: "src/app.ts",
          line: 4,
          title: "Wrong operator",
          body: "Uses - instead of +.",
        },
      ]),
      { inputTokens: 100, outputTokens: 20 },
    );
    const { posts, post } = capturePosts();

    const result = await runReview(pr, "tok", {}, { fetchImpl: diffFetch(MULTI_FILE_DIFF), model, post });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].line).toBe(4);
    expect(result.degraded).toBe(false);
    expect(result.posted).toBe(true);
    expect(result.usage).toEqual({ model: "mock", inputTokens: 100, outputTokens: 20 });

    // Exactly one review, batched.
    expect(posts).toHaveLength(1);
    expect(posts[0].event).toBe("COMMENT");
    expect(posts[0].comments).toEqual([
      expect.objectContaining({ path: "src/app.ts", line: 4, side: "RIGHT" }),
    ]);

    // Noise files were filtered and disclosed (binary + lockfile from the fixture).
    expect(result.skippedFiles).toEqual([
      { file: "logo.png", reason: "binary" },
      { file: "package-lock.json", reason: "lockfile" },
    ]);
    expect(result.summary).toContain("logo.png");
    expect(result.summary).toContain("package-lock.json");

    // The model saw only kept files and their commentable lines.
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].user).toContain("src/app.ts");
    expect(model.requests[0].user).not.toContain("package-lock.json");
    expect(model.requests[0].user).toContain("- src/app.ts: 1-7");
    expect(model.requests[0].system).toContain("Severity rubric");
  });

  it("posts a clean-PR review with the ✅ summary and zero comments", async () => {
    const { posts, post } = capturePosts();
    const result = await runReview(
      pr,
      "tok",
      {},
      { fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model: new MockProvider("[]"), post },
    );
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain("✅ no issues found");
    expect(posts).toHaveLength(1);
    expect(posts[0].comments).toEqual([]);
    expect(posts[0].body).toContain("✅ no issues found");
  });

  it("degrades to a summary-only review on unparseable model output — never crashes", async () => {
    const { posts, post } = capturePosts();
    const result = await runReview(
      pr,
      "tok",
      {},
      { fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model: new MockProvider("Sorry, I had a moment."), post },
    );
    expect(result.degraded).toBe(true);
    expect(result.findings).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain("could not be parsed");
    expect(posts[0].comments).toEqual([]);
  });

  it("clamps out-of-diff lines and moves unclampable findings to the summary", async () => {
    const model = new MockProvider(
      JSON.stringify([
        { severity: "high", category: "bug", file: "src/app.ts", line: 9, title: "Near", body: "b" },
        { severity: "low", category: "other", file: "not-in-diff.ts", line: 1, title: "Far", body: "b" },
      ]),
    );
    const { posts, post } = capturePosts();
    const result = await runReview(pr, "tok", {}, { fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model, post });

    expect(result.findings.map((f) => f.line)).toEqual([7, undefined]); // 9 → nearest commentable 7
    expect(posts[0].comments).toHaveLength(1);
    expect(posts[0].comments[0].line).toBe(7);
    // The file-level finding is disclosed in the summary, not dropped.
    expect(posts[0].body).toContain("not-in-diff.ts");
  });

  it("applies size caps and disclosure without calling the model when nothing is reviewable", async () => {
    const model = new MockProvider("[]");
    const { posts, post } = capturePosts();
    const result = await runReview(
      pr,
      "tok",
      { sizeCap: { maxFileChars: 10 } },
      { fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model, post },
    );
    expect(model.requests).toHaveLength(0);
    expect(result.exclusions).toHaveLength(1);
    expect(result.exclusions[0].file).toBe("src/app.ts");
    expect(result.usage).toBeUndefined();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain("Not reviewed");
    expect(posts[0].body).toContain("src/app.ts");
  });

  it("filters findings below minSeverity", async () => {
    const model = new MockProvider(
      JSON.stringify([
        { severity: "nit", category: "other", file: "src/app.ts", line: 3, title: "meh", body: "b" },
        { severity: "high", category: "bug", file: "src/app.ts", line: 4, title: "real", body: "b" },
      ]),
    );
    const { posts, post } = capturePosts();
    const result = await runReview(
      pr,
      "tok",
      { minSeverity: "medium" },
      { fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model, post },
    );
    expect(result.findings.map((f) => f.title)).toEqual(["real"]);
    expect(posts[0].comments).toHaveLength(1);
  });

  it("dryRun builds the payload but never posts", async () => {
    const { posts, post } = capturePosts();
    const result = await runReview(
      pr,
      "tok",
      { dryRun: true },
      { fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model: new MockProvider("[]"), post },
    );
    expect(result.posted).toBe(false);
    expect(result.payload.body).toContain("✅ no issues found");
    expect(posts).toHaveLength(0);
  });
});

describe("buildSummary", () => {
  const base = { findings: [], skippedFiles: [], exclusions: [], degraded: false, nothingReviewable: false };

  it("says no issues found for a clean run", () => {
    expect(buildSummary(base)).toBe("✅ no issues found");
  });

  it("counts findings and inline anchors", () => {
    const summary = buildSummary({
      ...base,
      findings: [
        { severity: "high", category: "bug", file: "a.ts", line: 1, title: "t", body: "b" },
        { severity: "low", category: "other", file: "b.ts", title: "t2", body: "b2" },
      ],
    });
    expect(summary).toContain("2 issue(s) (1 inline)");
    expect(summary).toContain("File-level findings");
    expect(summary).toContain("`b.ts`");
  });

  it("always discloses skips and truncation", () => {
    const summary = buildSummary({
      ...base,
      skippedFiles: [{ file: "yarn.lock", reason: "lockfile" }],
      exclusions: [{ file: "huge.ts", whatWasExcluded: "entire file diff dropped" }],
    });
    expect(summary).toContain("Skipped 1 noise file(s)");
    expect(summary).toContain("`yarn.lock` (lockfile)");
    expect(summary).toContain("Not reviewed");
    expect(summary).toContain("entire file diff dropped");
  });
});
