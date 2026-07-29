import { describe, expect, it } from "vitest";
import type { Finding } from "./types";
import {
  applyVerdicts,
  buildGroundingSource,
  checkGrounding,
  formatFindingsForVerifier,
  parseCitation,
  parseVerifierOutput,
} from "./verify";

const finding = (title: string): Finding => ({
  severity: "high",
  category: "bug",
  file: "src/a.ts",
  line: 3,
  title,
  body: `${title} body`,
});

const FINDINGS = [finding("one"), finding("two"), finding("three")];

describe("parseVerifierOutput", () => {
  it("parses a plain verdicts array", () => {
    const out = parseVerifierOutput(
      '[{"id": 1, "verdict": "keep"}, {"id": 2, "verdict": "drop", "reason": "false-claim", "evidence": "src/a.ts:3 — checked"}]',
    );
    expect(out).toHaveLength(2);
    expect(out?.[1]).toMatchObject({ id: 2, verdict: "drop", reason: "false-claim" });
  });

  it("tolerates a wrapper object, fences, verdict synonyms, and underscore reasons", () => {
    const out = parseVerifierOutput(
      '```json\n{"verdicts": [{"index": "2", "decision": "reject", "reason": "pre_existing", "evidence": "e"}]}\n```',
    );
    expect(out).toEqual([
      { id: 2, verdict: "drop", evidence: "e", reason: "pre-existing", rewritten: undefined },
    ]);
  });

  it("drops malformed entries but keeps valid ones", () => {
    const out = parseVerifierOutput('[{"id": 1, "verdict": "keep"}, {"verdict": "drop"}, "junk"]');
    expect(out).toEqual([{ id: 1, verdict: "keep", evidence: undefined, reason: undefined, rewritten: undefined }]);
  });

  it("returns undefined (fail OPEN) for unparseable output", () => {
    expect(parseVerifierOutput("I could not verify these findings, sorry.")).toBeUndefined();
    expect(parseVerifierOutput("")).toBeUndefined();
  });
});

describe("applyVerdicts", () => {
  it("keeps everything and flags degraded when decisions are undefined", () => {
    const out = applyVerdicts(FINDINGS, undefined);
    expect(out.kept).toEqual(FINDINGS);
    expect(out.degraded).toBe(true);
    expect(out.dropped).toEqual([]);
  });

  it("applies keep / rewrite / drop; drop carries reason and evidence", () => {
    const out = applyVerdicts(FINDINGS, [
      { id: 1, verdict: "keep" },
      { id: 2, verdict: "rewrite", rewritten: "corrected body", evidence: "src/a.ts:3" },
      { id: 3, verdict: "drop", reason: "false-claim", evidence: "src/a.ts:3 — no such call" },
    ]);
    expect(out.kept.map((f) => f.title)).toEqual(["one", "two"]);
    expect(out.kept[1].body).toBe("corrected body");
    expect(out.rewrittenCount).toBe(1);
    expect(out.dropped).toEqual([
      { finding: FINDINGS[2], reason: "false-claim", evidence: "src/a.ts:3 — no such call" },
    ]);
    expect(out.degraded).toBe(false);
  });

  it("fails open per finding: no decision → keep, drop without reason/evidence → keep", () => {
    const out = applyVerdicts(FINDINGS, [
      { id: 2, verdict: "drop", evidence: "src/a.ts:3" }, // no reason
      { id: 3, verdict: "drop", reason: "out-of-scope" }, // no evidence
    ]);
    expect(out.kept).toEqual(FINDINGS);
    expect(out.dropped).toEqual([]);
  });

  it("keeps the original body when a rewrite has no rewritten text", () => {
    const out = applyVerdicts(FINDINGS, [{ id: 1, verdict: "rewrite" }]);
    expect(out.kept[0].body).toBe("one body");
    expect(out.rewrittenCount).toBe(0);
  });
});

describe("formatFindingsForVerifier", () => {
  it("numbers findings with 1-based ids", () => {
    const parsed = JSON.parse(formatFindingsForVerifier(FINDINGS)) as Array<{ id: number; title: string }>;
    expect(parsed.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(parsed[0].title).toBe("one");
  });
});

// ── Feature #1: deterministic quote grounding ───────────────────────────────

describe("parseCitation", () => {
  it("splits file:line and the verbatim quote after a dash", () => {
    expect(parseCitation("src/a.ts:12 — const x = req.body.id")).toEqual({
      file: "src/a.ts",
      line: 12,
      quote: "const x = req.body.id",
    });
  });

  it("handles a bare file:line with no quote", () => {
    expect(parseCitation("src/a.ts:5")).toEqual({ file: "src/a.ts", line: 5, quote: undefined });
  });

  it("treats a quote-only string as the quote", () => {
    expect(parseCitation("some code here")).toEqual({ quote: "some code here" });
  });
});

describe("checkGrounding", () => {
  const source = buildGroundingSource(
    [
      {
        path: "src/a.ts",
        lines: [
          { line: 10, content: "const user = users[req.body.id];" },
          { line: 11, content: "return user.name;" },
        ],
      },
    ],
    "### context\nhelper(config) { return config.value; }",
  );

  it("grounds a quote that appears near the cited line", () => {
    expect(checkGrounding("src/a.ts:10 — users[req.body.id]", source)).toBe("grounded");
  });

  it("grounds against the context text as a fallback", () => {
    expect(checkGrounding("other.ts:1 — return config.value", source)).toBe("grounded");
  });

  it("flags a fabricated quote that appears nowhere in the payload", () => {
    expect(checkGrounding("src/a.ts:10 — deleteEverything(secretKey)", source)).toBe("quote-not-found");
  });

  it("returns no-citation when there is no verifiable quote", () => {
    expect(checkGrounding("src/a.ts:10", source)).toBe("no-citation");
    expect(checkGrounding("src/a.ts:10 — x", source)).toBe("no-citation"); // too short
  });

  it("normalizes whitespace when matching", () => {
    expect(checkGrounding("src/a.ts:11 — return    user.name", source)).toBe("grounded");
  });
});

describe("applyVerdicts — grounding (feature #1)", () => {
  const source = buildGroundingSource([
    { path: "src/a.ts", lines: [{ line: 3, content: "const total = qty * price;" }] },
  ]);

  it("flags a keep whose evidence is missing (still kept)", () => {
    const out = applyVerdicts(FINDINGS, [{ id: 1, verdict: "keep" }], source);
    expect(out.kept).toHaveLength(3);
    expect(out.ungrounded).toEqual([{ finding: FINDINGS[0], verdict: "keep", reason: "missing-evidence" }]);
  });

  it("flags a keep whose quote is fabricated (still kept)", () => {
    const out = applyVerdicts(FINDINGS, [{ id: 1, verdict: "keep", evidence: "src/a.ts:3 — wipeDatabase()" }], source);
    expect(out.kept).toHaveLength(3);
    expect(out.ungrounded).toEqual([{ finding: FINDINGS[0], verdict: "keep", reason: "quote-not-found" }]);
  });

  it("does not flag a keep whose quote is grounded", () => {
    const out = applyVerdicts(FINDINGS, [{ id: 1, verdict: "keep", evidence: "src/a.ts:3 — qty * price" }], source);
    expect(out.ungrounded).toEqual([]);
  });

  it("demotes a drop with a fabricated quote back to a keep and flags it", () => {
    const out = applyVerdicts(
      FINDINGS,
      [{ id: 2, verdict: "drop", reason: "false-claim", evidence: "src/a.ts:3 — never happens here" }],
      source,
    );
    expect(out.kept).toHaveLength(3); // nothing dropped
    expect(out.dropped).toEqual([]);
    expect(out.ungrounded).toEqual([{ finding: FINDINGS[1], verdict: "drop", reason: "quote-not-found" }]);
  });

  it("honors a drop whose quote is grounded", () => {
    const out = applyVerdicts(
      FINDINGS,
      [{ id: 2, verdict: "drop", reason: "false-claim", evidence: "src/a.ts:3 — qty * price" }],
      source,
    );
    expect(out.dropped).toHaveLength(1);
    expect(out.ungrounded).toEqual([]);
  });
});

describe("applyVerdicts — abstention (feature #6)", () => {
  it("records an insufficient-context drop distinctly, without requiring evidence", () => {
    const out = applyVerdicts(FINDINGS, [{ id: 3, verdict: "drop", reason: "insufficient-context" }]);
    expect(out.kept.map((f) => f.title)).toEqual(["one", "two"]);
    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0].reason).toBe("insufficient-context");
    expect(out.dropped[0].finding).toBe(FINDINGS[2]);
  });

  it("keeps the model-supplied evidence when the abstention carries one", () => {
    const out = applyVerdicts(FINDINGS, [
      { id: 1, verdict: "drop", reason: "insufficient-context", evidence: "helper not in the diff" },
    ]);
    expect(out.dropped[0].evidence).toBe("helper not in the diff");
  });
});
