import { describe, expect, it } from "vitest";
import { buildStatsComment, runReview, parseUnifiedDiff, parseModelFindings } from "./index";

describe("buildStatsComment", () => {
  it("formats the M0 stats comment", () => {
    expect(buildStatsComment({ fileCount: 3, additions: 42, deletions: 7 })).toBe(
      "👋 review bot was here — 3 files, +42/−7",
    );
  });

  it("handles a zero-change PR", () => {
    expect(buildStatsComment({ fileCount: 0, additions: 0, deletions: 0 })).toBe(
      "👋 review bot was here — 0 files, +0/−0",
    );
  });
});

describe("engine public surface", () => {
  it("exports the M1 pipeline pieces", () => {
    expect(typeof runReview).toBe("function");
    expect(typeof parseUnifiedDiff).toBe("function");
    expect(typeof parseModelFindings).toBe("function");
  });
});
