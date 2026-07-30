import { describe, expect, it } from "vitest";
import type { AnchoredFinding } from "./clamp";
import type { FetchLike } from "./diff";
import type { CommentableMap } from "./clamp";
import { buildReviewPayload, committableRange, formatFindingComment, postReview, renderSuggestionBlock } from "./publish";
import type { Finding } from "./types";

const inline: Finding = {
  severity: "high",
  category: "bug",
  file: "src/app.ts",
  line: 4,
  title: "Wrong operator",
  body: "Subtraction where addition was intended.",
  suggestion: "return a + b;",
};

const fileLevel: Finding = {
  severity: "medium",
  category: "maintainability",
  file: "src/big.ts",
  title: "General concern",
  body: "This module is getting large.",
};

const at = (finding: Finding, placement: AnchoredFinding["placement"]): AnchoredFinding => ({ finding, placement });

describe("formatFindingComment", () => {
  it("includes severity, title, body, and the prose suggestion when present", () => {
    const text = formatFindingComment(inline);
    expect(text).toContain("**[high] Wrong operator**");
    expect(text).toContain("Subtraction where addition was intended.");
    expect(text).toContain("**Suggested fix:**\nreturn a + b;");
  });

  it("omits the suggestion section when absent", () => {
    expect(formatFindingComment(fileLevel)).not.toContain("Suggested fix");
  });

  it("renders a committable ```suggestion block from suggestedLine when committable", () => {
    const f: Finding = { ...inline, suggestedLine: "  return a + b;", suggestion: undefined };
    const text = formatFindingComment(f, true);
    expect(text).toContain("**Suggested fix:**\n```suggestion\n  return a + b;\n```");
  });

  it("does NOT render a suggestion block when not committable (falls back to prose)", () => {
    const f: Finding = { ...inline, suggestedLine: "return a + b;" };
    const text = formatFindingComment(f, false);
    expect(text).not.toContain("```suggestion");
    expect(text).toContain("**Suggested fix:**\nreturn a + b;"); // the prose suggestion
  });

  it("falls back to prose when committable but there is no suggestedLine", () => {
    const text = formatFindingComment(inline, true);
    expect(text).not.toContain("```suggestion");
    expect(text).toContain("**Suggested fix:**\nreturn a + b;");
  });
});

describe("renderSuggestionBlock (backtick-fence escalation)", () => {
  it("uses a 3-backtick fence for ordinary code", () => {
    expect(renderSuggestionBlock("return a + b;")).toBe("```suggestion\nreturn a + b;\n```");
  });

  it("escalates the fence when the code contains a triple-backtick run", () => {
    const code = 'const fence = "```";';
    const block = renderSuggestionBlock(code);
    expect(block).toBe(`\`\`\`\`suggestion\n${code}\n\`\`\`\``); // 4 backticks
    // The inner triple-backtick run is shorter than the fence → won't truncate.
    expect(block.startsWith("````suggestion")).toBe(true);
  });

  it("keeps a 3-backtick fence for lone (non-consecutive) backticks", () => {
    const code = "const s = `a${x}`;";
    expect(renderSuggestionBlock(code)).toBe("```suggestion\n" + code + "\n```");
  });
});

const rangeFinding: Finding = {
  severity: "high",
  category: "bug",
  file: "src/app.ts",
  line: 4, // END of the range
  startLine: 2, // START of the range
  title: "Broken conditional block",
  body: "The 3-line guard is inverted.",
  suggestedRange: "  if (!ok) {\n    return early;\n  }",
  suggestion: "invert the guard",
};

describe("committableRange (feature #18)", () => {
  const commentable: CommentableMap = { "src/app.ts": [2, 3, 4, 9] };

  it("returns the start/end pair when the whole range is exact-commentable", () => {
    expect(committableRange(rangeFinding, commentable)).toEqual({ start: 2, end: 4 });
  });

  it("returns undefined when a line inside the range is NOT commentable (a gap)", () => {
    // 3 is missing → [2..4] is not contiguous on the RIGHT side.
    expect(committableRange(rangeFinding, { "src/app.ts": [2, 4] })).toBeUndefined();
  });

  it("returns undefined when startLine is not strictly before line", () => {
    expect(committableRange({ ...rangeFinding, startLine: 4 }, commentable)).toBeUndefined();
    expect(committableRange({ ...rangeFinding, startLine: 5 }, commentable)).toBeUndefined();
  });

  it("returns undefined without a suggestedRange, a startLine, or a numeric line", () => {
    expect(committableRange({ ...rangeFinding, suggestedRange: undefined }, commentable)).toBeUndefined();
    expect(committableRange({ ...rangeFinding, startLine: undefined }, commentable)).toBeUndefined();
    expect(committableRange({ ...rangeFinding, line: undefined }, commentable)).toBeUndefined();
  });

  it("returns undefined when the file has no commentable lines", () => {
    expect(committableRange(rangeFinding, {})).toBeUndefined();
    expect(committableRange(rangeFinding, { "src/app.ts": [] })).toBeUndefined();
  });
});

describe("formatFindingComment — multi-line range mode (feature #18)", () => {
  it('renders the suggestedRange as a ```suggestion block in "range" mode', () => {
    const text = formatFindingComment(rangeFinding, "range");
    expect(text).toContain("**Suggested fix:**\n```suggestion\n  if (!ok) {\n    return early;\n  }\n```");
  });

  it('falls back to prose in "range" mode when suggestedRange is absent', () => {
    const text = formatFindingComment({ ...rangeFinding, suggestedRange: undefined }, "range");
    expect(text).not.toContain("```suggestion");
    expect(text).toContain("**Suggested fix:**\ninvert the guard");
  });
});

describe("buildReviewPayload", () => {
  it("builds ONE COMMENT review with only line-anchored findings as inline comments", () => {
    const payload = buildReviewPayload("summary text", [at(inline, "line"), at(fileLevel, "file")]);
    expect(payload.event).toBe("COMMENT");
    expect(payload.body).toBe("summary text");
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]).toMatchObject({ path: "src/app.ts", line: 4, side: "RIGHT" });
  });

  it("excludes summary-placement findings from inline comments", () => {
    const orphan: Finding = { ...inline, file: "not-in-diff.ts" };
    const payload = buildReviewPayload("s", [at(orphan, "summary")]);
    expect(payload.comments).toEqual([]);
  });

  it("renders a committable suggestion block ONLY for an exact 'line' anchor", () => {
    const f: Finding = { ...inline, suggestedLine: "return a + b;", suggestion: undefined };
    const exact = buildReviewPayload("s", [at(f, "line")]);
    expect(exact.comments[0].body).toContain("```suggestion\nreturn a + b;\n```");
  });

  it("does NOT render a suggestion block for a clamped 'nearest' anchor", () => {
    // The line was clamped to a different line — a same-line swap would be wrong.
    const f: Finding = { ...inline, suggestedLine: "return a + b;" };
    const nearest = buildReviewPayload("s", [at(f, "nearest")]);
    expect(nearest.comments[0].body).not.toContain("```suggestion");
    expect(nearest.comments[0].body).toContain("**Suggested fix:**\nreturn a + b;"); // prose fallback
  });

  it("builds an empty-comments payload for zero findings (clean PR)", () => {
    const payload = buildReviewPayload("✅ no issues found", []);
    expect(payload.comments).toEqual([]);
    expect(payload.body).toBe("✅ no issues found");
  });

  // ── Multi-line range suggestions (feature #18) ──────────────────────────────
  const commentable: CommentableMap = { "src/app.ts": [2, 3, 4, 9] };

  it("emits a multi-line range comment (start_line/start_side) for a validated range", () => {
    const payload = buildReviewPayload("s", [at(rangeFinding, "line")], commentable);
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]).toMatchObject({
      path: "src/app.ts",
      startLine: 2,
      startSide: "RIGHT",
      line: 4,
      side: "RIGHT",
    });
    expect(payload.comments[0].body).toContain("```suggestion\n  if (!ok) {\n    return early;\n  }\n```");
  });

  it("falls back to a single-line suggestion when the range has a gap (not contiguous)", () => {
    const f: Finding = { ...rangeFinding, suggestedLine: "  return a + b;" };
    const payload = buildReviewPayload("s", [at(f, "line")], { "src/app.ts": [2, 4] });
    expect(payload.comments[0].startLine).toBeUndefined(); // no range emitted
    expect(payload.comments[0].line).toBe(4);
    expect(payload.comments[0].body).toContain("```suggestion\n  return a + b;\n```"); // single-line block
  });

  it("falls back to PROSE when the range is invalid and there is no suggestedLine", () => {
    const payload = buildReviewPayload("s", [at(rangeFinding, "line")], { "src/app.ts": [2, 4] });
    expect(payload.comments[0].startLine).toBeUndefined();
    expect(payload.comments[0].body).not.toContain("```suggestion");
    expect(payload.comments[0].body).toContain("**Suggested fix:**\ninvert the guard");
  });

  it("never emits a range for a clamped 'nearest' anchor even if the range would validate", () => {
    const payload = buildReviewPayload("s", [at(rangeFinding, "nearest")], commentable);
    expect(payload.comments[0].startLine).toBeUndefined();
    expect(payload.comments[0].body).not.toContain("```suggestion");
    expect(payload.comments[0].body).toContain("**Suggested fix:**\ninvert the guard"); // prose fallback
  });

  it("does not emit a range when no commentable map is passed (back-compat default)", () => {
    const payload = buildReviewPayload("s", [at(rangeFinding, "line")]);
    expect(payload.comments[0].startLine).toBeUndefined();
    expect(payload.comments[0].body).toContain("**Suggested fix:**\ninvert the guard");
  });
});

describe("postReview", () => {
  const pr = { owner: "anshace", repo: "demo", prNumber: 3 };
  const payload = buildReviewPayload("s", [at(inline, "line")]);

  it("POSTs the payload to the reviews endpoint exactly once", async () => {
    const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
    const fake: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => "{}" };
    };
    await postReview(pr, "tok", payload, fake);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/anshace/demo/pulls/3/reviews");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers?.authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0].init?.body ?? "")).toEqual(payload);
  });

  it("throws with status and body snippet on failure", async () => {
    const fake: FetchLike = async () => ({
      ok: false,
      status: 422,
      text: async () => "Unprocessable",
    });
    await expect(postReview(pr, "tok", payload, fake)).rejects.toThrow(/HTTP 422 Unprocessable/);
  });
});

import { formatFileLevelSections } from "./publish";

describe("formatFileLevelSections", () => {
  it("groups file-level findings into per-file sections", () => {
    const out = formatFileLevelSections([
      fileLevel,
      { ...fileLevel, title: "Second concern", body: "Also this." },
      { ...fileLevel, file: "src/other.ts", title: "Elsewhere", body: "x" },
    ]);
    expect(out).toContain("**`src/big.ts`** (file-level");
    expect(out).toContain("- **[medium]** General concern: This module is getting large.");
    expect(out).toContain("- **[medium]** Second concern: Also this.");
    expect(out).toContain("**`src/other.ts`**");
  });

  it("returns an empty string for no findings", () => {
    expect(formatFileLevelSections([])).toBe("");
  });
});
