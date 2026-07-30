import { describe, expect, it } from "vitest";
import { parseModelFindings, parseToolCalls, parseWalkthrough } from "./guardrail";

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

describe("parseModelFindings — committable suggestedLine (feature #7)", () => {
  it("carries suggestedLine, preserving the line's own leading indentation", () => {
    const res = parseModelFindings(JSON.stringify([{ ...VALID, suggestedLine: "    return a + b;" }]));
    expect(res.findings[0].suggestedLine).toBe("    return a + b;");
  });

  it("accepts snake_case and `replacement` synonyms", () => {
    expect(parseModelFindings(JSON.stringify([{ ...VALID, suggested_line: "x = 1;" }])).findings[0].suggestedLine).toBe(
      "x = 1;",
    );
    expect(parseModelFindings(JSON.stringify([{ ...VALID, replacement: "y = 2;" }])).findings[0].suggestedLine).toBe(
      "y = 2;",
    );
  });

  it("strips only a trailing newline", () => {
    expect(parseModelFindings(JSON.stringify([{ ...VALID, suggestedLine: "z = 3;\n" }])).findings[0].suggestedLine).toBe(
      "z = 3;",
    );
  });

  it("rejects a multi-line value — it can never be a clean single-line swap", () => {
    const res = parseModelFindings(JSON.stringify([{ ...VALID, suggestedLine: "line1\nline2" }]));
    expect(res.findings[0].suggestedLine).toBeUndefined();
  });

  it("rejects empty / whitespace-only values", () => {
    expect(parseModelFindings(JSON.stringify([{ ...VALID, suggestedLine: "   " }])).findings[0].suggestedLine).toBeUndefined();
    expect(parseModelFindings(JSON.stringify([{ ...VALID, suggestedLine: "" }])).findings[0].suggestedLine).toBeUndefined();
  });

  it("is undefined when the model emits no committable line", () => {
    expect(parseModelFindings(JSON.stringify([VALID])).findings[0].suggestedLine).toBeUndefined();
  });
});

describe("parseModelFindings — multi-line suggestedRange + startLine (feature #18)", () => {
  it("carries a multi-line suggestedRange and startLine, preserving indentation", () => {
    const res = parseModelFindings(
      JSON.stringify([{ ...VALID, startLine: 2, suggestedRange: "  if (!ok) {\n    return;\n  }" }]),
    );
    expect(res.findings[0].startLine).toBe(2);
    expect(res.findings[0].suggestedRange).toBe("  if (!ok) {\n    return;\n  }");
  });

  it("accepts snake_case / synonym spellings for both fields", () => {
    const res = parseModelFindings(
      JSON.stringify([{ ...VALID, range_start: 2, replacement_lines: "a;\nb;" }]),
    );
    expect(res.findings[0].startLine).toBe(2);
    expect(res.findings[0].suggestedRange).toBe("a;\nb;");
    const res2 = parseModelFindings(JSON.stringify([{ ...VALID, fromLine: "3", suggestedLines: "x;\ny;" }]));
    expect(res2.findings[0].startLine).toBe(3);
    expect(res2.findings[0].suggestedRange).toBe("x;\ny;");
  });

  it("rejects a SINGLE-line suggestedRange — that is the suggestedLine case, not a range", () => {
    const res = parseModelFindings(JSON.stringify([{ ...VALID, startLine: 2, suggestedRange: "just one line" }]));
    expect(res.findings[0].suggestedRange).toBeUndefined();
  });

  it("strips only trailing newlines from a multi-line range", () => {
    const res = parseModelFindings(JSON.stringify([{ ...VALID, suggestedRange: "a;\nb;\n\n" }]));
    expect(res.findings[0].suggestedRange).toBe("a;\nb;");
  });

  it("does NOT read start_line as startLine (that key already feeds the END line)", () => {
    // A finding that supplies only `start_line` uses it as the finding's `line`
    // (via coerceLine); startLine stays undefined so it can never form a range.
    const res = parseModelFindings(JSON.stringify([{ ...VALID, line: undefined, start_line: 7 }]));
    expect(res.findings[0].line).toBe(7);
    expect(res.findings[0].startLine).toBeUndefined();
  });

  it("ignores non-positive-integer startLine values", () => {
    const res = parseModelFindings(
      JSON.stringify([{ ...VALID, startLine: -1, suggestedRange: "a;\nb;" }]),
    );
    expect(res.findings[0].startLine).toBeUndefined();
  });

  it("leaves both fields undefined for an ordinary finding", () => {
    const res = parseModelFindings(JSON.stringify([VALID]));
    expect(res.findings[0].startLine).toBeUndefined();
    expect(res.findings[0].suggestedRange).toBeUndefined();
  });
});

describe("parseWalkthrough (report item #26)", () => {
  it("extracts the walkthrough field from an object-wrapped response", () => {
    const raw = JSON.stringify({ walkthrough: "Adds pricing guardrails.", findings: [VALID] });
    expect(parseWalkthrough(raw)).toBe("Adds pricing guardrails.");
    // The findings array is still readable by the normal parser.
    expect(parseModelFindings(raw).findings).toHaveLength(1);
  });

  it("tolerates fences and the `effort` / `overview` synonyms", () => {
    expect(parseWalkthrough('```json\n{"effort": "small, low risk", "findings": []}\n```')).toBe("small, low risk");
    expect(parseWalkthrough('{"overview": "refactor only", "findings": []}')).toBe("refactor only");
  });

  it("returns undefined for a bare array, missing field, or empty value", () => {
    expect(parseWalkthrough("[]")).toBeUndefined();
    expect(parseWalkthrough(JSON.stringify([VALID]))).toBeUndefined();
    expect(parseWalkthrough(JSON.stringify({ walkthrough: "   ", findings: [] }))).toBeUndefined();
    expect(parseWalkthrough("not json at all")).toBeUndefined();
    expect(parseWalkthrough("")).toBeUndefined();
  });
});

describe("parseToolCalls (task 6.3)", () => {
  it("parses grep and read_file requests", () => {
    const out = parseToolCalls(
      '{"tool_calls": [{"tool": "grep", "pattern": "applyDiscount", "path": "src"}, {"tool": "read_file", "path": "src/a.ts"}]}',
    );
    expect(out).toEqual([
      { tool: "grep", pattern: "applyDiscount", path: "src" },
      { tool: "read_file", path: "src/a.ts" },
    ]);
  });

  it("tolerates fences, name/arguments variants, and synonyms", () => {
    const out = parseToolCalls(
      '```json\n{"toolCalls": [{"name": "read-file", "arguments": {"file": "x.ts"}}, {"name": "search", "input": {"query": "foo"}}]}\n```',
    );
    expect(out).toEqual([
      { tool: "read_file", path: "x.ts" },
      { tool: "grep", pattern: "foo", path: undefined },
    ]);
  });

  it("returns undefined for findings arrays and prose (not tool calls)", () => {
    expect(parseToolCalls("[]")).toBeUndefined();
    expect(parseToolCalls('[{"severity": "high"}]')).toBeUndefined();
    expect(parseToolCalls("no issues found")).toBeUndefined();
    expect(parseToolCalls("")).toBeUndefined();
  });

  it("returns an empty array when tool_calls exist but are all malformed", () => {
    expect(parseToolCalls('{"tool_calls": [{"tool": "grep"}, {"tool": "launch_missiles", "path": "x"}]}')).toEqual([]);
  });
});
