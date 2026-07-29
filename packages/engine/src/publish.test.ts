import { describe, expect, it } from "vitest";
import type { FetchLike } from "./diff";
import { buildReviewPayload, formatFindingComment, postReview } from "./publish";
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

describe("formatFindingComment", () => {
  it("includes severity, title, body, and the suggestion when present", () => {
    const text = formatFindingComment(inline);
    expect(text).toContain("**[high] Wrong operator**");
    expect(text).toContain("Subtraction where addition was intended.");
    expect(text).toContain("**Suggested fix:**\nreturn a + b;");
  });

  it("omits the suggestion section when absent", () => {
    expect(formatFindingComment(fileLevel)).not.toContain("Suggested fix");
  });
});

describe("buildReviewPayload", () => {
  it("builds ONE COMMENT review with only line-anchored findings as inline comments", () => {
    const payload = buildReviewPayload("summary text", [inline, fileLevel]);
    expect(payload.event).toBe("COMMENT");
    expect(payload.body).toBe("summary text");
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0]).toMatchObject({
      path: "src/app.ts",
      line: 4,
      side: "RIGHT",
    });
  });

  it("builds an empty-comments payload for zero findings (clean PR)", () => {
    const payload = buildReviewPayload("✅ no issues found", []);
    expect(payload.comments).toEqual([]);
    expect(payload.body).toBe("✅ no issues found");
  });
});

describe("postReview", () => {
  const pr = { owner: "anshace", repo: "demo", prNumber: 3 };
  const payload = buildReviewPayload("s", [inline]);

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
