import { describe, expect, it } from "vitest";
import { parseModelFindings } from "./guardrail";

const VALID = {
  severity: "high",
  category: "bug",
  file: "src/app.ts",
  line: 4,
  title: "Off-by-one",
  body: "Loop bound is wrong.",
};

describe("parseModelFindings", () => {
  it("parses a clean top-level array", () => {
    const res = parseModelFindings(JSON.stringify([VALID]));
    expect(res.degraded).toBe(false);
    expect(res.droppedCount).toBe(0);
    expect(res.findings).toEqual([
      {
        severity: "high",
        category: "bug",
        file: "src/app.ts",
        line: 4,
        title: "Off-by-one",
        body: "Loop bound is wrong.",
        suggestion: undefined,
      },
    ]);
  });

  it("accepts a {findings: [...]} wrapper", () => {
    const res = parseModelFindings(JSON.stringify({ findings: [VALID] }));
    expect(res.findings).toHaveLength(1);
    expect(res.degraded).toBe(false);
  });

  it("strips markdown fences (```json ... ```)", () => {
    const res = parseModelFindings("```json\n" + JSON.stringify([VALID]) + "\n```");
    expect(res.findings).toHaveLength(1);
    expect(res.degraded).toBe(false);
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const res = parseModelFindings("Here are my findings:\n" + JSON.stringify([VALID]) + "\nHope that helps!");
    expect(res.findings).toHaveLength(1);
    expect(res.degraded).toBe(false);
  });

  it("tolerates alternate key names", () => {
    const res = parseModelFindings(
      JSON.stringify([
        {
          level: "warning",
          type: "maintainability",
          path: "src/x.ts",
          line_number: "12",
          summary: "Confusing name",
          description: "Rename it.",
          fix: "const better = ...",
        },
      ]),
    );
    expect(res.findings).toEqual([
      {
        severity: "medium",
        category: "maintainability",
        file: "src/x.ts",
        line: 12,
        title: "Confusing name",
        body: "Rename it.",
        suggestion: "const better = ...",
      },
    ]);
  });

  it("maps severity synonyms and drops findings with unknown severities", () => {
    const res = parseModelFindings(
      JSON.stringify([
        { ...VALID, severity: "blocker" },
        { ...VALID, severity: "MAJOR" },
        { ...VALID, severity: "catastrophic" }, // unknown → dropped, never rewritten
      ]),
    );
    expect(res.findings.map((f) => f.severity)).toEqual(["critical", "high"]);
    expect(res.droppedCount).toBe(1);
  });

  it("drops individually malformed findings and keeps valid ones", () => {
    const res = parseModelFindings(
      JSON.stringify([
        VALID,
        { severity: "high" }, // no file
        { file: "a.ts", title: "t", body: "b" }, // no severity
        "just a string",
        null,
        { ...VALID, file: "src/other.ts" },
      ]),
    );
    expect(res.findings.map((f) => f.file)).toEqual(["src/app.ts", "src/other.ts"]);
    expect(res.droppedCount).toBe(4);
    expect(res.degraded).toBe(false);
  });

  it("backfills title from body and body from title", () => {
    const res = parseModelFindings(
      JSON.stringify([
        { severity: "low", file: "a.ts", body: "Only a body." },
        { severity: "low", file: "b.ts", title: "Only a title" },
      ]),
    );
    expect(res.findings[0].title).toBe("Only a body.");
    expect(res.findings[1].body).toBe("Only a title");
  });

  it("treats a bare single finding object as a one-element list", () => {
    const res = parseModelFindings(JSON.stringify(VALID));
    expect(res.findings).toHaveLength(1);
  });

  it("returns an empty, non-degraded result for an empty array", () => {
    expect(parseModelFindings("[]")).toEqual({ findings: [], degraded: false, droppedCount: 0 });
  });

  it("degrades on pure garbage text", () => {
    expect(parseModelFindings("I could not review this PR, sorry!")).toEqual({
      findings: [],
      degraded: true,
      droppedCount: 0,
    });
  });

  it("degrades on empty or whitespace input", () => {
    expect(parseModelFindings("").degraded).toBe(true);
    expect(parseModelFindings("   \n ").degraded).toBe(true);
  });

  it("degrades on JSON that is not findings-shaped", () => {
    expect(parseModelFindings('{"ok": true}').degraded).toBe(true);
    expect(parseModelFindings("42").degraded).toBe(true);
  });

  it("ignores line values that are not positive integers", () => {
    const res = parseModelFindings(
      JSON.stringify([
        { ...VALID, line: -3 },
        { ...VALID, line: "abc" },
        { ...VALID, line: 2.5 },
      ]),
    );
    expect(res.findings).toHaveLength(3);
    expect(res.findings.every((f) => f.line === undefined)).toBe(true);
  });

  it("never throws, whatever the input shape", () => {
    for (const input of ["", "{", "]", "```\n```", "null", "true", '{"findings": "nope"}']) {
      expect(() => parseModelFindings(input)).not.toThrow();
    }
  });
});
