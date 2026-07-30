/** TS language-service interface: pure mapping + tool-call parsing + agentic
 *  execution (report item #33). The real ts.LanguageService lives in
 *  packages/ts-symbols; here we test the engine's zero-dep contract. */
import { describe, expect, it } from "vitest";
import type { RepoReader } from "./agentic";
import { executeToolCalls, newAgenticUsage, DEFAULT_AGENTIC_CAPS } from "./agentic";
import { parseToolCalls } from "./guardrail";
import { diagnosticsToFindings, NOOP_SYMBOL_SERVICE } from "./symbols";
import type { SymbolDiagnostic, SymbolQuery, SymbolService } from "./symbols";

const caps = DEFAULT_AGENTIC_CAPS;
const emptyReader: RepoReader = { listTree: async () => [], readFile: async () => undefined };

describe("diagnosticsToFindings (report item #33)", () => {
  const diag = (over: Partial<SymbolDiagnostic>): SymbolDiagnostic => ({
    path: "src/a.ts",
    line: 5,
    column: 1,
    category: "error",
    code: 2554,
    message: "Expected 2 arguments, but got 1.",
    ...over,
  });

  it("keeps a real error on an ADDED line and maps error→high, category type-error", () => {
    const out = diagnosticsToFindings([diag({})], { addedLines: { "src/a.ts": [5] } });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("high");
    expect(out[0].category).toBe("type-error");
    expect(out[0].file).toBe("src/a.ts");
    expect(out[0].line).toBe(5);
    expect(out[0].title).toContain("TS2554");
    expect(out[0].body).toContain("compiler-verified");
  });

  it("drops diagnostics NOT on an added line (pre-existing errors are not this PR's)", () => {
    const out = diagnosticsToFindings([diag({ line: 99 })], { addedLines: { "src/a.ts": [5] } });
    expect(out).toEqual([]);
  });

  it("drops program-incompleteness codes (no node_modules on the no-checkout path)", () => {
    const cannotFindModule = diag({ code: 2307, message: "Cannot find module 'react'." });
    const out = diagnosticsToFindings([cannotFindModule], { addedLines: { "src/a.ts": [5] } });
    expect(out).toEqual([]);
  });

  it("maps warning→medium and drops suggestion/message below the default minCategory", () => {
    const warn = diag({ category: "warning", code: 6133 });
    const suggestion = diag({ category: "suggestion", code: 80001, line: 6 });
    const out = diagnosticsToFindings([warn, suggestion], {
      addedLines: { "src/a.ts": [5, 6] },
    });
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("medium");
  });

  it("dedupes by (file, line, code)", () => {
    const out = diagnosticsToFindings([diag({}), diag({ column: 9 })], {
      addedLines: { "src/a.ts": [5] },
    });
    expect(out).toHaveLength(1);
  });
});

describe("parseToolCalls — TS symbol tools (report item #33)", () => {
  it("parses find_definition / find_references / hover with path + symbol", () => {
    const raw = JSON.stringify({
      tool_calls: [
        { tool: "find_definition", path: "src/a.ts", symbol: "doThing" },
        { tool: "find_references", path: "src/a.ts", symbol: "doThing", line: 12 },
        { tool: "hover", path: "src/a.ts", symbol: "doThing" },
      ],
    });
    const calls = parseToolCalls(raw);
    expect(calls).toEqual([
      { tool: "find_definition", path: "src/a.ts", symbol: "doThing", line: undefined },
      { tool: "find_references", path: "src/a.ts", symbol: "doThing", line: 12 },
      { tool: "hover", path: "src/a.ts", symbol: "doThing", line: undefined },
    ]);
  });

  it("tolerates aliases and nested args", () => {
    const raw = JSON.stringify({
      tool_calls: [
        { name: "goto_definition", arguments: { file: "src/a.ts", identifier: "x" } },
        { tool: "usages", args: { path: "src/a.ts", name: "x", row: "3" } },
      ],
    });
    const calls = parseToolCalls(raw);
    expect(calls?.[0]).toEqual({ tool: "find_definition", path: "src/a.ts", symbol: "x", line: undefined });
    expect(calls?.[1]).toEqual({ tool: "find_references", path: "src/a.ts", symbol: "x", line: 3 });
  });

  it("drops a symbol tool missing the symbol name", () => {
    const raw = JSON.stringify({ tool_calls: [{ tool: "hover", path: "src/a.ts" }] });
    expect(parseToolCalls(raw)).toEqual([]);
  });
});

describe("executeToolCalls — symbol-tool routing (report item #33)", () => {
  const mockService: SymbolService = {
    findDefinition: async (q: SymbolQuery) => [
      { path: "src/a.ts", line: 1, column: 18, text: `export function ${q.symbol}(a: number) {` },
    ],
    findReferences: async (q: SymbolQuery) => [
      { path: "src/a.ts", line: 1, column: 18, text: `function ${q.symbol}` },
      { path: "src/b.ts", line: 2, column: 5, text: `${q.symbol}(1)` },
    ],
    hover: async (q: SymbolQuery) => `function ${q.symbol}(a: number): number`,
    getDiagnostics: async () => [],
  };

  it("renders definitions from the injected service", async () => {
    const out = await executeToolCalls(
      [{ tool: "find_definition", path: "src/a.ts", symbol: "add" }],
      emptyReader,
      caps,
      newAgenticUsage(),
      mockService,
    );
    expect(out).toContain("[find_definition add in src/a.ts]");
    expect(out).toContain("Definition(s):");
    expect(out).toContain("src/a.ts:1:18");
  });

  it("renders cross-file references", async () => {
    const out = await executeToolCalls(
      [{ tool: "find_references", path: "src/a.ts", symbol: "add" }],
      emptyReader,
      caps,
      newAgenticUsage(),
      mockService,
    );
    expect(out).toContain("Reference(s) (2):");
    expect(out).toContain("src/b.ts:2:5");
  });

  it("renders hover text", async () => {
    const out = await executeToolCalls(
      [{ tool: "hover", path: "src/a.ts", symbol: "add", line: 1 }],
      emptyReader,
      caps,
      newAgenticUsage(),
      mockService,
    );
    expect(out).toContain("function add(a: number): number");
  });

  it("reports the tool unavailable when NO service is injected (graceful absence)", async () => {
    const out = await executeToolCalls(
      [{ tool: "find_references", path: "src/a.ts", symbol: "add" }],
      emptyReader,
      caps,
      newAgenticUsage(),
      undefined,
    );
    expect(out).toContain("not available this run");
  });

  it("NOOP_SYMBOL_SERVICE yields an empty result, never throws", async () => {
    const out = await executeToolCalls(
      [{ tool: "find_definition", path: "src/a.ts", symbol: "add" }],
      emptyReader,
      caps,
      newAgenticUsage(),
      NOOP_SYMBOL_SERVICE,
    );
    expect(out).toContain("No definitions found");
  });
});
