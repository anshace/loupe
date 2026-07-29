/** M5 pipeline wiring tests: state store, incremental scope, hunk-hash skip,
 *  still-open carry-forward, custom rules, run log, and the RAG flag. */
import { describe, expect, it } from "vitest";
import type { ExistingComments } from "./dedupe";
import type { FetchLike } from "./diff";
import { parseUnifiedDiff } from "./diff";
import { MockProvider } from "./model";
import type { RetrievedChunk, Retriever } from "./retrieve";
import { runReview } from "./run";
import type { RunDeps } from "./run";
import { hashHunk } from "./state";
import type { PrState, StateStore } from "./state";
import type { EngineConfig, Finding, PrIdentity, ReviewPayload } from "./types";

const pr: PrIdentity = { owner: "anshace", repo: "demo", prNumber: 9 };
const PR_KEY = "anshace/demo#9";
const NO_COMMENTS: ExistingComments = { reviewComments: [], issueComments: [] };

const FULL_DIFF = `diff --git a/src/api/handler.ts b/src/api/handler.ts
index 1111111..2222222 100644
--- a/src/api/handler.ts
+++ b/src/api/handler.ts
@@ -1,4 +1,5 @@
 export function handler(req) {
+  const q = req.query;
   return db.run(q);
 }
 // end
diff --git a/src/lib/util.ts b/src/lib/util.ts
index 3333333..4444444 100644
--- a/src/lib/util.ts
+++ b/src/lib/util.ts
@@ -10,3 +10,3 @@ export function util() {
 a
-b
+c
 d`;

const INCR_DIFF = `diff --git a/src/lib/util.ts b/src/lib/util.ts
index 3333333..4444444 100644
--- a/src/lib/util.ts
+++ b/src/lib/util.ts
@@ -10,3 +10,3 @@ export function util() {
 a
-b
+c
 d`;

const UTIL_HUNK_HASH = hashHunk("src/lib/util.ts", parseUnifiedDiff(INCR_DIFF)[0].hunks[0]);

const NEW_FINDING = {
  severity: "high",
  category: "bug",
  file: "src/lib/util.ts",
  line: 11,
  title: "New bug in util",
  body: "c is wrong.",
};

/** Routes compare vs full-PR diff fetches and records every URL. */
function routedFetch(urls: string[]): FetchLike {
  return async (url) => {
    urls.push(url);
    if (url.includes("/compare/")) return { ok: true, status: 200, text: async () => INCR_DIFF };
    return { ok: true, status: 200, text: async () => FULL_DIFF };
  };
}

class MemoryStore implements StateStore {
  readonly sets: Array<{ key: string; state: PrState }> = [];
  constructor(private readonly map = new Map<string, PrState>()) {}
  seed(key: string, state: PrState): this {
    this.map.set(key, state);
    return this;
  }
  async get(key: string): Promise<PrState | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, state: PrState): Promise<void> {
    this.map.set(key, state);
    this.sets.push({ key, state });
  }
}

interface Harness {
  urls: string[];
  posts: ReviewPayload[];
  upserts: string[];
  deps: RunDeps;
}

function harness(model: MockProvider, extra: Partial<RunDeps> = {}): Harness {
  const urls: string[] = [];
  const posts: ReviewPayload[] = [];
  const upserts: string[] = [];
  return {
    urls,
    posts,
    upserts,
    deps: {
      fetchImpl: routedFetch(urls),
      model,
      repoFiles: {},
      existingComments: NO_COMMENTS,
      headFiles: {},
      post: async (_p, _a, payload) => {
        posts.push(payload);
      },
      upsertSummary: async (_p, _a, body) => {
        upserts.push(body);
      },
      ...extra,
    },
  };
}

const prior = (over: Partial<PrState> = {}): PrState => ({
  lastReviewedSha: "lastsha",
  hunkHashes: [],
  openFindings: [],
  ...over,
});

const SYNC_EVENT: EngineConfig["event"] = { headSha: "newsha", before: "beforesha" };

describe("runReview — incremental scope (7.2)", () => {
  it("reviews only the lastReviewed...head compare when state and before exist", async () => {
    const store = new MemoryStore().seed(PR_KEY, prior());
    const model = new MockProvider("[]");
    const h = harness(model, { stateStore: store });

    const result = await runReview(pr, "tok", { event: SYNC_EVENT }, h.deps);

    expect(h.urls.some((u) => u.includes("/compare/lastsha...newsha"))).toBe(true);
    expect(h.urls.some((u) => u.includes("/pulls/9"))).toBe(false);
    expect(result.incremental).toEqual({ base: "lastsha", skippedHunks: 0 });
    expect(result.notices.join(" ")).toContain("incremental review");
    // The model saw only the incremental range, not the whole PR.
    expect(model.requests[0].user).toContain("src/lib/util.ts");
    expect(model.requests[0].user).not.toContain("src/api/handler.ts");
  });

  it("first review (no prior state, no marker) → full PR diff", async () => {
    const model = new MockProvider("[]");
    const h = harness(model, { stateStore: new MemoryStore() });
    const result = await runReview(pr, "tok", { event: SYNC_EVENT }, h.deps);
    expect(h.urls.some((u) => u.includes("/compare/"))).toBe(false);
    expect(h.urls.some((u) => u.includes("/pulls/9"))).toBe(true);
    expect(result.incremental).toBeUndefined();
    expect(model.requests[0].user).toContain("src/api/handler.ts");
  });

  it("on-demand /review → full PR diff even with prior state", async () => {
    const store = new MemoryStore().seed(PR_KEY, prior());
    const h = harness(new MockProvider("[]"), { stateStore: store });
    const result = await runReview(pr, "tok", { event: { ...SYNC_EVENT, onDemand: true } }, h.deps);
    expect(h.urls.some((u) => u.includes("/compare/"))).toBe(false);
    expect(result.incremental).toBeUndefined();
  });

  it("falls back to the full diff (with a notice) when the compare fetch fails", async () => {
    const store = new MemoryStore().seed(PR_KEY, prior());
    const model = new MockProvider("[]");
    const h = harness(model, { stateStore: store });
    h.deps.fetchImpl = async (url: string) => {
      if (url.includes("/compare/")) return { ok: false, status: 500, text: async () => "boom" };
      return { ok: true, status: 200, text: async () => FULL_DIFF };
    };
    const result = await runReview(pr, "tok", { event: SYNC_EVENT }, h.deps);
    expect(result.skipped).toBeUndefined();
    expect(result.incremental).toBeUndefined();
    expect(result.notices.join(" ")).toContain("incremental compare fetch failed");
    expect(model.requests[0].user).toContain("src/api/handler.ts");
  });

  it("skips already-reviewed hunks by content hash, even within the new range", async () => {
    const store = new MemoryStore().seed(PR_KEY, prior({ hunkHashes: [UTIL_HUNK_HASH] }));
    const model = new MockProvider("[]");
    const h = harness(model, { stateStore: store });

    const result = await runReview(pr, "tok", { event: SYNC_EVENT }, h.deps);

    // The only hunk in the range was already reviewed → nothing reaches the model.
    expect(model.requests).toHaveLength(0);
    expect(result.incremental).toEqual({ base: "lastsha", skippedHunks: 1 });
    expect(result.skippedFiles).toContainEqual({ file: "src/lib/util.ts", reason: "already-reviewed" });
    expect(result.notices.join(" ")).toContain("already-reviewed hunk(s)");
    expect(h.upserts[0]).toContain("No reviewable changes");
  });

  it("gate reads the store's lastReviewedSha even with no summary marker", async () => {
    const store = new MemoryStore().seed(PR_KEY, prior({ lastReviewedSha: "newsha" }));
    const h = harness(new MockProvider("[]"), { stateStore: store });
    const result = await runReview(pr, "tok", { event: { headSha: "newsha" } }, h.deps);
    expect(result.skipped?.reason).toContain("newsha");
    expect(h.posts).toHaveLength(0);
  });
});

describe("runReview — still-open carry-forward (7.3)", () => {
  const OPEN_UNFIXED: Finding = {
    severity: "high",
    category: "bug",
    file: "src/api/handler.ts",
    line: 5,
    title: "Missing input validation",
    body: "handler trusts req.query.",
  };
  const OPEN_FIXED: Finding = {
    severity: "medium",
    category: "bug",
    file: "src/lib/util.ts",
    line: 11, // inside the changed hunk's old-side span → assumed resolved
    title: "Old util bug",
    body: "b was wrong.",
  };

  function carryHarness(model: MockProvider): Harness & { store: MemoryStore } {
    const store = new MemoryStore().seed(PR_KEY, prior({ openFindings: [OPEN_UNFIXED, OPEN_FIXED] }));
    return { ...harness(model, { stateStore: store }), store };
  }

  it("lists a still-unfixed prior finding in the summary only; drops the fixed one; posts the new one inline", async () => {
    const model = new MockProvider(JSON.stringify([NEW_FINDING]));
    const h = carryHarness(model);

    const result = await runReview(pr, "tok", { event: SYNC_EVENT }, h.deps);

    // New finding on newly changed code → inline as normal.
    expect(h.posts[0].comments).toEqual([
      expect.objectContaining({ path: "src/lib/util.ts", line: 11, side: "RIGHT" }),
    ]);
    // Still-unfixed prior finding → summary section only, never re-posted inline.
    expect(result.stillOpen.map((f) => f.title)).toEqual(["Missing input validation"]);
    expect(h.upserts[0]).toContain("Still open from previous runs");
    expect(h.upserts[0]).toContain("`src/api/handler.ts`:5");
    expect(h.upserts[0]).toContain("Missing input validation");
    // Fixed prior finding (its code changed) → gone entirely.
    expect(h.upserts[0]).not.toContain("Old util bug");
    expect(h.posts[0].comments.map((c) => c.body).join(" ")).not.toContain("Missing input validation");
  });

  it("persists lastReviewedSha, cumulative hunk hashes, and the merged open set", async () => {
    const model = new MockProvider(JSON.stringify([NEW_FINDING]));
    const h = carryHarness(model);
    h.store.seed(PR_KEY, prior({ openFindings: [OPEN_UNFIXED, OPEN_FIXED], hunkHashes: ["oldhash0oldhash0"] }));

    await runReview(pr, "tok", { event: SYNC_EVENT }, h.deps);

    expect(h.store.sets).toHaveLength(1);
    const saved = h.store.sets[0];
    expect(saved.key).toBe(PR_KEY);
    expect(saved.state.lastReviewedSha).toBe("newsha");
    expect(saved.state.hunkHashes).toEqual(["oldhash0oldhash0", UTIL_HUNK_HASH]);
    expect(saved.state.openFindings.map((f) => f.title)).toEqual(["New bug in util", "Missing input validation"]);
  });

  it("does not persist state on dryRun", async () => {
    const h = carryHarness(new MockProvider("[]"));
    await runReview(pr, "tok", { event: SYNC_EVENT, dryRun: true }, h.deps);
    expect(h.store.sets).toHaveLength(0);
  });
});

describe("runReview — custom rules (7.4)", () => {
  const RULES_TOML = `
[[rules]]
pattern = "src/api/**"
text = "All API handlers must validate input with zod"

[[rules]]
pattern = "src/db/**"
text = "Use parameterized queries only"
`;

  it("injects only the rules whose glob matches the reviewed paths", async () => {
    const model = new MockProvider("[]");
    const h = harness(model, { repoFiles: { config: RULES_TOML } });
    await runReview(pr, "tok", {}, h.deps); // full diff includes src/api/handler.ts
    const user = model.requests[0].user;
    expect(user).toContain("- All API handlers must validate input with zod");
    expect(user).not.toContain("parameterized queries");
  });

  it("a rule scoped to src/api/** does not inject when only other paths changed", async () => {
    const store = new MemoryStore().seed(PR_KEY, prior());
    const model = new MockProvider("[]");
    const h = harness(model, { stateStore: store, repoFiles: { config: RULES_TOML } });
    await runReview(pr, "tok", { event: SYNC_EVENT }, h.deps); // incremental → only src/lib/util.ts
    expect(model.requests[0].user).toContain("<custom-rules>\n(none)\n</custom-rules>");
  });

  it("supports the simple unscoped string form", async () => {
    const model = new MockProvider("[]");
    const h = harness(model, { repoFiles: { config: 'rules = ["No console.log in production code"]' } });
    await runReview(pr, "tok", {}, h.deps);
    expect(model.requests[0].user).toContain("- No console.log in production code");
  });
});

describe("runReview — run log (7.5)", () => {
  it("appends one structured record per run via injectable IO and clock", async () => {
    const model = new MockProvider(
      JSON.stringify([
        NEW_FINDING,
        { severity: "nit", category: "style", file: "src/lib/util.ts", line: 10, title: "Spacing", body: "b" },
      ]),
      { inputTokens: 111, outputTokens: 22 },
    );
    const lines: string[] = [];
    const h = harness(model, {
      runLogIo: { appendFile: (_p, line) => lines.push(line) },
      now: () => new Date("2026-07-29T12:00:00Z"),
    });

    await runReview(pr, "tok", { runLogPath: "runs.jsonl" }, h.deps);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      pr: PR_KEY,
      timestamp: "2026-07-29T12:00:00.000Z",
      model: "mock",
      inputTokens: 111,
      outputTokens: 22,
      estCostUsd: 0,
      findingsKept: 1,
      findingsDropped: 1,
      dropReasons: { "style-nit": 1 },
      verifierDropped: 0,
      escalated: false,
      incremental: false,
    });
  });

  it("writes nothing when no runLogPath is configured, or when the gate skips", async () => {
    const lines: string[] = [];
    const io = { appendFile: (_p: string, line: string) => lines.push(line) };

    const h1 = harness(new MockProvider("[]"), { runLogIo: io });
    await runReview(pr, "tok", {}, h1.deps);
    expect(lines).toHaveLength(0);

    const h2 = harness(new MockProvider("[]"), { runLogIo: io });
    await runReview(pr, "tok", { runLogPath: "runs.jsonl", event: { isDraft: true } }, h2.deps);
    expect(lines).toHaveLength(0);
  });
});

describe("runReview — RAG flag (7.6)", () => {
  const CHUNK: RetrievedChunk = { source: "adr/0001-zod.md", text: "All handlers validate with zod.", score: 0.91 };

  function stubRetriever(): Retriever & { queries: string[] } {
    const queries: string[] = [];
    return {
      queries,
      retrieve: async (query) => {
        queries.push(query);
        return [CHUNK];
      },
    };
  }

  it("is OFF by default: retriever present but never called, placeholder stays (none)", async () => {
    const model = new MockProvider("[]");
    const retriever = stubRetriever();
    const h = harness(model, { retriever });
    await runReview(pr, "tok", {}, h.deps);
    expect(retriever.queries).toHaveLength(0);
    expect(model.requests[0].user).toContain("<retrieved-context>\n(none)\n</retrieved-context>");
  });

  it("injects labeled retrieved chunks when rag: true", async () => {
    const model = new MockProvider("[]");
    const retriever = stubRetriever();
    const h = harness(model, { retriever });
    await runReview(pr, "tok", { rag: true }, h.deps);
    expect(retriever.queries).toHaveLength(1);
    expect(retriever.queries[0]).toContain("src/api/handler.ts");
    const user = model.requests[0].user;
    expect(user).toContain("### adr/0001-zod.md (score 0.91)");
    expect(user).toContain("All handlers validate with zod.");
  });

  it("retrieval failure degrades to a notice, never a crash", async () => {
    const model = new MockProvider("[]");
    const h = harness(model, {
      retriever: {
        retrieve: async () => {
          throw new Error("index unavailable");
        },
      },
    });
    const result = await runReview(pr, "tok", { rag: true }, h.deps);
    expect(result.skipped).toBeUndefined();
    expect(result.notices.join(" ")).toContain("retrieval failed");
    expect(model.requests[0].user).toContain("<retrieved-context>\n(none)\n</retrieved-context>");
  });
});
