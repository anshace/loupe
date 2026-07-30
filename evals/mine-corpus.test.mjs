import { describe, expect, it } from "vitest";
import {
  buildMinedCase,
  deletedOldLines,
  deriveCategory,
  isCodeFile,
  mineRepo,
  newFileDiff,
  parseFixCommits,
  renderMinedCaseModule,
} from "./mine-corpus.mjs";

describe("isCodeFile (#25)", () => {
  it("accepts reviewable source extensions, rejects docs/config/lockfiles", () => {
    expect(isCodeFile("src/a.ts")).toBe(true);
    expect(isCodeFile("pkg/mod.py")).toBe(true);
    expect(isCodeFile("README.md")).toBe(false);
    expect(isCodeFile("package-lock.json")).toBe(false);
    expect(isCodeFile("LICENSE")).toBe(false);
  });
});

describe("parseFixCommits (#25)", () => {
  it("parses hash + subject from the US-separated git log format", () => {
    const out = parseFixCommits("abc1234\x1ffix: null deref in parser\ndef5678\x1ffix crash on empty input\n");
    expect(out).toEqual([
      { hash: "abc1234", subject: "fix: null deref in parser" },
      { hash: "def5678", subject: "fix crash on empty input" },
    ]);
  });

  it("skips blank and malformed lines", () => {
    const out = parseFixCommits("\nnotacommit\nabc1234\x1ffix thing\n");
    expect(out).toEqual([{ hash: "abc1234", subject: "fix thing" }]);
  });
});

describe("deriveCategory (#25)", () => {
  it("maps subject keywords to a Loupe finding category", () => {
    expect(deriveCategory("fix sql injection in login")).toBe("security");
    expect(deriveCategory("fix memory leak in worker")).toBe("performance");
    expect(deriveCategory("fix typo / rename var")).toBe("maintainability");
    expect(deriveCategory("fix crash on empty input")).toBe("bug");
  });
});

describe("deletedOldLines (#25)", () => {
  it("returns the OLD-side line numbers of deleted (buggy) lines", () => {
    const diff = ["@@ -3,4 +3,4 @@", " ctx-a", "-buggy line", "+fixed line", " ctx-b"].join("\n");
    // old starts at 3: ctx-a=3, buggy=4 (deleted), ctx-b=5 → deleted [4]
    expect(deletedOldLines(diff)).toEqual([4]);
  });

  it("returns [] for an addition-only fix (no anchorable pre-fix line)", () => {
    const diff = ["@@ -2,1 +2,3 @@", " ctx", "+added one", "+added two"].join("\n");
    expect(deletedOldLines(diff)).toEqual([]);
  });

  it("handles multiple hunks and multiple deletions", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      "-a",
      "+A",
      " b",
      "@@ -10,2 +10,2 @@",
      " j",
      "-k",
      "+K",
    ].join("\n");
    expect(deletedOldLines(diff)).toEqual([1, 11]);
  });
});

describe("buildMinedCase (#25)", () => {
  it("reconstructs a pre-fix case with the buggy region as the golden finding", () => {
    const c = buildMinedCase({
      repoLabel: "self",
      hash: "abcdef1234567890",
      subject: "fix null deref",
      file: "src/a.ts",
      preFixContent: "l1\nl2\nl3\nl4\nl5\n",
      buggyOldLines: [4],
    });
    expect(c.name).toBe("mined-self-abcdef12-src_a_ts");
    expect(c.diff).toBe(newFileDiff("src/a.ts", ["l1", "l2", "l3", "l4", "l5"]));
    expect(c.fileContents["src/a.ts"]).toBe("l1\nl2\nl3\nl4\nl5");
    expect(c.expectedFindings).toEqual([{ file: "src/a.ts", lineRange: [4, 4], category: "bug" }]);
    expect(c.source).toEqual({ repo: "self", fixCommit: "abcdef1234567890", subject: "fix null deref" });
    expect("mockResponses" in c).toBe(false); // live-mode case
  });

  it("returns undefined when no buggy line is anchorable in the pre-fix file", () => {
    expect(
      buildMinedCase({ repoLabel: "r", hash: "h", subject: "s", file: "a.ts", preFixContent: "l1\nl2\n", buggyOldLines: [] }),
    ).toBeUndefined();
    expect(
      buildMinedCase({ repoLabel: "r", hash: "h", subject: "s", file: "a.ts", preFixContent: "l1\n", buggyOldLines: [99] }),
    ).toBeUndefined();
  });
});

describe("renderMinedCaseModule (#25)", () => {
  it("emits a valid ES module whose default export is the case JSON", () => {
    const c = buildMinedCase({
      repoLabel: "self",
      hash: "abcdef12",
      subject: "fix bug",
      file: "a.ts",
      preFixContent: "l1\nl2\nl3\n",
      buggyOldLines: [2],
    });
    const src = renderMinedCaseModule(c);
    expect(src).toContain("export default {");
    expect(src).toContain('"name": "mined-self-abcdef12-a_ts"');
    // The JSON portion round-trips.
    const json = JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1));
    expect(json.expectedFindings[0].lineRange).toEqual([2, 2]);
  });
});

describe("mineRepo (#25) — injected git, no real repo / no network", () => {
  function fakeGit(diff, preFix, nameStatus = "M\tsrc/a.ts") {
    return (args) => {
      if (args[0] === "log") return "abc1234def\x1ffix null deref\n"; // valid hex hash
      if (args[0] === "show" && args.includes("--name-status")) return nameStatus + "\n";
      if (args[0] === "diff") return diff;
      if (args[0] === "show") return preFix; // content: ["show", "<hash>^:src/a.ts"]
      return "";
    };
  }

  it("mines one MODIFY code file into a case anchored at the deleted line", () => {
    const diff = ["@@ -1,3 +1,3 @@", " l1", "-bad", "+good", " l3"].join("\n");
    const cases = mineRepo("self", fakeGit(diff, "l1\nbad\nl3\n"));
    expect(cases).toHaveLength(1);
    expect(cases[0].expectedFindings[0]).toEqual({ file: "src/a.ts", lineRange: [2, 2], category: "bug" });
  });

  it("skips non-code files and addition-only fixes", () => {
    // ADDED file (A) + a doc file are ignored; only src/a.ts (M) is considered,
    // but its diff only adds lines → no anchorable bug → 0 cases.
    const addOnly = ["@@ -1,1 +1,2 @@", " l1", "+added"].join("\n");
    const cases = mineRepo("self", fakeGit(addOnly, "l1\n", "M\tsrc/a.ts\nA\tREADME.md"));
    expect(cases).toHaveLength(0);
  });

  it("returns [] when git log throws (not a git repo)", () => {
    const throwing = () => {
      throw new Error("not a git repo");
    };
    expect(mineRepo("x", throwing)).toEqual([]);
  });
});
