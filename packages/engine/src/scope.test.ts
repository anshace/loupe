import { describe, expect, it } from "vitest";
import { RegexScopeExpander, buildContext } from "./scope";

const expander = new RegexScopeExpander();

const TS_FILE = [
  /*  1 */ 'import { x } from "./x";',
  /*  2 */ "",
  /*  3 */ "export function outer(a: number): number {",
  /*  4 */ "  const b = a + 1;",
  /*  5 */ "  return b * 2;",
  /*  6 */ "}",
  /*  7 */ "",
  /*  8 */ "export class Cart {",
  /*  9 */ "  private items: number[] = [];",
  /* 10 */ "",
  /* 11 */ "  add(price: number): void {",
  /* 12 */ "    this.items.push(price);",
  /* 13 */ "  }",
  /* 14 */ "",
  /* 15 */ "  total(): number {",
  /* 16 */ "    return this.items.reduce((s, p) => s + p, 0);",
  /* 17 */ "  }",
  /* 18 */ "}",
  /* 19 */ "",
  /* 20 */ "export const arrow = async (n: number) => {",
  /* 21 */ "  return n + 1;",
  /* 22 */ "};",
].join("\n");

const PY_FILE = [
  /*  1 */ "import os",
  /*  2 */ "",
  /*  3 */ "class Store:",
  /*  4 */ "    def __init__(self):",
  /*  5 */ "        self.items = []",
  /*  6 */ "",
  /*  7 */ "    def add(self, item):",
  /*  8 */ "        self.items.append(item)",
  /*  9 */ "        return len(self.items)",
  /* 10 */ "",
  /* 11 */ "def top_level():",
  /* 12 */ "    return 42",
  /* 13 */ "",
  /* 14 */ "VALUE = 1",
].join("\n");

describe("RegexScopeExpander — TS/JS brace heuristic", () => {
  it("finds the enclosing function of a line inside it", () => {
    expect(expander.expand(TS_FILE, "a.ts", 4, 5)).toEqual({ startLine: 3, endLine: 6 });
  });

  it("finds the innermost method, not the whole class", () => {
    expect(expander.expand(TS_FILE, "a.ts", 12, 12)).toEqual({ startLine: 11, endLine: 13 });
  });

  it("expands to the class when the hunk spans two methods", () => {
    expect(expander.expand(TS_FILE, "a.ts", 12, 16)).toEqual({ startLine: 8, endLine: 18 });
  });

  it("handles arrow-function const declarations", () => {
    expect(expander.expand(TS_FILE, "a.ts", 21, 21)).toEqual({ startLine: 20, endLine: 22 });
  });

  it("returns undefined for module-level lines outside any scope", () => {
    expect(expander.expand(TS_FILE, "a.ts", 1, 1)).toBeUndefined();
  });

  it("ignores braces inside strings and comments", () => {
    const content = [
      "function f() {",
      '  const s = "}{";',
      "  // } stray brace in comment",
      "  return s;",
      "}",
    ].join("\n");
    expect(expander.expand(content, "f.ts", 4, 4)).toEqual({ startLine: 1, endLine: 5 });
  });

  it("returns undefined for unknown languages and out-of-range lines", () => {
    expect(expander.expand(TS_FILE, "a.rb", 4, 5)).toBeUndefined();
    expect(expander.expand(TS_FILE, "a.ts", 999, 999)).toBeUndefined();
  });
});

describe("RegexScopeExpander — Python indent heuristic", () => {
  it("finds the enclosing method", () => {
    expect(expander.expand(PY_FILE, "s.py", 8, 8)).toEqual({ startLine: 7, endLine: 9 });
  });

  it("expands to the class when the hunk spans methods", () => {
    expect(expander.expand(PY_FILE, "s.py", 5, 8)).toEqual({ startLine: 3, endLine: 9 });
  });

  it("uses a def that starts inside the hunk as its own scope", () => {
    expect(expander.expand(PY_FILE, "s.py", 11, 12)).toEqual({ startLine: 11, endLine: 12 });
  });

  it("returns undefined for module-level assignments", () => {
    expect(expander.expand(PY_FILE, "s.py", 14, 14)).toBeUndefined();
  });
});

describe("buildContext", () => {
  it("builds a labeled, line-numbered block per expanded scope", () => {
    const ctx = buildContext(
      [{ path: "a.ts", content: TS_FILE, hunks: [{ newStart: 4, newLines: 1 }] }],
      expander,
    );
    expect(ctx.truncated).toBe(false);
    expect(ctx.text).toContain("### a.ts — enclosing scope, lines 3-6");
    expect(ctx.text).toContain("    3| export function outer(a: number): number {");
    expect(ctx.text).toContain("    6| }");
  });

  it("merges overlapping spans from multiple hunks in the same file", () => {
    const ctx = buildContext(
      [
        {
          path: "a.ts",
          content: TS_FILE,
          hunks: [
            { newStart: 12, newLines: 1 },
            { newStart: 16, newLines: 1 },
          ],
        },
      ],
      expander,
    );
    // Two methods → two separate blocks (11-13 and 15-17), not the class.
    expect(ctx.text).toContain("lines 11-13");
    expect(ctx.text).toContain("lines 15-17");
  });

  it("caps total characters and reports truncation without erroring", () => {
    const ctx = buildContext(
      [{ path: "a.ts", content: TS_FILE, hunks: [{ newStart: 4, newLines: 1 }] }],
      expander,
      { maxTotalChars: 10 },
    );
    expect(ctx.text).toBe("");
    expect(ctx.truncated).toBe(true);
  });

  it("returns empty text when nothing expands", () => {
    const ctx = buildContext(
      [{ path: "a.txt", content: "plain text", hunks: [{ newStart: 1, newLines: 1 }] }],
      expander,
    );
    expect(ctx).toEqual({ text: "", truncated: false });
  });
});
