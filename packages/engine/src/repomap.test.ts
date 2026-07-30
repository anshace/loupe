import { describe, expect, it } from "vitest";
import { buildRepoMap, exportedSymbolsOf, renderRepoMap, topDirectories } from "./repomap";

describe("topDirectories", () => {
  it("counts blobs per top-level dir, ranked by count then name", () => {
    const tree = ["src/a.ts", "src/b.ts", "src/c.ts", "docs/x.md", "docs/y.md", "README.md"];
    expect(topDirectories(tree)).toEqual([
      { dir: "src", count: 3 },
      { dir: "docs", count: 2 },
      { dir: "(root)", count: 1 },
    ]);
  });

  it("respects the top-N cap", () => {
    const tree = ["a/1", "b/1", "c/1", "d/1"];
    expect(topDirectories(tree, { top: 2 })).toHaveLength(2);
  });
});

describe("exportedSymbolsOf", () => {
  it("returns only exported declarations", () => {
    const file = {
      path: "src/a.ts",
      content: "export function pub() {}\nfunction priv() {}\nexport class Widget {}",
    };
    expect(exportedSymbolsOf(file).sort()).toEqual(["Widget", "pub"]);
  });
});

describe("buildRepoMap + renderRepoMap", () => {
  const tree = ["src/a.ts", "src/b.ts", "test/a.test.ts"];
  const changedFiles = [
    { path: "src/a.ts", content: "export function doThing() {}\nexport const helper = 1;" },
    { path: "src/b.ts", content: "function internal() {}" }, // no exports → omitted
  ];

  it("assembles top dirs + exported symbols from the changed files", () => {
    const map = buildRepoMap({ tree, changedFiles });
    expect(map.dirs[0]).toEqual({ dir: "src", count: 2 });
    expect(map.exported).toEqual([{ file: "src/a.ts", symbols: ["doThing", "helper"] }]);
  });

  it("renders both sections", () => {
    const out = renderRepoMap(buildRepoMap({ tree, changedFiles }));
    expect(out).toContain("Top-level structure:");
    expect(out).toContain("- src/ (2 file(s))");
    expect(out).toContain("Key exported symbols in changed files:");
    expect(out).toContain("- src/a.ts: doThing, helper");
  });

  it("is (none) when there is nothing to show", () => {
    expect(renderRepoMap({ dirs: [], exported: [] })).toBe("(none)");
  });

  it("truncates at the char cap", () => {
    const bigTree = Array.from({ length: 50 }, (_, i) => `d${i}/f.ts`);
    const out = renderRepoMap(buildRepoMap({ tree: bigTree, changedFiles: [] }, { topDirs: 50 }), { maxChars: 80 });
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).toContain("truncated at the cap");
  });
});
