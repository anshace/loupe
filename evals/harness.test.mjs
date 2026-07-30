import { describe, expect, it } from "vitest";
import {
  caseSuccess,
  comparePaired,
  diffSnapshots,
  mcnemar,
  snapshotCase,
  snapshotClean,
  snapshotFinding,
} from "./harness.mjs";

describe("caseSuccess (#24)", () => {
  it("is true only when every expected finding was caught and no clean case violated", () => {
    expect(caseSuccess({ expectedMissed: 0, cleanViolated: false })).toBe(true);
    expect(caseSuccess({ expectedMissed: 1, cleanViolated: false })).toBe(false);
    expect(caseSuccess({ expectedMissed: 0, cleanViolated: true })).toBe(false);
    expect(caseSuccess(undefined)).toBe(false);
  });
});

describe("comparePaired (#24)", () => {
  it("computes B−A deltas and regressed/improved flags, sorted by name", () => {
    const A = [
      { name: "b-case", expectedFound: 1, expectedMissed: 0, unexpected: 0, cleanViolated: false }, // passes
      { name: "a-case", expectedFound: 0, expectedMissed: 1, unexpected: 0, cleanViolated: false }, // fails
    ];
    const B = [
      { name: "b-case", expectedFound: 0, expectedMissed: 1, unexpected: 1, cleanViolated: false }, // now fails
      { name: "a-case", expectedFound: 1, expectedMissed: 0, unexpected: 0, cleanViolated: false }, // now passes
    ];
    const pairs = comparePaired(A, B);
    expect(pairs.map((p) => p.name)).toEqual(["a-case", "b-case"]); // sorted
    const a = pairs.find((p) => p.name === "a-case");
    const b = pairs.find((p) => p.name === "b-case");
    expect(a.improved).toBe(true);
    expect(a.foundDelta).toBe(1);
    expect(b.regressed).toBe(true);
    expect(b.unexpectedDelta).toBe(1);
  });

  it("handles a case present in only one side", () => {
    const pairs = comparePaired([{ name: "x", expectedFound: 1, expectedMissed: 0 }], []);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].successB).toBe(false);
    expect(pairs[0].foundDelta).toBe(-1);
  });
});

describe("mcnemar (#24)", () => {
  it("flags a large discordant imbalance as significant", () => {
    const pairs = [];
    for (let i = 0; i < 12; i++) pairs.push({ successA: false, successB: true }); // B-only wins
    const mc = mcnemar(pairs);
    expect(mc.aOnly).toBe(0);
    expect(mc.bOnly).toBe(12);
    expect(mc.significant).toBe(true);
    expect(mc.underpowered).toBe(false);
  });

  it("marks a tiny discordant total as underpowered and not significant", () => {
    const mc = mcnemar([{ successA: true, successB: false }, { successA: true, successB: true }]);
    expect(mc.aOnly).toBe(1);
    expect(mc.bOnly).toBe(0);
    expect(mc.significant).toBe(false);
    expect(mc.underpowered).toBe(true);
  });

  it("is all-zero when A and B agree on every case", () => {
    const mc = mcnemar([{ successA: true, successB: true }, { successA: false, successB: false }]);
    expect(mc).toMatchObject({ aOnly: 0, bOnly: 0, discordant: 0, statistic: 0, significant: false });
  });
});

describe("snapshot golden diff (#24)", () => {
  const row = {
    name: "off-by-one",
    findings: [
      { severity: "high", category: "bug", file: "a.ts", line: 3, title: "Off-by-one", body: "…", suggestedLine: "x" },
    ],
  };

  it("snapshotFinding keeps stable identity fields + a hasSuggestion flag", () => {
    expect(snapshotFinding(row.findings[0])).toEqual({
      severity: "high",
      category: "bug",
      file: "a.ts",
      line: 3,
      title: "Off-by-one",
      hasSuggestion: true,
    });
  });

  it("snapshotCase captures name + normalized findings", () => {
    const snap = snapshotCase(row);
    expect(snap.name).toBe("off-by-one");
    expect(snap.findings).toHaveLength(1);
  });

  it("diffSnapshots detects changed / added / removed cases", () => {
    const committed = {
      a: snapshotCase({ name: "a", findings: [{ severity: "high", category: "bug", file: "a.ts", line: 1, title: "T" }] }),
      gone: snapshotCase({ name: "gone", findings: [] }),
    };
    const current = {
      a: snapshotCase({ name: "a", findings: [{ severity: "low", category: "bug", file: "a.ts", line: 1, title: "T" }] }), // severity changed
      fresh: snapshotCase({ name: "fresh", findings: [] }),
    };
    const diff = diffSnapshots(committed, current);
    expect(diff.changed.map((c) => c.name)).toEqual(["a"]);
    expect(diff.added).toEqual(["fresh"]);
    expect(diff.removed).toEqual(["gone"]);
    expect(snapshotClean(diff)).toBe(false);
  });

  it("snapshotClean is true when nothing drifted", () => {
    const snap = { x: snapshotCase({ name: "x", findings: [] }) };
    expect(snapshotClean(diffSnapshots(snap, snap))).toBe(true);
  });
});
