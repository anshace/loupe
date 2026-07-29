import { describe, expect, it } from "vitest";
import { applySuppressions, parseHouseRuleSuppressions } from "./suppress";
import type { Finding } from "./types";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "high",
    category: "bug",
    file: "src/app.ts",
    line: 4,
    title: "Real bug",
    body: "Subtraction where addition was intended.",
    ...overrides,
  };
}

describe("applySuppressions — do-not-report list", () => {
  it("keeps real findings untouched", () => {
    const { kept, suppressed } = applySuppressions([finding()]);
    expect(kept).toHaveLength(1);
    expect(suppressed).toEqual([]);
  });

  it("drops style/formatting nits with an explicit record", () => {
    const style = finding({ category: "style", severity: "nit", title: "Prefer single quotes" });
    const { kept, suppressed } = applySuppressions([style, finding()]);
    expect(kept.map((f) => f.title)).toEqual(["Real bug"]);
    expect(suppressed).toEqual([{ finding: style, reason: "style-nit" }]);
  });

  it("drops speculative might-in-the-future concerns", () => {
    const spec = finding({
      severity: "medium",
      title: "Scaling concern",
      body: "This might eventually be slow if the list grows in the future.",
    });
    const { suppressed } = applySuppressions([spec]);
    expect(suppressed[0]?.reason).toBe("speculative");
  });

  it("drops praise", () => {
    const praise = finding({ severity: "nit", category: "other", title: "Nice refactor here", body: "Clean." });
    expect(applySuppressions([praise]).suppressed[0]?.reason).toBe("praise");
  });

  it("drops TODO-comment suggestions", () => {
    const todo = finding({ severity: "medium", title: "Missing docs", body: "Consider adding a TODO to revisit this." });
    expect(applySuppressions([todo]).suppressed[0]?.reason).toBe("todo-suggestion");
  });
});

describe("applySuppressions — unchanged code", () => {
  const addedLines = { "src/app.ts": [3, 4] as const };

  it("drops sub-high findings on unchanged (context) lines", () => {
    const onContext = finding({ severity: "medium", line: 10 });
    expect(applySuppressions([onContext], { addedLines }).suppressed[0]?.reason).toBe("unchanged-code");
  });

  it("keeps high/critical findings on unchanged lines", () => {
    const highOnContext = finding({ severity: "high", line: 10 });
    expect(applySuppressions([highOnContext], { addedLines }).kept).toHaveLength(1);
  });

  it("keeps sub-high findings on added lines", () => {
    const onAdded = finding({ severity: "medium", line: 4 });
    expect(applySuppressions([onAdded], { addedLines }).kept).toHaveLength(1);
  });

  it("skips the rule when the file's added lines are unknown", () => {
    const other = finding({ severity: "medium", file: "other.ts", line: 10 });
    expect(applySuppressions([other], { addedLines }).kept).toHaveLength(1);
  });
});

describe("applySuppressions — min severity", () => {
  it("drops findings below the threshold with a record", () => {
    const low = finding({ severity: "low", title: "Minor" });
    const { kept, suppressed } = applySuppressions([low, finding()], { minSeverity: "medium" });
    expect(kept.map((f) => f.title)).toEqual(["Real bug"]);
    expect(suppressed).toEqual([{ finding: low, reason: "below-min-severity" }]);
  });
});

describe("house-rule suppression (suppress: convention)", () => {
  const rules = [
    "# House rules",
    "We intentionally use snake_case in this repo.",
    "suppress: snake_case",
    "- suppress: console.log",
    "not a directive: suppress me not",
  ].join("\n");

  it("parses suppress: lines (plain and bulleted)", () => {
    expect(parseHouseRuleSuppressions(rules)).toEqual(["snake_case", "console.log"]);
  });

  it("suppresses findings whose title/body matches a filter, case-insensitively", () => {
    const hit = finding({ title: "Avoid Snake_Case identifiers", body: "b" });
    const miss = finding();
    const { kept, suppressed } = applySuppressions([hit, miss], { houseRules: rules });
    expect(suppressed).toEqual([{ finding: hit, reason: "house-rule" }]);
    expect(kept).toEqual([miss]);
  });

  it("applies no suppression when the house-rules file is absent", () => {
    const wouldHit = finding({ title: "Avoid snake_case" });
    expect(applySuppressions([wouldHit]).kept).toHaveLength(1);
  });
});

describe("accounting invariant", () => {
  it("every input finding is either kept or in the suppression record", () => {
    const inputs = [
      finding(),
      finding({ category: "style", severity: "nit" }),
      finding({ severity: "low" }),
      finding({ title: "uses console.log everywhere", severity: "medium" }),
    ];
    const { kept, suppressed } = applySuppressions(inputs, {
      minSeverity: "medium",
      houseRules: "suppress: console.log",
    });
    expect(kept.length + suppressed.length).toBe(inputs.length);
  });
});
