import { describe, expect, it } from "vitest";
import { clampFinding, clampFindings } from "./clamp";
import type { Finding } from "./types";

function finding(file: string, line?: number): Finding {
  return { severity: "high", category: "bug", file, line, title: "t", body: "b" };
}

const commentable = { "a.ts": [10, 11, 12, 40], "empty.ts": [] as number[] };

describe("clampFinding", () => {
  it("keeps a finding already on a commentable line", () => {
    expect(clampFinding(finding("a.ts", 11), commentable).line).toBe(11);
  });

  it("clamps to the nearest commentable line within 50", () => {
    expect(clampFinding(finding("a.ts", 14), commentable).line).toBe(12);
    expect(clampFinding(finding("a.ts", 30), commentable).line).toBe(40);
    expect(clampFinding(finding("a.ts", 90), commentable).line).toBe(40);
  });

  it("reclassifies to file-level when the nearest line is more than 50 away", () => {
    expect(clampFinding(finding("a.ts", 500), commentable).line).toBeUndefined();
  });

  it("reclassifies to file-level for files with no commentable lines", () => {
    expect(clampFinding(finding("empty.ts", 3), commentable).line).toBeUndefined();
  });

  it("reclassifies to file-level for files not in the diff", () => {
    expect(clampFinding(finding("unknown.ts", 3), commentable).line).toBeUndefined();
  });

  it("leaves file-level findings untouched", () => {
    const f = finding("a.ts", undefined);
    expect(clampFinding(f, commentable)).toBe(f);
  });

  it("respects a custom max distance", () => {
    expect(clampFinding(finding("a.ts", 14), commentable, 1).line).toBeUndefined();
  });

  it("does not mutate the input finding", () => {
    const f = finding("a.ts", 14);
    clampFinding(f, commentable);
    expect(f.line).toBe(14);
  });
});

describe("clampFindings", () => {
  it("clamps a whole list without dropping anything", () => {
    const out = clampFindings(
      [finding("a.ts", 10), finding("a.ts", 999), finding("unknown.ts", 1)],
      commentable,
    );
    expect(out).toHaveLength(3);
    expect(out.map((f) => f.line)).toEqual([10, undefined, undefined]);
  });
});
