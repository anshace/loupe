import { describe, expect, it } from "vitest";
import type { ExistingComment } from "./dedupe";
import { dedupeFindings, fetchExistingComments, isDuplicate, normalizeSubstance } from "./dedupe";
import type { FetchLike } from "./diff";
import type { Finding } from "./types";

const finding: Finding = {
  severity: "high",
  category: "bug",
  file: "src/app.ts",
  line: 4,
  title: "Wrong operator",
  body: "Uses - instead of +.",
};

const posted: ExistingComment = {
  path: "src/app.ts",
  line: 4,
  body: "**[high] Wrong operator**\n\nUses - instead of +.",
};

describe("normalizeSubstance", () => {
  it("strips markdown, punctuation, and case", () => {
    expect(normalizeSubstance("**[High] Wrong Operator!**")).toBe("high wrong operator");
  });
});

describe("isDuplicate", () => {
  it("matches same file, same line, same substance", () => {
    expect(isDuplicate(finding, [posted])).toBe(true);
  });

  it("matches a line-ish anchor (within tolerance)", () => {
    expect(isDuplicate({ ...finding, line: 5 }, [posted])).toBe(true);
  });

  it("does not match a distant line", () => {
    expect(isDuplicate({ ...finding, line: 40 }, [posted])).toBe(false);
  });

  it("does not match a different file", () => {
    expect(isDuplicate({ ...finding, file: "src/other.ts" }, [posted])).toBe(false);
  });

  it("does not match different substance", () => {
    expect(isDuplicate({ ...finding, title: "Missing null check" }, [posted])).toBe(false);
  });

  it("matches issue-comment bodies only when they also name the file", () => {
    const oldSummary = { body: "- `src/app.ts` — **[high]** Wrong operator: uses - instead of +." };
    expect(isDuplicate(finding, [oldSummary])).toBe(true);
    const otherFile = { body: "- `src/other.ts` — **[high]** Wrong operator: nope." };
    expect(isDuplicate(finding, [otherFile])).toBe(false);
  });
});

describe("dedupeFindings", () => {
  it("partitions candidates and records every skip", () => {
    const fresh: Finding = { ...finding, file: "src/new.ts", title: "New issue" };
    const { kept, deduped } = dedupeFindings(
      [{ finding }, { finding: fresh }],
      [posted],
    );
    expect(kept.map((c) => c.finding.title)).toEqual(["New issue"]);
    expect(deduped).toEqual([finding]);
  });
});

describe("fetchExistingComments", () => {
  const pr = { owner: "anshace", repo: "demo", prNumber: 5 };

  it("fetches review + issue comments and filters by bot identity", async () => {
    const fake: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes("/pulls/")
          ? JSON.stringify([
              { path: "a.ts", line: 3, body: "bot inline", user: { login: "review-bot" } },
              { path: "a.ts", line: 9, body: "human inline", user: { login: "alice" } },
            ])
          : JSON.stringify([
              { id: 11, body: "bot summary", user: { login: "Review-Bot" } },
              { id: 12, body: "human chatter", user: { login: "alice" } },
            ]),
    });
    const existing = await fetchExistingComments(pr, "tok", fake, "review-bot");
    expect(existing.reviewComments).toEqual([{ path: "a.ts", line: 3, body: "bot inline" }]);
    expect(existing.issueComments).toEqual([{ id: 11, body: "bot summary", user: "Review-Bot" }]);
  });

  it("keeps all comments when no bot identity is configured", async () => {
    const fake: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ id: 1, body: "x", path: "a.ts", user: { login: "anyone" } }]),
    });
    const existing = await fetchExistingComments(pr, "tok", fake);
    expect(existing.reviewComments).toHaveLength(1);
    expect(existing.issueComments).toHaveLength(1);
  });

  it("returns empty lists on API errors or non-JSON — never crashes", async () => {
    const fake: FetchLike = async () => ({ ok: true, status: 200, text: async () => "diff --git nonsense" });
    expect(await fetchExistingComments(pr, "tok", fake)).toEqual({ reviewComments: [], issueComments: [] });

    const failing: FetchLike = async () => {
      throw new Error("network down");
    };
    expect(await fetchExistingComments(pr, "tok", failing)).toEqual({ reviewComments: [], issueComments: [] });
  });
});
