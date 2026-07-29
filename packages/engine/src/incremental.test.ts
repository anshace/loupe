import { describe, expect, it } from "vitest";
import type { FetchLike } from "./diff";
import { parseUnifiedDiff } from "./diff";
import { decideScope, dropReviewedHunks, fetchCompareDiff } from "./incremental";
import { hashHunk } from "./state";

describe("decideScope (7.2)", () => {
  const base = { before: "beforesha", headSha: "headsha", lastReviewedSha: "reviewedsha" };

  it("goes incremental when before + head + a prior review are known", () => {
    expect(decideScope(base)).toEqual({ incremental: true, base: "reviewedsha", head: "headsha" });
  });

  it("uses the LAST REVIEWED sha as base (covers gate-skipped pushes)", () => {
    const scope = decideScope({ ...base, before: "someOtherPush" });
    expect(scope).toMatchObject({ incremental: true, base: "reviewedsha" });
  });

  it("full review when no prior review is known (first review)", () => {
    expect(decideScope({ ...base, lastReviewedSha: undefined })).toMatchObject({ incremental: false });
  });

  it("full review when the event has no before SHA (opened/reopened)", () => {
    expect(decideScope({ ...base, before: undefined })).toMatchObject({ incremental: false });
  });

  it("full review on demand (/review)", () => {
    expect(decideScope({ ...base, onDemand: true })).toMatchObject({ incremental: false, reason: "on-demand review" });
  });
});

describe("fetchCompareDiff (7.2)", () => {
  it("GETs /compare/{base}...{head} with the diff media type", async () => {
    let seenUrl = "";
    let seenAccept = "";
    const fetchImpl: FetchLike = async (url, init) => {
      seenUrl = url;
      seenAccept = init?.headers?.accept ?? "";
      return { ok: true, status: 200, text: async () => "the diff" };
    };
    const diff = await fetchCompareDiff({ owner: "o", repo: "r", prNumber: 1 }, "tok", "aaa", "bbb", fetchImpl);
    expect(diff).toBe("the diff");
    expect(seenUrl).toBe("https://api.github.com/repos/o/r/compare/aaa...bbb");
    expect(seenAccept).toBe("application/vnd.github.diff");
  });

  it("throws a descriptive error on a non-OK response", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 404, text: async () => "nope" });
    await expect(
      fetchCompareDiff({ owner: "o", repo: "r", prNumber: 1 }, "tok", "aaa", "bbb", fetchImpl),
    ).rejects.toThrow(/aaa\.\.\.bbb.*404/);
  });
});

const TWO_HUNK_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,3 @@ function f() {
 context
-old
+new
 tail
@@ -30,2 +30,3 @@ function g() {
 keep
+added
 end`;

describe("dropReviewedHunks (7.2)", () => {
  it("drops only hunks whose content hash was already reviewed", () => {
    const files = parseUnifiedDiff(TWO_HUNK_DIFF);
    const firstHash = hashHunk("src/a.ts", files[0].hunks[0]);

    const result = dropReviewedHunks(files, new Set([firstHash]));
    expect(result.skippedHunks).toBe(1);
    expect(result.fullySkippedFiles).toEqual([]);
    expect(result.files).toHaveLength(1);

    const rebuilt = result.files[0];
    expect(rebuilt.hunks).toHaveLength(1);
    expect(rebuilt.hunks[0].newStart).toBe(30);
    // Commentable lines recomputed from the remaining hunk only.
    expect(rebuilt.commentableLines).toEqual([30, 31, 32]);
    // rawText rebuilt so the prompt diff no longer shows the skipped hunk.
    expect(rebuilt.rawText).toContain("@@ -30,2 +30,3 @@ function g() {");
    expect(rebuilt.rawText).toContain("+added");
    expect(rebuilt.rawText).not.toContain("+new");
  });

  it("removes files whose every hunk was reviewed, reporting them", () => {
    const files = parseUnifiedDiff(TWO_HUNK_DIFF);
    const all = new Set(files[0].hunks.map((h) => hashHunk("src/a.ts", h)));
    const result = dropReviewedHunks(files, all);
    expect(result.files).toEqual([]);
    expect(result.skippedHunks).toBe(2);
    expect(result.fullySkippedFiles).toEqual(["src/a.ts"]);
  });

  it("passes untouched and hunkless (binary) files through unchanged", () => {
    const files = parseUnifiedDiff(TWO_HUNK_DIFF);
    const untouched = dropReviewedHunks(files, new Set(["not-a-real-hash"]));
    expect(untouched.files).toEqual(files);
    expect(untouched.skippedHunks).toBe(0);

    const binary = parseUnifiedDiff(`diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ`);
    expect(dropReviewedHunks(binary, new Set()).files).toEqual(binary);
  });
});
