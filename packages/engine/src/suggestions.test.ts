import { describe, expect, it } from "vitest";
import type { RunLogFeedbackItem } from "./feedback";
import type { RunLogRecord } from "./runlog";
import {
  SUGGESTIONS_MARKER,
  buildSuggestions,
  collectNegativeFindings,
  generateSuggestionsFile,
  renderSuggestionsMarkdown,
} from "./suggestions";

const rec = (pr: string, items: RunLogFeedbackItem[]): RunLogRecord => ({
  pr,
  timestamp: "2026-07-30T00:00:00.000Z",
  model: "mock",
  inputTokens: 0,
  outputTokens: 0,
  estCostUsd: 0,
  findingsKept: 0,
  findingsDropped: 0,
  dropReasons: {},
  verifierDropped: 0,
  abstained: 0,
  verifierUngrounded: 0,
  escalated: false,
  incremental: false,
  feedback: {
    accepted: 0,
    disputed: items.filter((i) => i.class === "disputed").length,
    unresolved: items.filter((i) => i.class === "unresolved").length,
    total: items.length,
    items,
  },
});

describe("collectNegativeFindings (feature #31)", () => {
  it("dedupes the same finding re-read across runs into one negative", () => {
    const item: RunLogFeedbackItem = { path: "src/a.ts", title: "Bug", class: "disputed" };
    const negatives = collectNegativeFindings([rec("o/r#1", [item]), rec("o/r#1", [item]), rec("o/r#1", [item])]);
    expect(negatives).toHaveLength(1);
    expect(negatives[0]).toMatchObject({ pr: "o/r#1", path: "src/a.ts", reason: "disputed" });
  });

  it("counts a persistently-unresolved finding as 'ignored' only past the run threshold", () => {
    const item: RunLogFeedbackItem = { path: "src/a.ts", title: "Nit", class: "unresolved" };
    const twoRuns = collectNegativeFindings([rec("o/r#1", [item]), rec("o/r#1", [item])], { minIgnoredRuns: 3 });
    expect(twoRuns).toHaveLength(0); // seen in 2 runs < 3
    const threeRuns = collectNegativeFindings(
      [rec("o/r#1", [item]), rec("o/r#1", [item]), rec("o/r#1", [item])],
      { minIgnoredRuns: 3 },
    );
    expect(threeRuns).toEqual([{ pr: "o/r#1", path: "src/a.ts", title: "Nit", normTitle: "nit", reason: "ignored" }]);
  });

  it("ignores records without feedback", () => {
    const bare = { ...rec("o/r#1", []), feedback: undefined };
    expect(collectNegativeFindings([bare])).toEqual([]);
  });
});

describe("buildSuggestions (feature #31)", () => {
  it("suggests a directory glob when disputes span multiple files in a dir", () => {
    const negatives = collectNegativeFindings([
      rec("o/r#1", [
        { path: "src/util/x.ts", title: "A", class: "disputed" },
        { path: "src/util/y.ts", title: "B", class: "disputed" },
      ]),
    ]);
    const suggestions = buildSuggestions(negatives, { minSupport: 2 });
    const glob = suggestions.find((s) => s.kind === "ignore-glob");
    expect(glob?.value).toBe("src/util/**");
    expect(glob?.support).toBe(2);
  });

  it("suggests the exact file when disputes concentrate in one file", () => {
    const negatives = collectNegativeFindings([
      rec("o/r#1", [
        { path: "src/a.ts", title: "A", class: "disputed" },
        { path: "src/a.ts", title: "B", class: "disputed" },
      ]),
    ]);
    const glob = buildSuggestions(negatives, { minSupport: 2 }).find((s) => s.kind === "ignore-glob");
    expect(glob?.value).toBe("src/a.ts");
  });

  it("suggests a house-rule suppress line for a title disputed across PRs", () => {
    const negatives = collectNegativeFindings([
      rec("o/r#1", [{ path: "a.ts", title: "Missing null check", class: "disputed" }]),
      rec("o/r#2", [{ path: "b.ts", title: "Missing Null Check!", class: "disputed" }]),
    ]);
    const house = buildSuggestions(negatives, { minSupport: 2 }).find((s) => s.kind === "house-rule");
    expect(house?.value).toBe("suppress: Missing null check");
    expect(house?.rationale).toContain("2 PR(s)");
  });

  it("emits nothing below the support threshold", () => {
    const negatives = collectNegativeFindings([rec("o/r#1", [{ path: "a.ts", title: "Lonely", class: "disputed" }])]);
    expect(buildSuggestions(negatives, { minSupport: 2 })).toEqual([]);
  });
});

describe("renderSuggestionsMarkdown (feature #31)", () => {
  it("renders both sections behind the marker with the never-auto-applied notice", () => {
    const md = renderSuggestionsMarkdown(
      [
        { kind: "ignore-glob", value: "src/gen/**", rationale: "3 disputed", support: 3 },
        { kind: "house-rule", value: "suppress: Add tests", rationale: "disputed on 2", support: 2 },
      ],
      { runs: 4, prs: 2 },
    );
    expect(md.startsWith(SUGGESTIONS_MARKER)).toBe(true);
    expect(md).toContain("suggestions only");
    expect(md).toContain('"src/gen/**"');
    expect(md).toContain("`suppress: Add tests`");
    expect(md).not.toContain("Generated on"); // no timestamp when not provided → deterministic
  });

  it("renders an explicit empty state", () => {
    const md = renderSuggestionsMarkdown([], { runs: 1, prs: 1 });
    expect(md).toContain("No suggestions yet");
  });
});

describe("generateSuggestionsFile (feature #31)", () => {
  it("reads the run log, aggregates, and writes the markdown (injectable IO)", () => {
    const log = [
      rec("o/r#1", [{ path: "src/gen/a.ts", title: "A", class: "disputed" }]),
      rec("o/r#1", [{ path: "src/gen/b.ts", title: "B", class: "disputed" }]),
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    let written: { path: string; content: string } | undefined;
    const result = generateSuggestionsFile(
      "run.log",
      ".aireview-suggestions.md",
      { minSupport: 2 },
      { readFile: () => log, writeFile: (path, content) => (written = { path, content }) },
    );
    expect(result.written).toBe(true);
    expect(result.suggestions.some((s) => s.value === "src/gen/**")).toBe(true);
    expect(written?.path).toBe(".aireview-suggestions.md");
    expect(written?.content).toContain("src/gen/**");
  });

  it("is best-effort: a write failure returns written:false, never throws", () => {
    const result = generateSuggestionsFile(
      "run.log",
      "out.md",
      {},
      {
        readFile: () => "",
        writeFile: () => {
          throw new Error("read-only fs");
        },
      },
    );
    expect(result.written).toBe(false);
  });
});
