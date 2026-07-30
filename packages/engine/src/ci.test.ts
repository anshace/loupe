import { describe, expect, it } from "vitest";
import {
  filterToTouched,
  loadCiDiagnostics,
  parseCiOutput,
  renderCiGroundTruth,
  type CiDiagnostic,
} from "./ci";

const ESLINT_JSON = JSON.stringify([
  {
    filePath: "/repo/src/foo.ts",
    messages: [
      { ruleId: "no-unused-vars", severity: 2, message: "'x' is assigned but never used", line: 10 },
      { ruleId: "eqeqeq", severity: 1, message: "Expected === and instead saw ==", line: 20 },
    ],
  },
  { filePath: "/repo/src/other.ts", messages: [] },
]);

const SARIF_JSON = JSON.stringify({
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "ESLint" } },
      results: [
        {
          ruleId: "no-eval",
          level: "error",
          message: { text: "eval can be harmful" },
          locations: [
            { physicalLocation: { artifactLocation: { uri: "src/foo.ts" }, region: { startLine: 5 } } },
          ],
        },
      ],
    },
  ],
});

const TSC_TEXT = [
  "src/foo.ts(12,5): error TS2345: Argument of type 'string' is not assignable.",
  "src/bar.ts:3:1 - warning TS6133: 'y' is declared but its value is never read.",
  "Found 2 errors.",
].join("\n");

describe("parseCiOutput — ESLint JSON (report item #16)", () => {
  it("parses filePath + messages into diagnostics with mapped severity", () => {
    const diags = parseCiOutput(ESLINT_JSON, "eslint");
    expect(diags).toHaveLength(2);
    expect(diags[0]).toEqual({
      file: "/repo/src/foo.ts",
      line: 10,
      ruleId: "no-unused-vars",
      severity: "error",
      message: "'x' is assigned but never used",
      source: "eslint",
    });
    expect(diags[1].severity).toBe("warning");
  });

  it("auto-detects ESLint JSON", () => {
    expect(parseCiOutput(ESLINT_JSON)).toHaveLength(2);
  });
});

describe("parseCiOutput — SARIF", () => {
  it("parses results with physicalLocation into diagnostics", () => {
    const diags = parseCiOutput(SARIF_JSON, "sarif");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ file: "src/foo.ts", line: 5, ruleId: "no-eval", severity: "error" });
    expect(diags[0].source).toBe("sarif:ESLint");
  });

  it("auto-detects SARIF by the runs key", () => {
    expect(parseCiOutput(SARIF_JSON)).toHaveLength(1);
  });
});

describe("parseCiOutput — tsc text", () => {
  it("parses both paren and colon tsc diagnostic formats", () => {
    const diags = parseCiOutput(TSC_TEXT, "tsc");
    expect(diags).toHaveLength(2);
    expect(diags[0]).toEqual({
      file: "src/foo.ts",
      line: 12,
      ruleId: "TS2345",
      severity: "error",
      message: "Argument of type 'string' is not assignable.",
      source: "tsc",
    });
    expect(diags[1]).toMatchObject({ file: "src/bar.ts", line: 3, ruleId: "TS6133", severity: "warning" });
  });

  it("auto-detects tsc text (not JSON)", () => {
    expect(parseCiOutput(TSC_TEXT)).toHaveLength(2);
  });

  it("is fail-soft on garbage", () => {
    expect(parseCiOutput("!!! not anything", "auto")).toEqual([]);
    expect(parseCiOutput("{ broken json", "eslint")).toEqual([]);
  });
});

describe("filterToTouched", () => {
  const diags: CiDiagnostic[] = [
    { file: "/repo/src/foo.ts", line: 1, message: "a", source: "eslint" },
    { file: "src/bar.ts", line: 2, message: "b", source: "tsc" },
    { file: "src/untouched.ts", line: 3, message: "c", source: "tsc" },
  ];

  it("keeps only diagnostics for the touched paths (suffix + basename tolerant)", () => {
    const kept = filterToTouched(diags, ["src/foo.ts", "src/bar.ts"]);
    expect(kept.map((d) => d.file)).toEqual(["/repo/src/foo.ts", "src/bar.ts"]);
  });

  it("matches by basename when directories differ", () => {
    const kept = filterToTouched([{ file: "packages/x/util.ts", line: 1, message: "m", source: "tsc" }], ["util.ts"]);
    expect(kept).toHaveLength(1);
  });
});

describe("renderCiGroundTruth", () => {
  it("renders a cited ground-truth line per diagnostic", () => {
    const out = renderCiGroundTruth([
      { file: "src/foo.ts", line: 10, ruleId: "no-unused-vars", severity: "error", message: "unused", source: "eslint" },
    ]);
    expect(out).toBe("- error src/foo.ts:10 [no-unused-vars] — unused (eslint)");
  });

  it("caps the number of diagnostics and notes the remainder", () => {
    const many: CiDiagnostic[] = Array.from({ length: 45 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: i,
      message: "m",
      source: "tsc",
    }));
    const out = renderCiGroundTruth(many);
    expect(out).toContain("…and 5 more diagnostic(s) not shown");
  });

  it("is (none) for no diagnostics", () => {
    expect(renderCiGroundTruth([])).toBe("(none)");
  });
});

describe("loadCiDiagnostics", () => {
  it("reads via injected io and parses", () => {
    const diags = loadCiDiagnostics("report.json", "auto", { readFile: () => ESLINT_JSON });
    expect(diags).toHaveLength(2);
  });

  it("is fail-soft when the io read throws (absent path)", () => {
    expect(
      loadCiDiagnostics("nope.json", "auto", {
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toEqual([]);
  });
});
