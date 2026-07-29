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

import { anchorFinding, anchorFindings } from "./clamp";

describe("anchorFinding — fallback chain (no finding lost)", () => {
  const commentable = { "src/app.ts": [3, 4, 6, 7], "gone.txt": [] as number[] };
  const base = { severity: "high" as const, category: "bug", file: "src/app.ts", title: "t", body: "b" };

  it("exact commentable line → inline at that line", () => {
    expect(anchorFinding({ ...base, line: 4 }, commentable)).toEqual({
      finding: { ...base, line: 4 },
      placement: "line",
    });
  });

  it("near miss → nearest commentable line within 50", () => {
    const anchored = anchorFinding({ ...base, line: 9 }, commentable);
    expect(anchored.placement).toBe("nearest");
    expect(anchored.finding.line).toBe(7);
  });

  it("too far → file-level", () => {
    const anchored = anchorFinding({ ...base, line: 500 }, commentable);
    expect(anchored.placement).toBe("file");
    expect(anchored.finding.line).toBeUndefined();
  });

  it("file in the diff but with no commentable lines → file-level", () => {
    const anchored = anchorFinding({ ...base, file: "gone.txt", line: 2 }, commentable);
    expect(anchored.placement).toBe("file");
  });

  it("no line at all on a diffed file → file-level", () => {
    expect(anchorFinding({ ...base }, commentable).placement).toBe("file");
  });

  it("file not in the diff view → summary mention, never dropped", () => {
    const anchored = anchorFinding({ ...base, file: "not-in-diff.ts", line: 1 }, commentable);
    expect(anchored.placement).toBe("summary");
    expect(anchored.finding.file).toBe("not-in-diff.ts");
  });

  it("anchorFindings assigns a placement to every input", () => {
    const findings = [
      { ...base, line: 4 },
      { ...base, line: 500 },
      { ...base, file: "mystery.ts", line: 1 },
    ];
    const anchored = anchorFindings(findings, commentable);
    expect(anchored).toHaveLength(findings.length);
    expect(anchored.every((a) => ["line", "nearest", "file", "summary"].includes(a.placement))).toBe(true);
  });
});
