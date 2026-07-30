import { describe, expect, it } from "vitest";
import type { RepoReader } from "./agentic";
import {
  discoverRelatedTests,
  extractChangedSymbols,
  isTestFile,
  renderRelatedTests,
  testStem,
} from "./relatedtests";

describe("isTestFile", () => {
  it("recognizes .test/.spec suffixes, __tests__/test(s)/spec dirs, and python test_", () => {
    expect(isTestFile("src/foo.test.ts")).toBe(true);
    expect(isTestFile("src/foo.spec.tsx")).toBe(true);
    expect(isTestFile("src/__tests__/foo.ts")).toBe(true);
    expect(isTestFile("test/foo.ts")).toBe(true);
    expect(isTestFile("tests/foo.py")).toBe(true);
    expect(isTestFile("pkg/test_foo.py")).toBe(true);
  });

  it("does not flag ordinary source files (incl. substrings like 'latest')", () => {
    expect(isTestFile("src/foo.ts")).toBe(false);
    expect(isTestFile("src/latest/foo.ts")).toBe(false);
    expect(isTestFile("src/contest.ts")).toBe(false);
  });
});

describe("testStem", () => {
  it("reduces test paths and source paths to the same comparison stem", () => {
    expect(testStem("src/foo.test.ts")).toBe("foo");
    expect(testStem("a/b/Bar.spec.tsx")).toBe("bar");
    expect(testStem("pkg/test_foo.py")).toBe("foo");
    expect(testStem("src/foo.ts")).toBe("foo");
  });
});

describe("extractChangedSymbols", () => {
  it("extracts function/class/const/interface/def/func names, deduped", () => {
    const syms = extractChangedSymbols([
      "export function parseThing(x) {",
      "const helper = () => {",
      "export class Widget {",
      "interface Opts {",
      "def do_it(self):",
      "func Handle(w http.ResponseWriter) {",
      "export function parseThing(x) {", // dup
    ]);
    expect(syms).toContain("parseThing");
    expect(syms).toContain("helper");
    expect(syms).toContain("Widget");
    expect(syms).toContain("Opts");
    expect(syms).toContain("do_it");
    expect(syms).toContain("Handle");
    expect(syms.filter((s) => s === "parseThing")).toHaveLength(1);
  });
});

function reader(files: Record<string, string>): RepoReader {
  return {
    listTree: async () => Object.keys(files),
    readFile: async (p) => files[p],
  };
}

describe("discoverRelatedTests (report item #17)", () => {
  const REPO = {
    "src/foo.ts": "export function bar() {}",
    "src/foo.test.ts": "import { bar } from './foo';\ntest('bar works', () => { bar(); });",
    "src/baz.ts": "export const thing = 1;",
  };

  it("matches sibling tests and reports which changed symbols they reference", async () => {
    const found = await discoverRelatedTests(
      [
        { path: "src/foo.ts", symbols: ["bar", "qux"] },
        { path: "src/baz.ts", symbols: ["thing"] },
      ],
      reader(REPO),
    );
    const foo = found.find((f) => f.source === "src/foo.ts");
    expect(foo?.tests).toEqual([{ path: "src/foo.test.ts", referencedSymbols: ["bar"] }]);
    // baz has a changed symbol but no sibling test → a coverage gap.
    const baz = found.find((f) => f.source === "src/baz.ts");
    expect(baz?.coverageGap).toBe(true);
    expect(baz?.tests).toEqual([]);
  });

  it("does not seek tests for a file that is itself a test", async () => {
    const found = await discoverRelatedTests([{ path: "src/foo.test.ts", symbols: [] }], reader(REPO));
    expect(found).toEqual([]);
  });

  it("omits a source with no test and no changed symbols (not noteworthy)", async () => {
    const found = await discoverRelatedTests([{ path: "src/baz.ts", symbols: [] }], reader(REPO));
    expect(found).toEqual([]);
  });

  it("is fail-soft when the tree listing throws", async () => {
    const throwing: RepoReader = {
      listTree: async () => {
        throw new Error("no tree");
      },
      readFile: async () => undefined,
    };
    expect(await discoverRelatedTests([{ path: "src/foo.ts", symbols: ["bar"] }], throwing)).toEqual([]);
  });

  it("respects the maxTestReads cap", async () => {
    let reads = 0;
    const counting: RepoReader = {
      listTree: async () => ["src/a.ts", "src/a.test.ts", "src/b.ts", "src/b.test.ts"],
      readFile: async (p) => {
        reads += 1;
        return `references ${p}`;
      },
    };
    await discoverRelatedTests(
      [
        { path: "src/a.ts", symbols: ["x"] },
        { path: "src/b.ts", symbols: ["y"] },
      ],
      counting,
      { maxTestReads: 1 },
    );
    expect(reads).toBe(1);
  });
});

describe("renderRelatedTests", () => {
  it("renders found tests and coverage gaps", () => {
    const out = renderRelatedTests([
      { source: "src/foo.ts", tests: [{ path: "src/foo.test.ts", referencedSymbols: ["bar"] }], coverageGap: false },
      { source: "src/baz.ts", tests: [], coverageGap: true },
    ]);
    expect(out).toContain("- src/foo.ts → src/foo.test.ts (references bar)");
    expect(out).toContain("- src/baz.ts: no sibling test file found");
  });

  it("says (found) when a matched test references no changed symbol", () => {
    const out = renderRelatedTests([
      { source: "a.ts", tests: [{ path: "a.test.ts", referencedSymbols: [] }], coverageGap: false },
    ]);
    expect(out).toContain("(found)");
  });

  it("is (none) for no findings", () => {
    expect(renderRelatedTests([])).toBe("(none)");
  });
});
