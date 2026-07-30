import { describe, expect, it } from "vitest";
import {
  caseSuccess,
  comparePaired,
  diffSnapshots,
  mcnemar,
  shadowCompare,
  shadowSummary,
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

describe("shadowCompare (shadow-mode dual-run)", () => {
  it("classifies each case's verdict from the shadow−primary deltas", () => {
    const primary = [
      { name: "same", expectedFound: 1, expectedMissed: 0, unexpected: 0 },
      { name: "more", expectedFound: 1, expectedMissed: 0, unexpected: 0 },
      { name: "fewer", expectedFound: 1, expectedMissed: 0, unexpected: 1 },
      { name: "traded", expectedFound: 1, expectedMissed: 0, unexpected: 0 },
    ];
    const shadow = [
      { name: "same", expectedFound: 1, expectedMissed: 0, unexpected: 0 }, // agree
      { name: "more", expectedFound: 1, expectedMissed: 0, unexpected: 1 }, // posts one extra (FP)
      { name: "fewer", expectedFound: 1, expectedMissed: 0, unexpected: 0 }, // one fewer FP
      { name: "traded", expectedFound: 0, expectedMissed: 1, unexpected: 1 }, // same count, worse mix
    ];
    const cases = shadowCompare(primary, shadow);
    const by = Object.fromEntries(cases.map((c) => [c.name, c]));
    expect(by.same.verdict).toBe("agree");
    expect(by.same.differs).toBe(false);
    expect(by.more.verdict).toBe("shadow-more");
    expect(by.more.unexpectedDelta).toBe(1);
    expect(by.fewer.verdict).toBe("shadow-fewer");
    expect(by.fewer.unexpectedDelta).toBe(-1);
    expect(by.traded.verdict).toBe("shadow-different");
    expect(by.traded.foundDelta).toBe(-1);
  });

  it("sorts by name and tolerates a case present on only one side", () => {
    const cases = shadowCompare(
      [{ name: "b", expectedFound: 1, expectedMissed: 0, unexpected: 0 }],
      [{ name: "a", expectedFound: 0, expectedMissed: 0, unexpected: 2 }],
    );
    expect(cases.map((c) => c.name)).toEqual(["a", "b"]);
    const a = cases.find((c) => c.name === "a");
    const b = cases.find((c) => c.name === "b");
    expect(a.unexpectedDelta).toBe(2); // present only in shadow
    expect(b.foundDelta).toBe(-1); // present only in primary
  });

  it("shadowSummary rolls up the promotion-decision totals", () => {
    const cases = shadowCompare(
      [
        { name: "x", expectedFound: 0, expectedMissed: 1, unexpected: 0 },
        { name: "y", expectedFound: 1, expectedMissed: 0, unexpected: 2 },
      ],
      [
        { name: "x", expectedFound: 1, expectedMissed: 0, unexpected: 0 }, // newly caught
        { name: "y", expectedFound: 1, expectedMissed: 0, unexpected: 0 }, // 2 fewer FPs
      ],
    );
    const sum = shadowSummary(cases);
    expect(sum).toMatchObject({ total: 2, changed: 2, newlyCaught: 1, newlyMissed: 0, newFPs: 0, fewerFPs: 2 });
  });

  it("reports zero changes when shadow matches primary on every case", () => {
    const rows = [{ name: "x", expectedFound: 1, expectedMissed: 0, unexpected: 0 }];
    const sum = shadowSummary(shadowCompare(rows, rows));
    expect(sum.changed).toBe(0);
  });
});
