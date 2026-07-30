import { describe, expect, it } from "vitest";
import type { DiffFile } from "./diff";
import {
  REVIEWER_FLAGGED_PROMPT_FILE,
  REVIEWER_GROUNDING_FIRST_PROMPT_FILE,
  REVIEWER_PROMPT_FILE,
  buildFewShotExemplars,
  buildSecurityChecklist,
  formatCommentableLines,
  loadPromptTemplate,
  renderPrompt,
  selectReviewerPrompt,
} from "./prompt";

describe("selectReviewerPrompt + few-shot exemplars (report items #14, #26)", () => {
  it("stays on the v9 default when both flags are off", () => {
    expect(selectReviewerPrompt({})).toBe(REVIEWER_PROMPT_FILE);
    expect(selectReviewerPrompt({ fewShotExemplars: false, walkthrough: false })).toBe(REVIEWER_PROMPT_FILE);
  });

  it("switches to v10 when either flag is on", () => {
    expect(selectReviewerPrompt({ fewShotExemplars: true })).toBe(REVIEWER_FLAGGED_PROMPT_FILE);
    expect(selectReviewerPrompt({ walkthrough: true })).toBe(REVIEWER_FLAGGED_PROMPT_FILE);
  });

  it("buildFewShotExemplars is (none) when off and worked examples when on", () => {
    expect(buildFewShotExemplars(false)).toBe("(none)");
    const block = buildFewShotExemplars(true);
    expect(block).toContain("true positive");
    expect(block).toContain("false positive");
  });

  it("the v10 flagged template carries the two flag placeholders AND the v9 context blocks", () => {
    const v10 = loadPromptTemplate(undefined, REVIEWER_FLAGGED_PROMPT_FILE);
    expect(v10).toContain("{{FEWSHOT_EXEMPLARS}}");
    expect(v10).toContain("{{WALKTHROUGH_INSTRUCTION}}");
    expect(v10).toContain("{{RELATED_TESTS}}");
    expect(v10).toContain("{{CODE_HISTORY}}");
  });
});

describe("selectReviewerPrompt + grounding-first experiment (report item #28)", () => {
  it("switches to the reviewer-v12 field-ordering variant when groundingFirst is on", () => {
    expect(selectReviewerPrompt({ groundingFirst: true })).toBe(REVIEWER_GROUNDING_FIRST_PROMPT_FILE);
  });

  it("groundingFirst wins over the flagged blocks (a clean-schema experiment)", () => {
    expect(selectReviewerPrompt({ groundingFirst: true, fewShotExemplars: true, sinkPack: true })).toBe(
      REVIEWER_GROUNDING_FIRST_PROMPT_FILE,
    );
  });

  it("stays on v9 when groundingFirst is off", () => {
    expect(selectReviewerPrompt({ groundingFirst: false })).toBe(REVIEWER_PROMPT_FILE);
  });

  it("the v12 template puts the grounding fields (quote + why) before severity and keeps v9's tokens", () => {
    const v12 = loadPromptTemplate(undefined, REVIEWER_GROUNDING_FIRST_PROMPT_FILE);
    const quoteAt = v12.indexOf('"quote"');
    const whyAt = v12.indexOf('"why"');
    const severityAt = v12.indexOf('"severity"');
    expect(quoteAt).toBeGreaterThanOrEqual(0);
    expect(whyAt).toBeGreaterThan(quoteAt);
    expect(severityAt).toBeGreaterThan(whyAt);
    expect(v12).toContain("{{DIFF}}");
    expect(v12).toContain("{{COMMENTABLE_LINES}}");
    expect(v12).toContain("{{PR_INTENT}}");
  });
});

describe("selectReviewerPrompt + repo-map / ctags-lite (rounding-out items)", () => {
  it("switches to the flagged v13 variant when repoMap or ctagsIndex is on", () => {
    expect(selectReviewerPrompt({ repoMap: true })).toBe(REVIEWER_FLAGGED_PROMPT_FILE);
    expect(selectReviewerPrompt({ ctagsIndex: true })).toBe(REVIEWER_FLAGGED_PROMPT_FILE);
  });

  it("stays on the v9 default when both are off", () => {
    expect(selectReviewerPrompt({ repoMap: false, ctagsIndex: false })).toBe(REVIEWER_PROMPT_FILE);
  });

  it("groundingFirst still wins over repo-map / symbol-index", () => {
    expect(selectReviewerPrompt({ groundingFirst: true, repoMap: true, ctagsIndex: true })).toBe(
      REVIEWER_GROUNDING_FIRST_PROMPT_FILE,
    );
  });

  it("the flagged v13 template carries the new placeholders (and the v11/v9 ones)", () => {
    const v13 = loadPromptTemplate(undefined, REVIEWER_FLAGGED_PROMPT_FILE);
    expect(v13).toContain("{{REPO_MAP}}");
    expect(v13).toContain("{{SYMBOL_INDEX}}");
    expect(v13).toContain("{{SINK_EVIDENCE}}");
    expect(v13).toContain("{{FEWSHOT_EXEMPLARS}}");
    expect(v13).toContain("{{RELATED_TESTS}}");
    expect(v13).toContain("{{CODE_HISTORY}}");
  });
});

describe("loadPromptTemplate", () => {
  it("loads the default reviewer prompt (v9) from the repo prompts/ folder", () => {
    const template = loadPromptTemplate();
    expect(template).toContain("Severity rubric");
    expect(template).toContain("Do NOT report");
    expect(template).toContain("{{DIFF}}");
    expect(template).toContain("{{COMMENTABLE_LINES}}");
    expect(template).toContain("{{HOUSE_RULES}}");
    expect(template).toContain("{{CUSTOM_RULES}}");
    expect(template).toContain("{{CONTEXT}}");
    expect(template).toContain("{{RELATED_TESTS}}");
    expect(template).toContain("{{CODE_HISTORY}}");
    expect(template).toContain("{{RETRIEVED_CONTEXT}}");
    expect(template).toContain("{{PR_INTENT}}");
    expect(template).toContain("{{SECURITY_CHECKLIST}}");
    expect(template).toContain("{{CROSS_FILE_CALLERS}}");
    expect(template).toContain("{{TOOLS}}");
  });

  it("throws a helpful error when the file cannot be found", () => {
    expect(() => loadPromptTemplate("Z:/definitely/not/here.md")).toThrow(/not found/);
  });
});

describe("renderPrompt", () => {
  const template = "SYSTEM {{A}}\n<!-- USER -->\nUSER {{A}} and {{B}}";

  it("splits system/user on the marker and substitutes placeholders", () => {
    const { system, user } = renderPrompt(template, { A: "one", B: "two" });
    expect(system).toBe("SYSTEM one");
    expect(user).toBe("USER one and two");
  });

  it("replaces repeated placeholders everywhere", () => {
    const { user } = renderPrompt("s\n<!-- USER -->\n{{X}} {{X}}", { X: "y" });
    expect(user).toBe("y y");
  });

  it("throws when the template lacks the USER marker", () => {
    expect(() => renderPrompt("no marker", {})).toThrow(/USER/);
  });

  it("renders the real reviewer prompt with diff and lines injected", () => {
    const { system, user } = renderPrompt(loadPromptTemplate(), {
      DIFF: "diff --git a/x b/x",
      COMMENTABLE_LINES: "- x: 1-3",
      HOUSE_RULES: "(none)",
      CUSTOM_RULES: "(none)",
      CONTEXT: "(none)",
      RELATED_TESTS: "(none)",
      CODE_HISTORY: "(none)",
      RETRIEVED_CONTEXT: "(none)",
      PR_INTENT: "(none)",
      SECURITY_CHECKLIST: "(none)",
      CROSS_FILE_CALLERS: "(none)",
      TOOLS: "disabled",
    });
    expect(system).toContain("Severity rubric");
    expect(system).not.toContain("{{");
    expect(user).toContain("diff --git a/x b/x");
    expect(user).toContain("- x: 1-3");
    expect(user).toContain("(none)");
    expect(user).not.toContain("{{");
  });
});

describe("formatCommentableLines", () => {
  function file(path: string, lines: number[]): DiffFile {
    return {
      path,
      oldPath: path,
      status: "modified",
      isBinary: false,
      hunks: [],
      commentableLines: lines,
      rawText: "",
    };
  }

  it("compresses consecutive lines into ranges", () => {
    expect(formatCommentableLines([file("a.ts", [1, 2, 3, 7, 10, 11])])).toBe("- a.ts: 1-3, 7, 10-11");
  });

  it("lists multiple files and skips files with no commentable lines", () => {
    const out = formatCommentableLines([file("a.ts", [5]), file("gone.txt", []), file("b.ts", [1, 2])]);
    expect(out).toBe("- a.ts: 5\n- b.ts: 1-2");
  });

  it("reports when nothing is commentable", () => {
    expect(formatCommentableLines([file("gone.txt", [])])).toBe("(no commentable lines)");
  });
});

describe("buildSecurityChecklist (feature #5)", () => {
  it("emits a per-language checklist only for languages present in the diff", () => {
    const out = buildSecurityChecklist([{ path: "src/a.ts" }, { path: "svc/main.py" }]);
    expect(out).toContain("**TypeScript/JavaScript**");
    expect(out).toContain("**Python**");
    expect(out).toContain("CWE-89");
    expect(out).not.toContain("**Go**");
  });

  it("de-duplicates a language across many files of the same kind", () => {
    const out = buildSecurityChecklist([{ path: "a.ts" }, { path: "b.tsx" }, { path: "c.js" }]);
    expect(out.match(/\*\*TypeScript\/JavaScript\*\*/g)).toHaveLength(1);
  });

  it("returns (none) when no known language is present", () => {
    expect(buildSecurityChecklist([{ path: "README.md" }, { path: "data.csv" }])).toBe("(none)");
    expect(buildSecurityChecklist([])).toBe("(none)");
  });

  it("includes the concurrency / resource-leak classes per language (rounding-out item)", () => {
    const ts = buildSecurityChecklist([{ path: "src/a.ts" }]);
    expect(ts).toContain("floating promises");
    expect(ts).toContain("resource leak");
    expect(ts).toContain("unbounded");

    const go = buildSecurityChecklist([{ path: "svc/main.go" }]);
    expect(go).toContain("goroutine leak");
    expect(go).toContain("data race");

    const py = buildSecurityChecklist([{ path: "svc/main.py" }]);
    expect(py).toContain("asyncio tasks");
    expect(py).toContain("resource leak");
  });
});
