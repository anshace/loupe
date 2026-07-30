/** Real ts.LanguageService over an in-memory file set (report item #33). */
import { describe, expect, it } from "vitest";
import type { RepoReader } from "@code-review/engine";
import { createSymbolService } from "./index";

function mockReader(files: Record<string, string>): RepoReader {
  return {
    listTree: async () => Object.keys(files),
    readFile: async (p) => files[p],
  };
}

const REPO: Record<string, string> = {
  "src/a.ts": ["export function add(a: number, b: number): number {", "  return a + b;", "}", ""].join("\n"),
  "src/b.ts": [
    'import { add } from "./a";',
    "",
    "export function useAdd(): number {",
    "  return add(1, 2);",
    "}",
    "",
  ].join("\n"),
  // Calls add() with the wrong arg count → a real, local TS2554.
  "src/c.ts": ['import { add } from "./a";', "", "export const bad = add(1);", ""].join("\n"),
};

describe("createSymbolService — real language service", () => {
  it("finds references to an exported symbol ACROSS files", async () => {
    const svc = createSymbolService(mockReader(REPO));
    const refs = await svc.findReferences({ path: "src/a.ts", symbol: "add" });
    const paths = new Set(refs.map((r) => r.path));
    expect(paths.has("src/a.ts")).toBe(true);
    expect(paths.has("src/b.ts")).toBe(true);
    expect(paths.has("src/c.ts")).toBe(true);
  });

  it("resolves a use back to its definition (cross-file), using the line disambiguator", async () => {
    const svc = createSymbolService(mockReader(REPO));
    const defs = await svc.findDefinition({ path: "src/b.ts", symbol: "add", line: 4 });
    expect(defs.length).toBeGreaterThanOrEqual(1);
    expect(defs[0].path).toBe("src/a.ts");
    expect(defs[0].line).toBe(1);
  });

  it("hover returns the resolved signature", async () => {
    const svc = createSymbolService(mockReader(REPO));
    const info = await svc.hover({ path: "src/a.ts", symbol: "add" });
    expect(info).toBeDefined();
    expect(info).toContain("add");
    expect(info).toContain("number");
  });

  it("getDiagnostics reports a real arg-count error (TS2554) on the call site", async () => {
    const svc = createSymbolService(mockReader(REPO));
    const diags = await svc.getDiagnostics(["src/c.ts"]);
    const argErr = diags.find((d) => d.code === 2554);
    expect(argErr).toBeDefined();
    expect(argErr?.path).toBe("src/c.ts");
    expect(argErr?.line).toBe(3);
    expect(argErr?.category).toBe("error");
  });

  it("does NOT report module-resolution noise for in-repo relative imports", async () => {
    const svc = createSymbolService(mockReader(REPO));
    const diags = await svc.getDiagnostics(["src/b.ts"]);
    // "./a" resolves within the in-memory program, so no 2307 for it.
    expect(diags.some((d) => d.code === 2307)).toBe(false);
  });

  it("is fail-soft: an unknown file / symbol yields empty results, never throws", async () => {
    const svc = createSymbolService(mockReader(REPO));
    expect(await svc.findDefinition({ path: "src/missing.ts", symbol: "nope" })).toEqual([]);
    expect(await svc.findReferences({ path: "src/a.ts", symbol: "notASymbol" })).toEqual([]);
    expect(await svc.hover({ path: "src/a.ts", symbol: "notASymbol" })).toBeUndefined();
  });

  it("empty repo → no diagnostics, no crash", async () => {
    const svc = createSymbolService(mockReader({}));
    expect(await svc.getDiagnostics()).toEqual([]);
  });
});
