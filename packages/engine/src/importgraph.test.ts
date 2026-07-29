/** Cross-file recall (report item #8): import graph, signature-change detection,
 *  forced caller injection, and the find_importers agentic tool. */
import { describe, expect, it } from "vitest";
import { executeToolCalls, newAgenticUsage } from "./agentic";
import type { RepoReader } from "./agentic";
import { DEFAULT_AGENTIC_CAPS } from "./agentic";
import { parseToolCalls } from "./guardrail";
import { parseUnifiedDiff } from "./diff";
import {
  DEFAULT_IMPORT_SCAN_CAPS,
  collectSignatureChangeCallers,
  detectSignatureChanges,
  extractDecl,
  findImporters,
  importersFromScan,
  moduleKey,
  parseImportSpecifiers,
  resolveSpecToModuleKey,
  scanRepoImports,
} from "./importgraph";

function fakeReader(files: Record<string, string>): RepoReader {
  return {
    listTree: async () => Object.keys(files),
    readFile: async (path) => files[path],
  };
}

describe("path + import parsing", () => {
  it("moduleKey strips code extensions and /index", () => {
    expect(moduleKey("src/a.ts")).toBe("src/a");
    expect(moduleKey("src/a/index.ts")).toBe("src/a");
    expect(moduleKey("src/a")).toBe("src/a");
  });

  it("parseImportSpecifiers finds relative imports across syntaxes, skips npm", () => {
    const src = [
      'import { x } from "./a";',
      'export * from "../b/c";',
      'import "./side-effect";',
      'const d = require("./d");',
      'const e = await import("./e");',
      'import fs from "node:fs";', // bare → skipped
    ].join("\n");
    expect(parseImportSpecifiers(src).sort()).toEqual(
      ["../b/c", "./a", "./d", "./e", "./side-effect"].sort(),
    );
  });

  it("resolveSpecToModuleKey resolves relative specs and drops bare ones", () => {
    expect(resolveSpecToModuleKey("src/x/y.ts", "./z")).toBe("src/x/z");
    expect(resolveSpecToModuleKey("src/x/y.ts", "../w")).toBe("src/w");
    expect(resolveSpecToModuleKey("src/x/y.ts", "react")).toBeUndefined();
  });
});

describe("extractDecl / detectSignatureChanges", () => {
  it("extracts function, exported-const-arrow, and modified-method decls", () => {
    expect(extractDecl("export function add(a: number): number {")).toEqual({
      name: "add",
      sig: "(a: number): number",
    });
    expect(extractDecl("export const f = (a, b) => a + b")).toEqual({ name: "f", sig: "(a, b)" });
    expect(extractDecl("  public doThing(x: string): void {")).toEqual({
      name: "doThing",
      sig: "(x: string): void",
    });
  });

  it("does not mistake a function CALL for a declaration", () => {
    expect(extractDecl("const z = add(1, 2);")).toBeUndefined();
    expect(extractDecl("return compute(x);")).toBeUndefined();
  });

  it("detects a changed exported signature (param added)", () => {
    const diff = `diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,3 @@
-export function add(a: number): number {
+export function add(a: number, b: number): number {
   return a;
 }`;
    const changes = detectSignatureChanges(parseUnifiedDiff(diff));
    expect(changes).toEqual([
      { file: "src/math.ts", symbol: "add", before: "(a: number): number", after: "(a: number, b: number): number" },
    ]);
  });

  it("ignores body-only changes (signature line unchanged)", () => {
    const diff = `diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,3 @@
 export function add(a: number, b: number): number {
-  return a + b;
+  return a + b + 0;
 }`;
    expect(detectSignatureChanges(parseUnifiedDiff(diff))).toEqual([]);
  });

  it("ignores non-TS/JS files", () => {
    const diff = `diff --git a/src/x.py b/src/x.py
--- a/src/x.py
+++ b/src/x.py
@@ -1,2 +1,2 @@
-def add(a):
+def add(a, b):
     return a`;
    expect(detectSignatureChanges(parseUnifiedDiff(diff))).toEqual([]);
  });
});

describe("scanRepoImports / findImporters", () => {
  const FILES = {
    "src/math.ts": "export function add(a, b) {\n  return a + b;\n}\n",
    "src/caller.ts": 'import { add } from "./math";\nexport const y = add(1, 2);\n',
    "src/unrelated.ts": 'import { z } from "./other";\nconst q = z();\n',
    "img/logo.png": "binary",
  };

  it("scanRepoImports records relative imports per file, skipping non-code", () => {
    const scan = scanRepoImports(fakeReader(FILES), DEFAULT_IMPORT_SCAN_CAPS, newAgenticUsage());
    return scan.then((s) => {
      expect(s.importsByFile.get("src/caller.ts")).toEqual(["src/math"]);
      expect(s.importsByFile.has("img/logo.png")).toBe(false);
    });
  });

  it("findImporters returns files importing the target, symbol-referencing first", async () => {
    const importers = await findImporters(
      "src/math.ts",
      fakeReader(FILES),
      DEFAULT_IMPORT_SCAN_CAPS,
      newAgenticUsage(),
      ["add"],
    );
    expect(importers.map((i) => i.path)).toEqual(["src/caller.ts"]);
    expect(importers[0].referencesSymbol).toBe(true);
    expect(importers[0].callSites[0]).toMatchObject({ file: "src/caller.ts", line: 2 });
  });

  it("respects the file-read cap and marks the scan capped", async () => {
    const usage = newAgenticUsage();
    const scan = await scanRepoImports(fakeReader(FILES), { ...DEFAULT_IMPORT_SCAN_CAPS, maxFileReads: 1 }, usage);
    expect(usage.fileReads).toBe(1);
    expect(scan.cappedOut).toBe(true);
  });
});

describe("collectSignatureChangeCallers", () => {
  const SIG_DIFF = `diff --git a/src/math.ts b/src/math.ts
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,3 @@
-export function add(a: number): number {
+export function add(a: number, b: number): number {
   return a;
 }`;

  it("catches a signature change whose caller was NOT updated", async () => {
    const files = parseUnifiedDiff(SIG_DIFF);
    const reader = fakeReader({
      "src/math.ts": "export function add(a, b) {\n  return a + b;\n}\n",
      // stale caller: still calls add with one argument
      "src/caller.ts": 'import { add } from "./math";\nexport const y = add(1);\n',
    });
    const out = await collectSignatureChangeCallers(files, reader, DEFAULT_IMPORT_SCAN_CAPS, newAgenticUsage());
    expect(out.changes).toHaveLength(1);
    expect(out.text).toContain("Cross-file callers of changed signatures");
    expect(out.text).toContain("`add` in `src/math.ts`");
    expect(out.text).toContain("before: `(a: number): number`");
    expect(out.text).toContain("after:  `(a: number, b: number): number`");
    expect(out.text).toContain("`src/caller.ts:2`");
    expect(out.text).toContain("add(1)");
    expect(out.truncated).toBe(false);
  });

  it("emits nothing when there are no callers in other files", async () => {
    const files = parseUnifiedDiff(SIG_DIFF);
    const reader = fakeReader({ "src/math.ts": "export function add(a, b) {}\n" });
    const out = await collectSignatureChangeCallers(files, reader, DEFAULT_IMPORT_SCAN_CAPS, newAgenticUsage());
    expect(out.text).toBe("");
    expect(out.changes).toEqual([]);
  });

  it("caps the number of injected call sites and flags truncation", async () => {
    const files = parseUnifiedDiff(SIG_DIFF);
    const reader = fakeReader({
      "src/math.ts": "export function add(a, b) {}\n",
      "src/c1.ts": 'import { add } from "./math";\nadd(1);\n',
      "src/c2.ts": 'import { add } from "./math";\nadd(2);\n',
      "src/c3.ts": 'import { add } from "./math";\nadd(3);\n',
    });
    const out = await collectSignatureChangeCallers(files, reader, DEFAULT_IMPORT_SCAN_CAPS, newAgenticUsage(), {
      maxCallSites: 2,
    });
    expect(out.truncated).toBe(true);
    const siteLines = out.text.split("\n").filter((l) => /^- `src\/c\d\.ts:/.test(l));
    expect(siteLines.length).toBe(2);
  });
});

describe("find_importers agentic tool", () => {
  const FILES = {
    "src/math.ts": "export function add(a, b) {\n  return a + b;\n}\n",
    "src/caller.ts": 'import { add } from "./math";\nconst y = add(1, 2);\n',
  };

  it("parseToolCalls recognizes a find_importers request", () => {
    expect(parseToolCalls('{"tool_calls": [{"tool": "find_importers", "path": "src/math.ts"}]}')).toEqual([
      { tool: "find_importers", path: "src/math.ts" },
    ]);
    // name-normalization variant
    expect(parseToolCalls('{"tool_calls": [{"tool": "who imports", "file": "src/math.ts"}]}')).toEqual([
      { tool: "find_importers", path: "src/math.ts" },
    ]);
  });

  it("executeToolCalls runs find_importers and lists importers", async () => {
    const out = await executeToolCalls(
      [{ tool: "find_importers", path: "src/math.ts" }],
      fakeReader(FILES),
      DEFAULT_AGENTIC_CAPS,
      newAgenticUsage(),
    );
    expect(out).toContain("[find_importers src/math.ts]");
    expect(out).toContain("Files importing src/math.ts (1):");
    expect(out).toContain("- src/caller.ts");
  });

  it("reports no importers cleanly", async () => {
    const out = await executeToolCalls(
      [{ tool: "find_importers", path: "src/orphan.ts" }],
      fakeReader(FILES),
      DEFAULT_AGENTIC_CAPS,
      newAgenticUsage(),
    );
    expect(out).toContain("No importers found");
  });
});

describe("importersFromScan (pure filter)", () => {
  it("excludes the target file itself and non-importers", async () => {
    const scan = await scanRepoImports(
      fakeReader({
        "src/a.ts": 'import { x } from "./b";\n',
        "src/b.ts": "export const x = 1;\n",
        "src/c.ts": "export const y = 2;\n",
      }),
      DEFAULT_IMPORT_SCAN_CAPS,
      newAgenticUsage(),
    );
    expect(importersFromScan(scan, "src/b.ts").map((i) => i.path)).toEqual(["src/a.ts"]);
    expect(importersFromScan(scan, "src/c.ts")).toEqual([]);
  });
});
