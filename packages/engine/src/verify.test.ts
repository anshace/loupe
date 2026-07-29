import { describe, expect, it } from "vitest";
import type { Finding } from "./types";
import { applyVerdicts, formatFindingsForVerifier, parseVerifierOutput } from "./verify";

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
