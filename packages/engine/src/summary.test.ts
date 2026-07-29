import { describe, expect, it } from "vitest";
import type { FetchLike } from "./diff";
import type { SummaryCommentParts } from "./summary";
import {
  SUMMARY_MARKER,
  composeSummaryComment,
  findSummaryComment,
  renderStateMarker,
  upsertSummaryComment,
} from "./summary";
import type { Finding } from "./types";

const baseParts: SummaryCommentParts = {
  headSha: "abc123",
  findingsPublished: 0,
  degraded: false,
  nothingReviewable: false,
  summaryFindings: [],
  stillOpen: [],
  suppressed: [],
  skippedFiles: [],
  exclusions: [],
  notices: [],
  earlyStop: false,
};

describe("composeSummaryComment", () => {
  it("always embeds the hidden marker and machine-readable state", () => {
    const body = composeSummaryComment(baseParts);
    expect(body).toContain(SUMMARY_MARKER);
    expect(body).toContain('<!-- ai-review-bot:state {"sha":"abc123"} -->');
    expect(body).toContain("✅ no issues found");
  });

  it("carries notices, suppression counts, skips, truncation, and early stop", () => {
    const body = composeSummaryComment({
      ...baseParts,
      findingsPublished: 2,
      notices: ["invalid .aireview.toml — running on safe defaults (bad line)"],
      suppressed: [
        { finding: { severity: "nit", category: "style", file: "a.ts", title: "t", body: "b" }, reason: "style-nit" },
        { finding: { severity: "low", category: "bug", file: "a.ts", title: "t2", body: "b" }, reason: "below-min-severity" },
      ],
      skippedFiles: [
        { file: "yarn.lock", reason: "lockfile" },
        { file: "gen/x.ts", reason: "ignored" },
      ],
      exclusions: [{ file: "huge.ts", whatWasExcluded: "entire file diff dropped" }],
      earlyStop: true,
    });
    expect(body).toContain("⚠️ invalid .aireview.toml");
    expect(body).toContain("Suppressed 2 finding(s)");
    expect(body).toContain("1 style-nit");
    expect(body).toContain("Skipped 2 file(s)");
    expect(body).toContain("`gen/x.ts` (ignored)");
    expect(body).toContain("Not reviewed");
    expect(body).toContain("stopped early");
    expect(body).toContain("Found 2 new issue(s)");
  });

  it("lists summary-only findings and still-open carried findings", () => {
    const body = composeSummaryComment({
      ...baseParts,
      findingsPublished: 1,
      summaryFindings: [
        { severity: "high", category: "bug", file: "not-in-diff.ts", line: 3, title: "Orphan", body: "b" },
      ],
      stillOpen: [{ severity: "medium", category: "bug", file: "a.ts", line: 5, title: "Old one", body: "b" }],
    });
    expect(body).toContain("could not be attached");
    expect(body).toContain("`not-in-diff.ts`:3 — **[high]** Orphan");
    expect(body).toContain("Still open from previous runs");
    expect(body).toContain("Old one");
  });

  it("discloses degraded mode", () => {
    expect(composeSummaryComment({ ...baseParts, degraded: true })).toContain("could not be parsed");
  });
});

describe("composeSummaryComment — summary polish bundle (feature #9)", () => {
  const crit: Finding = { severity: "critical", category: "security", file: "src/auth.ts", line: 12, title: "Auth bypass", body: "b" };
  const med: Finding = { severity: "medium", category: "bug", file: "src/util.ts", line: 3, title: "Edge case", body: "b" };
  const low: Finding = { severity: "low", category: "style", file: "src/x.ts", line: 8, title: "Minor", body: "b" };

  it("renders a severity-first findings table (#9a/#9d)", () => {
    const body = composeSummaryComment({
      ...baseParts,
      findingsPublished: 3,
      publishedFindings: [low, crit, med], // deliberately out of order
    });
    expect(body).toContain("| Severity | Location | Category | Finding |");
    // critical row appears before medium, which appears before low.
    const iCrit = body.indexOf("Auth bypass");
    const iMed = body.indexOf("Edge case");
    const iLow = body.indexOf("Minor");
    expect(iCrit).toBeGreaterThan(-1);
    expect(iCrit).toBeLessThan(iMed);
    expect(iMed).toBeLessThan(iLow);
    expect(body).toContain("🔴 critical");
  });

  it("collapses a long table behind a <details> block", () => {
    const many: Finding[] = Array.from({ length: 12 }, (_, i) => ({ ...med, line: i + 1, title: `Issue ${i}` }));
    const body = composeSummaryComment({ ...baseParts, findingsPublished: 12, publishedFindings: many });
    expect(body).toContain("<details>");
    expect(body).toContain("12 findings");
  });

  it("emits a deterministic risk verdict + review-effort line (#9b)", () => {
    const body = composeSummaryComment({
      ...baseParts,
      findingsPublished: 1,
      publishedFindings: [crit],
      risk: { riskyPaths: ["src/auth/login.ts"], filesChanged: 3, linesChanged: 120 },
    });
    expect(body).toContain("**Risk:** 🔴 high");
    expect(body).toContain("touches sensitive paths (login.ts)");
    expect(body).toContain("1 critical finding(s)");
    expect(body).toContain("**Est. review effort:** 3/5");
  });

  it("reports low risk with no risky paths and no critical/high findings", () => {
    const body = composeSummaryComment({
      ...baseParts,
      findingsPublished: 1,
      publishedFindings: [low],
      risk: { riskyPaths: [], filesChanged: 1, linesChanged: 5 },
    });
    expect(body).toContain("**Risk:** 🟢 low");
    expect(body).toContain("**Est. review effort:** 1/5");
  });

  it("suppresses the risk line in degraded / nothing-reviewable runs", () => {
    const risk = { riskyPaths: [], filesChanged: 0, linesChanged: 0 };
    expect(composeSummaryComment({ ...baseParts, degraded: true, risk })).not.toContain("**Risk:**");
    expect(composeSummaryComment({ ...baseParts, nothingReviewable: true, risk })).not.toContain("**Risk:**");
  });

  it("turns locations into clickable blob permalinks when owner/repo/sha are known (#9c)", () => {
    const body = composeSummaryComment({
      ...baseParts,
      owner: "anshace",
      repo: "demo",
      headSha: "abc123",
      findingsPublished: 1,
      publishedFindings: [crit],
      summaryFindings: [{ severity: "high", category: "bug", file: "orphan.ts", line: 3, title: "Orphan", body: "b" }],
    });
    expect(body).toContain("https://github.com/anshace/demo/blob/abc123/src/auth.ts#L12");
    expect(body).toContain("https://github.com/anshace/demo/blob/abc123/orphan.ts#L3");
  });

  it("falls back to plain locations when identity is absent", () => {
    const body = composeSummaryComment({ ...baseParts, findingsPublished: 1, publishedFindings: [crit] });
    expect(body).not.toContain("https://github.com");
    expect(body).toContain("`src/auth.ts`:12");
  });
});

describe("findSummaryComment", () => {
  it("finds the marker comment and parses its state", () => {
    const found = findSummaryComment([
      { id: 1, body: "unrelated" },
      { id: 2, body: `${SUMMARY_MARKER}\n\nhello\n\n${renderStateMarker({ sha: "deadbeef" })}` },
    ]);
    expect(found).toEqual({ commentId: 2, state: { sha: "deadbeef" } });
  });

  it("returns undefined when absent, and tolerates corrupt state", () => {
    expect(findSummaryComment([{ id: 1, body: "nope" }])).toBeUndefined();
    const corrupt = findSummaryComment([{ id: 3, body: `${SUMMARY_MARKER} <!-- ai-review-bot:state {oops} -->` }]);
    expect(corrupt).toEqual({ commentId: 3, state: {} });
  });
});

describe("upsertSummaryComment", () => {
  const pr = { owner: "anshace", repo: "demo", prNumber: 9 };

  it("POSTs a new comment when none exists", async () => {
    const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
    const fake: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 201, text: async () => "{}" };
    };
    await upsertSummaryComment(pr, "tok", "body", undefined, fake);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/anshace/demo/issues/9/comments");
    expect(calls[0].init?.method).toBe("POST");
  });

  it("PATCHes the existing marker comment in place", async () => {
    const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
    const fake: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => "{}" };
    };
    await upsertSummaryComment(pr, "tok", "new body", 42, fake);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/anshace/demo/issues/comments/42");
    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init?.body ?? "")).toEqual({ body: "new body" });
  });

  it("throws with status and body snippet on failure", async () => {
    const fake: FetchLike = async () => ({ ok: false, status: 403, text: async () => "Forbidden" });
    await expect(upsertSummaryComment(pr, "tok", "b", undefined, fake)).rejects.toThrow(/HTTP 403 Forbidden/);
  });
});
