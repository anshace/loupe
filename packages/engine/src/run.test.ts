import { describe, expect, it } from "vitest";
import type { ExistingComments } from "./dedupe";
import type { FetchLike } from "./diff";
import { MULTI_FILE_DIFF, MODIFIED_FILE_DIFF } from "./fixtures";
import { MockProvider } from "./model";
import { buildSummary, runReview } from "./run";
import type { RunDeps } from "./run";
import { SUMMARY_MARKER, renderStateMarker } from "./summary";
import type { AuthToken, EngineConfig, PrIdentity, ReviewPayload } from "./types";

const pr = { owner: "anshace", repo: "demo", prNumber: 5 };

/** fetch stub that serves the given diff for the PR GET. */
function diffFetch(diff: string): FetchLike {
  return async () => ({ ok: true, status: 200, text: async () => diff });
}

const NO_COMMENTS: ExistingComments = { reviewComments: [], issueComments: [] };

interface Captured {
  posts: ReviewPayload[];
  upserts: Array<{ body: string; existingId?: number }>;
  deps: Pick<RunDeps, "post" | "upsertSummary" | "repoFiles" | "existingComments" | "headFiles">;
}

/** Capture both mutations and default to no repo files / no existing comments. */
function capture(): Captured {
  const posts: ReviewPayload[] = [];
  const upserts: Array<{ body: string; existingId?: number }> = [];
  return {
    posts,
    upserts,
    deps: {
      post: async (_pr: PrIdentity, _auth: AuthToken, payload: ReviewPayload) => {
        posts.push(payload);
      },
      upsertSummary: async (_pr, _auth, body, existingId) => {
        upserts.push({ body, existingId });
      },
      repoFiles: {},
      existingComments: NO_COMMENTS,
      headFiles: {},
    },
  };
}

function run(config: EngineConfig, deps: RunDeps) {
  return runReview(pr, "tok", config, deps);
}

describe("runReview — pipeline", () => {
  it("runs the full pipeline: one batched review + one summary comment", async () => {
    const model = new MockProvider(
      JSON.stringify([
        {
          severity: "high",
          category: "bug",
          file: "src/app.ts",
          line: 4,
          title: "Wrong operator",
          body: "Uses - instead of +.",
        },
      ]),
      { inputTokens: 100, outputTokens: 20 },
    );
    const { posts, upserts, deps } = capture();

    const result = await run({ event: { headSha: "abc123" } }, { ...deps, fetchImpl: diffFetch(MULTI_FILE_DIFF), model });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].line).toBe(4);
    expect(result.degraded).toBe(false);
    expect(result.posted).toBe(true);
    expect(result.usage).toEqual({ model: "mock", inputTokens: 100, outputTokens: 20 });

    // Exactly one review, batched.
    expect(posts).toHaveLength(1);
    expect(posts[0].event).toBe("COMMENT");
    expect(posts[0].comments).toEqual([
      expect.objectContaining({ path: "src/app.ts", line: 4, side: "RIGHT" }),
    ]);

    // Exactly one summary comment, created (no existing marker), with state.
    expect(upserts).toHaveLength(1);
    expect(upserts[0].existingId).toBeUndefined();
    expect(upserts[0].body).toContain(SUMMARY_MARKER);
    expect(upserts[0].body).toContain('"sha":"abc123"');

    // Noise files were filtered and disclosed (binary + lockfile from the fixture).
    expect(result.skippedFiles).toEqual([
      { file: "logo.png", reason: "binary" },
      { file: "package-lock.json", reason: "lockfile" },
    ]);
    expect(result.summary).toContain("logo.png");
    expect(upserts[0].body).toContain("package-lock.json");

    // The model saw only kept files, their commentable lines, and no house rules.
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].user).toContain("src/app.ts");
    expect(model.requests[0].user).not.toContain("package-lock.json");
    expect(model.requests[0].user).toContain("- src/app.ts: 1-7");
    expect(model.requests[0].user).toContain("(none)");
    expect(model.requests[0].system).toContain("Severity rubric");
    expect(model.requests[0].system).toContain("Do NOT report");
  });

  it("posts a clean-PR review with the ✅ summary and zero comments", async () => {
    const { posts, upserts, deps } = capture();
    const result = await run({}, { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model: new MockProvider("[]") });
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain("✅ no issues found");
    expect(posts).toHaveLength(1);
    expect(posts[0].comments).toEqual([]);
    expect(upserts[0].body).toContain("✅ no issues found");
  });

  it("degrades to a summary-only review on unparseable model output — never crashes", async () => {
    const { posts, upserts, deps } = capture();
    const result = await run(
      {},
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model: new MockProvider("Sorry, I had a moment.") },
    );
    expect(result.degraded).toBe(true);
    expect(result.findings).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain("could not be parsed");
    expect(upserts[0].body).toContain("could not be parsed");
  });

  it("anchors via the fallback chain: nearest line inline, unknown file in the summary comment", async () => {
    const model = new MockProvider(
      JSON.stringify([
        { severity: "high", category: "bug", file: "src/app.ts", line: 9, title: "Near", body: "b" },
        { severity: "high", category: "bug", file: "not-in-diff.ts", line: 1, title: "Far away", body: "b" },
      ]),
    );
    const { posts, upserts, deps } = capture();
    const result = await run({}, { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model });

    expect(result.findings.map((f) => f.line)).toEqual([7, undefined]); // 9 → nearest commentable 7
    expect(posts[0].comments).toHaveLength(1);
    expect(posts[0].comments[0].line).toBe(7);
    // The unattachable finding lands in the summary comment — not dropped.
    expect(result.summaryFindings.map((f) => f.title)).toEqual(["Far away"]);
    expect(upserts[0].body).toContain("not-in-diff.ts");
  });

  it("applies size caps and disclosure without calling the model when nothing is reviewable", async () => {
    const model = new MockProvider("[]");
    const { posts, upserts, deps } = capture();
    const result = await run(
      { sizeCap: { maxFileChars: 10 } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    expect(model.requests).toHaveLength(0);
    expect(result.exclusions).toHaveLength(1);
    expect(result.exclusions[0].file).toBe("src/app.ts");
    expect(result.usage).toBeUndefined();
    expect(posts[0].body).toContain("Not reviewed");
    expect(upserts[0].body).toContain("Not reviewed");
  });

  it("dryRun builds everything but posts nothing", async () => {
    const { posts, upserts, deps } = capture();
    const result = await run(
      { dryRun: true },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model: new MockProvider("[]") },
    );
    expect(result.posted).toBe(false);
    expect(result.payload.body).toContain("✅ no issues found");
    expect(posts).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  it("accounts for EVERY guardrail finding — nothing is silently dropped", async () => {
    const model = new MockProvider(
      JSON.stringify([
        { severity: "high", category: "bug", file: "src/app.ts", line: 4, title: "Inline keeper", body: "b" },
        { severity: "high", category: "bug", file: "src/app.ts", line: 400, title: "File-level keeper", body: "b" },
        { severity: "high", category: "bug", file: "mystery.ts", line: 1, title: "Summary keeper", body: "b" },
        { severity: "nit", category: "style", file: "src/app.ts", line: 3, title: "Style nit", body: "b" },
        { severity: "low", category: "bug", file: "src/app.ts", line: 4, title: "Below threshold", body: "b" },
        { severity: "high", category: "bug", file: "src/app.ts", line: 7, title: "Already reported", body: "b" },
      ]),
    );
    const { posts, upserts, deps } = capture();
    const existingComments: ExistingComments = {
      reviewComments: [{ path: "src/app.ts", line: 7, body: "**[high] Already reported**\n\nb" }],
      issueComments: [],
    };
    const result = await run({}, { ...deps, existingComments, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model });

    const inline = posts[0].comments.map((c) => c.body);
    expect(inline.some((b) => b.includes("Inline keeper"))).toBe(true);
    expect(posts[0].body).toContain("File-level keeper");
    expect(upserts[0].body).toContain("Summary keeper");
    expect(result.suppressed.map((s) => s.finding.title).sort()).toEqual(["Below threshold", "Style nit"]);
    expect(result.deduped.map((f) => f.title)).toEqual(["Already reported"]);
    expect(upserts[0].body).toContain("Still open from previous runs");

    // Total accounting: 6 in, 6 accounted for.
    const accounted =
      posts[0].comments.length + // inline
      1 + // file-level (in review body)
      result.summaryFindings.length +
      result.suppressed.length +
      result.deduped.length;
    expect(accounted).toBe(6);
  });
});

describe("runReview — gate (4.5)", () => {
  const model = new MockProvider("[]");

  it("skips draft PRs with no comments at all", async () => {
    const { posts, upserts, deps } = capture();
    const result = await run({ event: { isDraft: true } }, { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model });
    expect(result.skipped?.reason).toMatch(/draft/);
    expect(result.posted).toBe(false);
    expect(posts).toHaveLength(0);
    expect(upserts).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
  });

  it("skips events whose actor is the bot", async () => {
    const { posts, deps } = capture();
    const result = await run(
      { botIdentity: "review-bot", event: { actor: "review-bot" } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    expect(result.skipped?.reason).toMatch(/bot/);
    expect(posts).toHaveLength(0);
  });

  it("skips when the head SHA matches the state recorded in the summary marker", async () => {
    const { posts, deps } = capture();
    const existingComments: ExistingComments = {
      reviewComments: [],
      issueComments: [{ id: 1, body: `${SUMMARY_MARKER}\n\nold\n\n${renderStateMarker({ sha: "abc123" })}` }],
    };
    const result = await run(
      { event: { headSha: "abc123" } },
      { ...deps, existingComments, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    expect(result.skipped?.reason).toContain("abc123");
    expect(posts).toHaveLength(0);
  });

  it("onDemand overrides the same-SHA skip", async () => {
    const { posts, deps } = capture();
    const existingComments: ExistingComments = {
      reviewComments: [],
      issueComments: [{ id: 1, body: `${SUMMARY_MARKER} ${renderStateMarker({ sha: "abc123" })}` }],
    };
    const result = await run(
      { event: { headSha: "abc123", onDemand: true } },
      { ...deps, existingComments, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model: new MockProvider("[]") },
    );
    expect(result.skipped).toBeUndefined();
    expect(posts).toHaveLength(1);
  });
});

describe("runReview — repo config (4.6–4.8)", () => {
  it("disabled repo → run ends before any model call, no comments at all", async () => {
    const model = new MockProvider("[]");
    const { posts, upserts, deps } = capture();
    const result = await run(
      {},
      { ...deps, repoFiles: { config: "enabled = false" }, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    expect(result.skipped?.reason).toMatch(/disabled/);
    expect(model.requests).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(upserts).toHaveLength(0);
  });

  it("config min_severity: below-threshold findings appear neither inline nor in the summary", async () => {
    const model = new MockProvider(
      JSON.stringify([
        { severity: "medium", category: "bug", file: "src/app.ts", line: 3, title: "Mediocre", body: "b" },
        { severity: "high", category: "bug", file: "src/app.ts", line: 4, title: "Serious", body: "b" },
      ]),
    );
    const { posts, upserts, deps } = capture();
    const result = await run(
      {},
      { ...deps, repoFiles: { config: 'min_severity = "high"' }, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    expect(result.findings.map((f) => f.title)).toEqual(["Serious"]);
    expect(posts[0].comments).toHaveLength(1);
    expect(posts[0].body).not.toContain("Mediocre");
    expect(upserts[0].body).not.toContain("Mediocre");
    expect(result.suppressed).toEqual([
      { finding: expect.objectContaining({ title: "Mediocre" }), reason: "below-min-severity" },
    ]);
  });

  it("ignored globs exclude files from review entirely, with a distinct reason", async () => {
    const model = new MockProvider(
      JSON.stringify([
        { severity: "high", category: "bug", file: "src/app.ts", line: 4, title: "Sneaky", body: "b" },
      ]),
    );
    const { upserts, deps } = capture();
    const result = await run(
      {},
      { ...deps, repoFiles: { config: 'ignore = ["src/**"]' }, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    // The file never reached the model...
    expect(model.requests).toHaveLength(0);
    expect(result.skippedFiles).toEqual([{ file: "src/app.ts", reason: "ignored" }]);
    expect(upserts[0].body).toContain("(ignored)");
    // ...and no finding was reported against it.
    expect(result.findings).toEqual([]);
  });

  it("findings against ignored files are suppressed even if the model emits them", async () => {
    const model = new MockProvider(
      JSON.stringify([
        { severity: "high", category: "bug", file: "added.txt", line: 1, title: "Real", body: "b" },
        { severity: "critical", category: "bug", file: "vendor-ish/x.ts", line: 1, title: "Ghost", body: "b" },
      ]),
    );
    const { posts, upserts, deps } = capture();
    const result = await run(
      {},
      { ...deps, repoFiles: { config: 'ignore = ["vendor-ish/**"]' }, fetchImpl: diffFetch(MULTI_FILE_DIFF), model },
    );
    expect(result.suppressed).toContainEqual({
      finding: expect.objectContaining({ title: "Ghost" }),
      reason: "ignored-file",
    });
    expect(posts[0].body).not.toContain("Ghost");
    expect(upserts[0].body).not.toContain("Ghost");
  });

  it("missing config file → documented defaults, no notice", async () => {
    const { upserts, deps } = capture();
    const result = await run({}, { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model: new MockProvider("[]") });
    expect(result.notices).toEqual([]);
    expect(upserts).toHaveLength(1);
  });

  it("malformed config → run proceeds on defaults with a visible summary notice", async () => {
    const model = new MockProvider("[]");
    const { posts, upserts, deps } = capture();
    const result = await run(
      {},
      { ...deps, repoFiles: { config: "enabled = maybe???" }, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    expect(result.skipped).toBeUndefined();
    expect(model.requests).toHaveLength(1); // the review still ran
    expect(result.notices.some((n) => n.includes("invalid .aireview.toml"))).toBe(true);
    expect(upserts[0].body).toContain("⚠️ invalid .aireview.toml");
    expect(posts).toHaveLength(1);
  });

  it("fetches config and house rules from the PR head via the contents API", async () => {
    const urls: string[] = [];
    const router: FetchLike = async (url) => {
      urls.push(url);
      if (url.includes("/contents/.aireview.toml")) {
        return { ok: true, status: 200, text: async () => 'min_severity = "nit"' };
      }
      if (url.includes("/contents/HOUSE_RULES.md")) {
        return { ok: false, status: 404, text: async () => "Not Found" };
      }
      return { ok: true, status: 200, text: async () => MODIFIED_FILE_DIFF };
    };
    const { deps } = capture();
    delete deps.repoFiles; // exercise real loading
    const model = new MockProvider(
      JSON.stringify([{ severity: "low", category: "bug", file: "src/app.ts", line: 4, title: "Lowly", body: "b" }]),
    );
    const result = await run({ event: { headSha: "feedface" } }, { ...deps, fetchImpl: router, model });
    expect(urls.some((u) => u.includes("/contents/.aireview.toml?ref=feedface"))).toBe(true);
    expect(urls.some((u) => u.includes("/contents/HOUSE_RULES.md?ref=feedface"))).toBe(true);
    // min_severity "nit" from the fetched config took effect (low ≥ nit → kept).
    expect(result.findings.map((f) => f.title)).toEqual(["Lowly"]);
  });
});

describe("runReview — committable suggestions & summary polish (features #7, #9)", () => {
  it("renders a committable ```suggestion block for an exact-anchor finding (#7)", async () => {
    const model = new MockProvider(
      JSON.stringify([
        {
          severity: "high",
          category: "bug",
          file: "src/app.ts",
          line: 4,
          title: "Wrong operator",
          body: "Uses - instead of +.",
          suggestedLine: "  return a + b;",
        },
      ]),
    );
    const { posts, deps } = capture();
    await run({ event: { headSha: "abc123" } }, { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model });
    expect(posts[0].comments[0].line).toBe(4);
    expect(posts[0].comments[0].body).toContain("```suggestion\n  return a + b;\n```");
  });

  it("does NOT emit a suggestion block when the anchor was clamped to a nearest line (#7)", async () => {
    const model = new MockProvider(
      JSON.stringify([
        {
          severity: "high",
          category: "bug",
          file: "src/app.ts",
          line: 9, // not commentable → clamps to nearest (7)
          title: "Wrong operator",
          body: "b",
          suggestedLine: "return a + b;",
        },
      ]),
    );
    const { posts, deps } = capture();
    await run({ event: { headSha: "abc123" } }, { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model });
    expect(posts[0].comments[0].line).toBe(7); // clamped
    expect(posts[0].comments[0].body).not.toContain("```suggestion");
  });

  it("adds a severity table, a risk verdict, and blob permalinks to the summary (#9)", async () => {
    const model = new MockProvider(
      JSON.stringify([
        { severity: "high", category: "bug", file: "src/app.ts", line: 4, title: "Wrong operator", body: "b" },
      ]),
    );
    const { upserts, deps } = capture();
    await run({ event: { headSha: "abc123" } }, { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model });
    const body = upserts[0].body;
    expect(body).toContain("| Severity | Location | Category | Finding |");
    expect(body).toContain("**Risk:**");
    expect(body).toContain("**Est. review effort:**");
    expect(body).toContain("https://github.com/anshace/demo/blob/abc123/src/app.ts#L4");
  });
});

describe("runReview — house rules (4.9)", () => {
  const HOUSE_RULES = "We intentionally use magic numbers in tests.\nsuppress: magic number";

  it("injects HOUSE_RULES.md into the prompt as a delimited block", async () => {
    const model = new MockProvider("[]");
    const { deps } = capture();
    await run({}, { ...deps, repoFiles: { houseRules: HOUSE_RULES }, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model });
    expect(model.requests[0].user).toContain("<house-rules>");
    expect(model.requests[0].user).toContain("We intentionally use magic numbers");
  });

  it("suppresses findings matching a `suppress:` house-rule filter before publishing", async () => {
    const model = new MockProvider(
      JSON.stringify([
        { severity: "high", category: "bug", file: "src/app.ts", line: 4, title: "Magic number used", body: "b" },
        { severity: "high", category: "bug", file: "src/app.ts", line: 3, title: "Actual bug", body: "b" },
      ]),
    );
    const { posts, deps } = capture();
    const result = await run(
      {},
      { ...deps, repoFiles: { houseRules: HOUSE_RULES }, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    expect(result.suppressed).toEqual([
      { finding: expect.objectContaining({ title: "Magic number used" }), reason: "house-rule" },
    ]);
    expect(posts[0].comments).toHaveLength(1);
    expect(posts[0].comments[0].body).toContain("Actual bug");
  });

  it("absent house rules → block says (none), no suppression", async () => {
    const model = new MockProvider("[]");
    const { deps } = capture();
    await run({}, { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model });
    expect(model.requests[0].user).toContain("(none)");
  });
});

describe("runReview — dedupe & summary upsert (4.3/4.4)", () => {
  it("skips findings that duplicate existing bot comments and lists them still open", async () => {
    const model = new MockProvider(
      JSON.stringify([
        { severity: "high", category: "bug", file: "src/app.ts", line: 4, title: "Wrong operator", body: "b" },
      ]),
    );
    const { posts, upserts, deps } = capture();
    const existingComments: ExistingComments = {
      reviewComments: [{ path: "src/app.ts", line: 4, body: "**[high] Wrong operator**\n\nb" }],
      issueComments: [],
    };
    const result = await run({}, { ...deps, existingComments, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model });
    expect(posts[0].comments).toHaveLength(0);
    expect(result.deduped.map((f) => f.title)).toEqual(["Wrong operator"]);
    expect(upserts[0].body).toContain("Still open from previous runs");
    expect(upserts[0].body).toContain("Wrong operator");
  });

  it("edits the existing marker comment in place instead of creating a second one", async () => {
    const { upserts, deps } = capture();
    const existingComments: ExistingComments = {
      reviewComments: [],
      issueComments: [
        { id: 7, body: "some other comment" },
        { id: 42, body: `${SUMMARY_MARKER}\n\nold summary\n\n${renderStateMarker({ sha: "old" })}` },
      ],
    };
    await run(
      { event: { headSha: "newsha" } },
      { ...deps, existingComments, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model: new MockProvider("[]") },
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0].existingId).toBe(42);
    expect(upserts[0].body).toContain('"sha":"newsha"');
  });
});

describe("runReview — cost caps (4.11)", () => {
  it("stops before the model call when the cap is already unreachable and discloses the early stop", async () => {
    const model = new MockProvider("[]");
    const { posts, upserts, deps } = capture();
    const result = await run(
      { tokenCaps: { maxInputTokens: 0 } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    expect(model.requests).toHaveLength(0);
    expect(result.earlyStop).toBe(true);
    expect(upserts[0].body).toContain("stopped early");
    expect(posts).toHaveLength(1); // what exists is still published
  });

  it("flags earlyStop when real usage exceeds the cap mid-run", async () => {
    const model = new MockProvider(
      JSON.stringify([{ severity: "high", category: "bug", file: "src/app.ts", line: 4, title: "Bug", body: "b" }]),
      { inputTokens: 5_000, outputTokens: 900 },
    );
    const { posts, upserts, deps } = capture();
    const result = await run(
      { tokenCaps: { maxInputTokens: 1_000 } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    expect(result.earlyStop).toBe(true);
    // Findings produced so far are still published, with the notice.
    expect(posts[0].comments).toHaveLength(1);
    expect(upserts[0].body).toContain("stopped early");
  });

  it("degrades to the free-tier provider when the monthly budget is exceeded", async () => {
    const urls: string[] = [];
    const router: FetchLike = async (url) => {
      urls.push(url);
      if (url.includes("generativelanguage.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: "[]" }] } }],
              usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
            }),
        };
      }
      return { ok: true, status: 200, text: async () => MODIFIED_FILE_DIFF };
    };
    const { deps } = capture();
    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    try {
      const result = await run(
        { ledgerPath: "ledger.json" },
        {
          ...deps,
          fetchImpl: router,
          env: { REVIEW_MODEL: "haiku", REVIEW_MONTHLY_BUDGET_USD: "5" },
          ledgerIo: {
            readFile: () => JSON.stringify({ "2026-07": 9.99 }),
            writeFile: () => undefined,
          },
          now: () => new Date("2026-07-29T00:00:00Z"),
        },
      );
      expect(urls.some((u) => u.includes("generativelanguage.googleapis.com"))).toBe(true);
      expect(urls.some((u) => u.includes("api.anthropic.com"))).toBe(false);
      expect(result.notices.some((n) => n.includes("monthly budget exceeded"))).toBe(true);
      expect(result.usage?.model).toBe("gemini-2.5-flash");
    } finally {
      if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
      else delete process.env.GEMINI_API_KEY;
    }
  });

  it("records real spend to the ledger after a paid-provider run", async () => {
    const router: FetchLike = async (url) => {
      if (url.includes("api.anthropic.com")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              content: [{ type: "text", text: "[]" }],
              usage: { input_tokens: 1_000_000, output_tokens: 0 },
            }),
        };
      }
      return { ok: true, status: 200, text: async () => MODIFIED_FILE_DIFF };
    };
    const writes: Array<{ path: string; content: string }> = [];
    const { deps } = capture();
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      await run(
        { ledgerPath: "ledger.json" },
        {
          ...deps,
          fetchImpl: router,
          env: { REVIEW_MODEL: "haiku" },
          ledgerIo: {
            readFile: () => {
              throw new Error("ENOENT");
            },
            writeFile: (path, content) => {
              writes.push({ path, content });
            },
          },
          now: () => new Date("2026-07-29T00:00:00Z"),
        },
      );
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0].content)).toEqual({ "2026-07": 1 }); // 1M input tokens @ $1/Mtok
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

/** A model that returns a scripted response per successive call. */
class ScriptedModel {
  readonly name = "mock";
  readonly requests: Array<{ system: string; user: string; temperature?: number }> = [];
  private i = 0;
  constructor(private readonly scripts: string[]) {}
  async complete(req: { system: string; user: string; temperature?: number }) {
    this.requests.push(req);
    const text = this.scripts[Math.min(this.i, this.scripts.length - 1)];
    this.i += 1;
    return { text, inputTokens: 10, outputTokens: 5 };
  }
}

const CRIT_FINDING = JSON.stringify([
  { severity: "critical", category: "security", file: "src/app.ts", line: 4, title: "Auth bypass", body: "b" },
]);

describe("runReview — Tier 2 precision flags (reports #13–#15, #26)", () => {
  it("all four flags default OFF: v7 reviewer, bare array, no walkthrough/demotion", async () => {
    const { deps } = capture();
    const model = new MockProvider(CRIT_FINDING, { inputTokens: 10, outputTokens: 5 });
    const result = await run(
      { event: { headSha: "abc" } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    expect(result.findings[0].severity).toBe("critical"); // not demoted
    expect(result.walkthrough).toBeUndefined();
    expect(model.requests).toHaveLength(1); // no resampling
    // Default reviewer prompt (v7) has no few-shot examples section.
    expect(model.requests[0].user).not.toContain("true positive");
  });

  it("#14 few-shot: injects exemplars into the reviewer prompt", async () => {
    const { deps } = capture();
    const model = new MockProvider("[]");
    await run(
      { fewShotExemplars: true, event: { headSha: "abc" } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    expect(model.requests[0].user).toContain("true positive");
    expect(model.requests[0].user).toContain("false positive");
  });

  it("#26 walkthrough: parses the sibling field and renders it in the summary", async () => {
    const { upserts, deps } = capture();
    const model = new MockProvider(
      JSON.stringify({
        walkthrough: "Refactors add() and exports VERSION.",
        findings: [{ severity: "low", category: "bug", file: "src/app.ts", line: 4, title: "t", body: "b" }],
      }),
    );
    const result = await run(
      { walkthrough: true, event: { headSha: "abc" } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    expect(model.requests[0].system).toContain("walkthrough");
    expect(result.walkthrough).toBe("Refactors add() and exports VERSION.");
    expect(upserts[0].body).toContain("Refactors add() and exports VERSION.");
  });

  it("#15 self-consistency: demotes a critical finding no resample reproduces", async () => {
    const { deps } = capture();
    // Original pass + 2 resamples: resamples find nothing → critical → high.
    const model = new ScriptedModel([CRIT_FINDING, "[]", "[]"]);
    const result = await run(
      { selfConsistency: true, event: { headSha: "abc" } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model: model as unknown as MockProvider },
    );
    expect(model.requests).toHaveLength(3); // 1 + 2 resamples
    expect(model.requests[1].temperature).toBeGreaterThan(0); // resamples at temp>0
    expect(result.findings[0].severity).toBe("high"); // demoted, not dropped
    expect(result.notices.some((n) => n.includes("self-consistency: demoted"))).toBe(true);
  });

  it("#15 self-consistency: keeps a finding the resamples reproduce", async () => {
    const { deps } = capture();
    const model = new ScriptedModel([CRIT_FINDING, CRIT_FINDING, CRIT_FINDING]);
    const result = await run(
      { selfConsistency: true, event: { headSha: "abc" } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model: model as unknown as MockProvider },
    );
    expect(result.findings[0].severity).toBe("critical"); // reproduced → kept
    expect(result.notices.some((n) => n.includes("self-consistency: demoted"))).toBe(false);
  });

  it("#13 chain-of-verification: the verifier stage completes with the v3 prompt loaded", async () => {
    const { deps } = capture();
    const model = new MockProvider(CRIT_FINDING);
    const result = await run(
      { verify: true, chainOfVerification: true, event: { headSha: "abc" } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model },
    );
    // The run reaches the verifier stage without error (fail-open on odd output).
    expect(result.posted).toBe(true);
    // The shipped v3 file carries the CoVe instruction the flag selects.
    const { loadPromptTemplate } = await import("./prompt");
    expect(loadPromptTemplate(undefined, "verifier-v3.md")).toContain("Chain of verification");
  });
});

describe("runReview — Batch 2 context & recall (reports #17, #20, #16)", () => {
  // A repo reader exposing a sibling test for src/app.ts (the fixture's file).
  function testTreeReader() {
    const REPO: Record<string, string> = {
      "src/app.ts": "export function add() {}",
      "src/app.test.ts": "import { add } from './app';\ntest('add', () => { add(); });",
    };
    return {
      listTree: async () => Object.keys(REPO),
      readFile: async (p: string) => REPO[p],
    };
  }

  it("#17 related-tests: default ON injects the discovered sibling test into the reviewer prompt", async () => {
    const { deps } = capture();
    const model = new MockProvider("[]");
    await run(
      { event: { headSha: "abc" } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model, repoReader: testTreeReader() },
    );
    expect(model.requests[0].user).toContain("src/app.ts → src/app.test.ts");
    // MODIFIED_FILE_DIFF adds `export function add(...)`, which the test references.
    expect(model.requests[0].user).toContain("references add");
  });

  it("#17 related-tests: can be turned OFF", async () => {
    const { deps } = capture();
    const model = new MockProvider("[]");
    await run(
      { relatedTests: false, event: { headSha: "abc" } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model, repoReader: testTreeReader() },
    );
    expect(model.requests[0].user).not.toContain("src/app.test.ts");
  });

  it("#20 history: default OFF makes no blame call", async () => {
    const urls: string[] = [];
    const router: FetchLike = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => MODIFIED_FILE_DIFF };
    };
    const { deps } = capture();
    await run({ event: { headSha: "abc" } }, { ...deps, fetchImpl: router, model: new MockProvider("[]") });
    expect(urls.some((u) => u.includes("/graphql"))).toBe(false);
  });

  it("#20 history: when ON, injects a blame summary into the reviewer prompt", async () => {
    const router: FetchLike = async (url) => {
      if (url.includes("/graphql")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: {
                repository: {
                  object: {
                    blame: {
                      ranges: [
                        {
                          startingLine: 1,
                          endingLine: 7,
                          commit: { oid: "abcdef1", committedDate: "2026-07-29T00:00:00Z", author: { name: "Alice" } },
                        },
                      ],
                    },
                  },
                },
              },
            }),
        };
      }
      return { ok: true, status: 200, text: async () => MODIFIED_FILE_DIFF };
    };
    const { deps } = capture();
    const model = new MockProvider("[]");
    await run(
      { historyContext: true, event: { headSha: "abc" } },
      { ...deps, fetchImpl: router, model, now: () => new Date("2026-07-30T00:00:00Z") },
    );
    expect(model.requests[0].user).toContain("last touched 1 day ago");
    expect(model.requests[0].user).toContain("by 1 author");
  });

  it("#16 CI ingestion: injects lint diagnostics as verifier ground truth, not into the reviewer", async () => {
    const { deps } = capture();
    const model = new MockProvider(CRIT_FINDING);
    const eslint = JSON.stringify([
      { filePath: "/x/src/app.ts", messages: [{ ruleId: "no-unused-vars", severity: 2, message: "'v' is unused", line: 4 }] },
    ]);
    const result = await run(
      { verify: true, ciOutputPath: "eslint.json", event: { headSha: "abc" } },
      { ...deps, fetchImpl: diffFetch(MODIFIED_FILE_DIFF), model, ciIo: { readFile: () => eslint } },
    );
    expect(model.requests[0].user).not.toContain("no-unused-vars"); // reviewer never sees it
    expect(model.requests.length).toBeGreaterThan(1);
    expect(model.requests[1].user).toContain("no-unused-vars"); // verifier does
    expect(result.notices.some((n) => n.includes("ingested 1 CI/lint diagnostic"))).toBe(true);
  });

  it("#16 CI ingestion: fail-soft when the path is unreadable", async () => {
    const { deps } = capture();
    const result = await run(
      { ciOutputPath: "missing.json", event: { headSha: "abc" } },
      {
        ...deps,
        fetchImpl: diffFetch(MODIFIED_FILE_DIFF),
        model: new MockProvider("[]"),
        ciIo: {
          readFile: () => {
            throw new Error("ENOENT");
          },
        },
      },
    );
    expect(result.posted).toBe(true);
    expect(result.notices.some((n) => n.includes("ingested"))).toBe(false);
  });
});

describe("buildSummary", () => {
  const base = { findings: [], skippedFiles: [], exclusions: [], degraded: false, nothingReviewable: false };

  it("says no issues found for a clean run", () => {
    expect(buildSummary(base)).toBe("✅ no issues found");
  });

  it("counts findings and renders file-level sections", () => {
    const summary = buildSummary({
      ...base,
      findings: [
        { severity: "high", category: "bug", file: "a.ts", line: 1, title: "t", body: "b" },
        { severity: "low", category: "other", file: "b.ts", title: "t2", body: "b2" },
      ],
    });
    expect(summary).toContain("2 issue(s) (1 inline)");
    expect(summary).toContain("**`b.ts`** (file-level");
    expect(summary).toContain("- **[low]** t2: b2");
  });

  it("always discloses skips and truncation", () => {
    const summary = buildSummary({
      ...base,
      skippedFiles: [{ file: "yarn.lock", reason: "lockfile" }],
      exclusions: [{ file: "huge.ts", whatWasExcluded: "entire file diff dropped" }],
    });
    expect(summary).toContain("Skipped 1 noise file(s)");
    expect(summary).toContain("`yarn.lock` (lockfile)");
    expect(summary).toContain("Not reviewed");
    expect(summary).toContain("entire file diff dropped");
  });
});
