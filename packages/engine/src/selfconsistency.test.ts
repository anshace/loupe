import { describe, expect, it } from "vitest";
import type { Finding, Severity } from "./types";
import { findingsMatch, isHighStakes, reconcileSelfConsistency } from "./selfconsistency";

const f = (over: Partial<Finding> = {}): Finding => ({
  severity: "high",
  category: "bug",
  file: "src/a.ts",
  line: 10,
  title: "Off-by-one in loop",
  body: "loop runs one past the end",
  ...over,
});

describe("isHighStakes", () => {
  it("is true only for critical and high", () => {
    const table: Array<[Severity, boolean]> = [
      ["critical", true],
      ["high", true],
      ["medium", false],
      ["low", false],
      ["nit", false],
    ];
    for (const [sev, expected] of table) expect(isHighStakes(sev)).toBe(expected);
  });
});

describe("findingsMatch", () => {
  it("matches same file+category within the line window", () => {
    expect(findingsMatch(f({ line: 10 }), f({ line: 12 }))).toBe(true);
    expect(findingsMatch(f({ line: 10 }), f({ line: 20 }))).toBe(false);
  });

  it("does not match across files or categories", () => {
    expect(findingsMatch(f(), f({ file: "src/b.ts" }))).toBe(false);
    expect(findingsMatch(f(), f({ category: "security" }))).toBe(false);
  });

  it("requires title agreement when one side is file-level", () => {
    expect(findingsMatch(f({ line: undefined }), f({ line: 10, title: "Off-by-one in loop" }))).toBe(true);
    expect(findingsMatch(f({ line: undefined }), f({ line: 10, title: "Totally different" }))).toBe(false);
  });

  it("matches two file-level findings of the same file+category", () => {
    expect(findingsMatch(f({ line: undefined }), f({ line: undefined }))).toBe(true);
  });
});

describe("reconcileSelfConsistency", () => {
  it("keeps a high-stakes finding reproduced by a majority of samples", () => {
    const original = [f({ severity: "critical" })];
    const samples = [[f({ severity: "critical", line: 11 })], [f({ severity: "high", line: 9 })]];
    const out = reconcileSelfConsistency(original, samples);
    expect(out.demoted).toHaveLength(0);
    expect(out.findings[0].severity).toBe("critical");
  });

  it("demotes (never drops) a high-stakes finding no sample reproduces", () => {
    const original = [f({ severity: "critical" })];
    const samples = [[f({ file: "src/other.ts" })], [f({ category: "security" })]];
    const out = reconcileSelfConsistency(original, samples);
    expect(out.findings).toHaveLength(1); // never dropped
    expect(out.findings[0].severity).toBe("high"); // critical → high
    expect(out.demoted).toEqual([
      expect.objectContaining({ from: "critical", to: "high" }),
    ]);
  });

  it("demotes high → medium and needs a strict majority", () => {
    // one sample reproduces, one does not → 2 of 3 votes → kept
    const kept = reconcileSelfConsistency(
      [f({ severity: "high" })],
      [[f({ line: 10 })], [f({ file: "src/z.ts" })]],
    );
    expect(kept.findings[0].severity).toBe("high");

    // neither reproduces → 1 of 3 votes → demoted to medium
    const demoted = reconcileSelfConsistency(
      [f({ severity: "high" })],
      [[f({ file: "src/z.ts" })], [f({ file: "src/y.ts" })]],
    );
    expect(demoted.findings[0].severity).toBe("medium");
  });

  it("leaves medium / low / nit findings untouched", () => {
    const original = [f({ severity: "medium" }), f({ severity: "low" }), f({ severity: "nit" })];
    const out = reconcileSelfConsistency(original, [[], []]);
    expect(out.demoted).toHaveLength(0);
    expect(out.findings.map((x) => x.severity)).toEqual(["medium", "low", "nit"]);
  });

  it("changes nothing when there are no samples", () => {
    const original = [f({ severity: "critical" })];
    const out = reconcileSelfConsistency(original, []);
    expect(out.findings).toEqual(original);
    expect(out.demoted).toHaveLength(0);
  });
});
