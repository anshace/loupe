import { describe, expect, it } from "vitest";
import type { RepoReader } from "./agentic";
import { newAgenticUsage } from "./agentic";
import {
  DEFAULT_CTAGS_CAPS,
  buildSymbolIndex,
  extractSymbolDefs,
  isIndexableFile,
  renderChangedSymbolDefs,
} from "./ctags";

/** In-memory reader over a { path → content } map. */
function reader(files: Record<string, string>): RepoReader {
  return {
    listTree: async () => Object.keys(files),
    readFile: async (p) => files[p],
  };
}

describe("isIndexableFile", () => {
  it("accepts TS/JS/Py, rejects the rest", () => {
    expect(isIndexableFile("src/a.ts")).toBe(true);
    expect(isIndexableFile("src/a.tsx")).toBe(true);
    expect(isIndexableFile("svc/main.py")).toBe(true);
    expect(isIndexableFile("x.go")).toBe(false);
    expect(isIndexableFile("README.md")).toBe(false);
  });
});

describe("extractSymbolDefs — TS/JS", () => {
  it("extracts functions, classes, consts, interfaces, types, enums with export flags + lines", () => {
    const src = [
      "export function doThing(a: number) {}", // 1
      "class Widget {}", // 2
      "export const helper = () => {};", // 3
      "export interface Shape { x: number }", // 4
      "type Id = string;", // 5
      "export enum Color { Red }", // 6
      "  const local = 1;", // 7 (indented, still captured)
    ].join("\n");
    const defs = extractSymbolDefs(src, "src/a.ts");
    const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
    expect(byName.doThing).toMatchObject({ kind: "function", line: 1, exported: true });
    expect(byName.Widget).toMatchObject({ kind: "class", line: 2, exported: false });
    expect(byName.helper).toMatchObject({ kind: "const", line: 3, exported: true });
    expect(byName.Shape).toMatchObject({ kind: "interface", line: 4, exported: true });
    expect(byName.Id).toMatchObject({ kind: "type", line: 5, exported: false });
    expect(byName.Color).toMatchObject({ kind: "enum", line: 6, exported: true });
    expect(byName.local).toMatchObject({ kind: "const", exported: false });
  });

  it("does not mistake a call for a declaration", () => {
    const defs = extractSymbolDefs("doThing(1);\nreturn foo(bar);", "a.ts");
    expect(defs).toEqual([]);
  });
});

describe("extractSymbolDefs — Python", () => {
  it("marks module-level defs exported and indented ones as methods", () => {
    const src = ["def top():", "    pass", "class Service:", "    def method(self):", "        pass", "def _private():"].join(
      "\n",
    );
    const defs = extractSymbolDefs(src, "svc/s.py");
    const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
    expect(byName.top).toMatchObject({ kind: "function", exported: true, line: 1 });
    expect(byName.Service).toMatchObject({ kind: "class", exported: true, line: 3 });
    expect(byName.method).toMatchObject({ kind: "method", exported: false });
    expect(byName._private).toMatchObject({ kind: "function", exported: false });
  });

  it("returns nothing for unsupported languages", () => {
    expect(extractSymbolDefs("func Foo() {}", "main.go")).toEqual([]);
  });
});

describe("buildSymbolIndex", () => {
  it("indexes declarations across the tree, skipping non-code files", async () => {
    const files = {
      "src/a.ts": "export function doThing() {}\nexport class Thing {}",
      "src/b.ts": "export function doThing() {}", // same name, different file
      "README.md": "# ignored",
    };
    const index = await buildSymbolIndex(reader(files), DEFAULT_CTAGS_CAPS, newAgenticUsage());
    expect(index.get("doThing")?.map((d) => d.file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(index.get("Thing")?.[0]).toMatchObject({ file: "src/a.ts", kind: "class" });
    expect(index.has("ignored")).toBe(false);
  });

  it("honors the read/byte budget and marks cappedOut", async () => {
    const files = { "a.ts": "export const aa = 1;", "b.ts": "export const bb = 2;", "c.ts": "export const cc = 3;" };
    const usage = newAgenticUsage();
    const index = await buildSymbolIndex(reader(files), { maxHops: 1, maxFileReads: 1, maxTotalBytes: 1_000_000 }, usage);
    expect(usage.fileReads).toBe(1);
    expect(usage.cappedOut).toBe(true);
    expect([...index.keys()].length).toBe(1);
  });

  it("never throws when the tree listing fails", async () => {
    const failing: RepoReader = { listTree: async () => { throw new Error("boom"); }, readFile: async () => undefined };
    const index = await buildSymbolIndex(failing, DEFAULT_CTAGS_CAPS, newAgenticUsage());
    expect(index.size).toBe(0);
  });
});

describe("renderChangedSymbolDefs", () => {
  const index = new Map([
    ["doThing", [{ name: "doThing", file: "src/a.ts", line: 3, kind: "function" as const, exported: true }]],
    [
      "Thing",
      [
        { name: "Thing", file: "src/a.ts", line: 1, kind: "class" as const, exported: true },
        { name: "Thing", file: "src/b.ts", line: 9, kind: "class" as const, exported: false },
      ],
    ],
  ]);

  it("lists definition locations for the changed symbol names", () => {
    const out = renderChangedSymbolDefs(index, ["doThing", "Thing"]);
    expect(out).toContain("`doThing` — defined at src/a.ts:3 (function)");
    expect(out).toContain("src/a.ts:1 (class), src/b.ts:9 (class)");
  });

  it("returns (none) when no changed name resolves", () => {
    expect(renderChangedSymbolDefs(index, ["nope", "alsoNope"])).toBe("(none)");
    expect(renderChangedSymbolDefs(index, [])).toBe("(none)");
  });

  it("de-duplicates repeated names and respects the char cap", () => {
    const out = renderChangedSymbolDefs(index, ["doThing", "doThing"], { maxChars: 1 });
    // First line already exceeds a 1-char cap → nothing renders.
    expect(out).toBe("(none)");
  });
});
