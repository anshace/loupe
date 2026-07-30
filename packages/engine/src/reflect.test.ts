import { describe, expect, it } from "vitest";
import {
  applyReflection,
  collectReflectionCandidates,
  demoteSeverity,
  formatReflectionCandidates,
  parseReflectionOutput,
} from "./reflect";
import type { Finding } from "./types";
import type { VerifierDecision } from "./verify";

function finding(over: Partial<Finding> = {}): Finding {
  return { severity: "critical", category: "bug", file: "a.ts", line: 1, title: "t", body: "b", ...over };
}

describe("demoteSeverity (#27)", () => {
  it("steps down one severity", () => {
    expect(demoteSeverity("critical")).toBe("high");
    expect(demoteSeverity("high")).toBe("medium");
    expect(demoteSeverity("medium")).toBe("low");
    expect(demoteSeverity("low")).toBe("nit");
    expect(demoteSeverity("nit")).toBe("nit");
  });
});

describe("collectReflectionCandidates (#27)", () => {
  const findings = [
    finding({ severity: "critical", title: "crit-keep" }),
    finding({ severity: "high", title: "high-drop" }),
    finding({ severity: "medium", title: "med-keep" }),
    finding({ severity: "high", title: "high-rewrite" }),
    finding({ severity: "high", title: "high-keep" }),
  ];
  const decisions: VerifierDecision[] = [
    { id: 1, verdict: "keep", evidence: "a.ts:1 — crit" },
    { id: 2, verdict: "drop", reason: "false-claim", evidence: "a.ts:1 — x" },
    { id: 3, verdict: "keep", evidence: "a.ts:1 — med" },
    { id: 4, verdict: "rewrite", rewritten: "better", evidence: "a.ts:1 — rw" },
    { id: 5, verdict: "keep", evidence: "a.ts:1 — high" },
  ];

  it("selects ONLY critical/high keep verdicts, carrying the verifier evidence", () => {
    const candidates = collectReflectionCandidates(findings, decisions);
    expect(candidates.map((c) => c.finding.title)).toEqual(["crit-keep", "high-keep"]);
    expect(candidates[0].evidence).toBe("a.ts:1 — crit");
    // Same object reference so applyReflection can match by reference.
    expect(candidates[0].finding).toBe(findings[0]);
  });

  it("returns [] when there are no decisions", () => {
    expect(collectReflectionCandidates(findings, undefined)).toEqual([]);
  });
});

describe("formatReflectionCandidates (#27)", () => {
  it("numbers candidates 1-based and includes the verifier evidence", () => {
    const json = formatReflectionCandidates([{ finding: finding({ title: "boom" }), evidence: "a.ts:1 — q" }]);
    const parsed = JSON.parse(json);
    expect(parsed[0].id).toBe(1);
    expect(parsed[0].verifier_evidence).toBe("a.ts:1 — q");
    expect(parsed[0].claim).toContain("boom");
  });

  it("marks missing evidence explicitly", () => {
    const parsed = JSON.parse(formatReflectionCandidates([{ finding: finding() }]));
    expect(parsed[0].verifier_evidence).toBe("(none supplied)");
  });
});

describe("parseReflectionOutput (#27)", () => {
  it("parses a bare array with booleans and verdict words", () => {
    const out = parseReflectionOutput(
      '[{"id":1,"upholds":true},{"id":2,"verdict":"demote","note":"weak"},{"id":3,"verdict":"uphold"}]',
    );
    expect(out).toEqual([
      { id: 1, upholds: true, note: undefined },
      { id: 2, upholds: false, note: "weak" },
      { id: 3, upholds: true, note: undefined },
    ]);
  });

  it("reads a wrapped object and tolerates markdown fences", () => {
    const out = parseReflectionOutput('```json\n{"verdicts":[{"id":1,"upholds":false}]}\n```');
    expect(out).toEqual([{ id: 1, upholds: false, note: undefined }]);
  });

  it("returns undefined on unparseable output (caller then upholds everything)", () => {
    expect(parseReflectionOutput("not json")).toBeUndefined();
    expect(parseReflectionOutput("")).toBeUndefined();
  });

  it("skips entries missing an id or a decidable verdict", () => {
    expect(parseReflectionOutput('[{"upholds":true},{"id":2,"note":"x"}]')).toEqual([]);
  });
});

describe("applyReflection (#27)", () => {
  it("demotes non-upheld candidates one severity, never drops, and records demotions", () => {
    const crit = finding({ severity: "critical", title: "crit" });
    const high = finding({ severity: "high", title: "high" });
    const kept = [crit, high];
    const candidates = [
      { finding: crit, evidence: "e1" },
      { finding: high, evidence: "e2" },
    ];
    const result = applyReflection(kept, candidates, [
      { id: 1, upholds: false, note: "evidence only logs the value" },
      { id: 2, upholds: true },
    ]);
    expect(result.findings).toHaveLength(2); // nothing dropped
    expect(result.findings[0].severity).toBe("high"); // critical → high
    expect(result.findings[1].severity).toBe("high"); // upheld, unchanged
    expect(result.record.reviewed).toBe(2);
    expect(result.record.demotions).toEqual([
      { finding: expect.objectContaining({ title: "crit", severity: "high" }), from: "critical", to: "high", note: "evidence only logs the value" },
    ]);
  });

  it("fail-open: undefined verdicts demote nothing", () => {
    const kept = [finding()];
    const result = applyReflection(kept, [{ finding: kept[0] }], undefined);
    expect(result.findings).toEqual(kept);
    expect(result.record.demotions).toEqual([]);
  });

  it("does not mutate the input findings", () => {
    const crit = finding({ severity: "critical" });
    const kept = [crit];
    applyReflection(kept, [{ finding: crit }], [{ id: 1, upholds: false }]);
    expect(crit.severity).toBe("critical");
  });
});
