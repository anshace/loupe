/** M4 pipeline wiring tests: context expansion, agentic loop, verifier, escalation, shared cost cap. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepoReader } from "./agentic";
import type { ExistingComments } from "./dedupe";
import type { FetchLike } from "./diff";
import type { ModelRequest, ModelResponse, ReviewModel } from "./model";
import { runReview } from "./run";
import type { RunDeps } from "./run";
import type { PrIdentity, ReviewPayload } from "./types";

const pr: PrIdentity = { owner: "anshace", repo: "demo", prNumber: 7 };
const NO_COMMENTS: ExistingComments = { reviewComments: [], issueComments: [] };

const DIFF = `diff --git a/src/pricing.ts b/src/pricing.ts
index 1111111..2222222 100644
--- a/src/pricing.ts
+++ b/src/pricing.ts
@@ -1,6 +1,6 @@
 export function applyDiscount(totalCents: number, discountPercent: number): number {
-  return Math.round(totalCents * (1 - discountPercent / 100));
+  return Math.round(totalCents * (1 - discountPercent));
 }

 export const ZERO = 0;`;

const HEAD_FILE = [
  "export function applyDiscount(totalCents: number, discountPercent: number): number {",
  "  return Math.round(totalCents * (1 - discountPercent));",
  "}",
  "",
  "export const ZERO = 0;",
].join("\n");

const FINDING = {
  severity: "high",
  category: "bug",
  file: "src/pricing.ts",
  line: 2,
  title: "Discount treated as a fraction",
  body: "discountPercent is a percentage but is no longer divided by 100.",
};

function diffFetch(diff: string): FetchLike {
  return async () => ({ ok: true, status: 200, text: async () => diff });
}

class ReplayModel implements ReviewModel {
  readonly name = "mock";
  readonly requests: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly responses: string[]) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const text = this.responses[Math.min(this.i, this.responses.length - 1)];
    this.i += 1;
    return { text, inputTokens: 10, outputTokens: 5 };
  }
}

function baseDeps(model: ReviewModel): RunDeps & { upserts: string[] } {
  const upserts: string[] = [];
  return {
    fetchImpl: diffFetch(DIFF),
    model,
    repoFiles: {},
    existingComments: NO_COMMENTS,
    headFiles: { "src/pricing.ts": HEAD_FILE },
    post: async (_p, _a, _payload: ReviewPayload) => {},
    upsertSummary: async (_p, _a, body) => {
      upserts.push(body);
    },
    upserts,
  };
}

describe("runReview — enclosing-scope context (6.1)", () => {
  it("injects a labeled context block from the head file contents", async () => {
    const model = new ReplayModel(["[]"]);
    await runReview(pr, "tok", {}, baseDeps(model));
    const user = model.requests[0].user;
    expect(user).toContain("### src/pricing.ts — enclosing scope, lines 1-3");
    expect(user).toContain("    1| export function applyDiscount");
    expect(user).toContain("disabled — respond with the required JSON array only.");
  });

  it("renders (none) when head contents are unavailable", async () => {
    const model = new ReplayModel(["[]"]);
    const deps = { ...baseDeps(model), headFiles: {} };
    await runReview(pr, "tok", {}, deps);
    expect(model.requests[0].user).toContain("<context>\n(none)\n</context>");
  });

  it("discloses context truncation via a notice", async () => {
    const model = new ReplayModel(["[]"]);
    const result = await runReview(pr, "tok", { contextCapChars: 5 }, baseDeps(model));
    expect(result.notices).toContain("enclosing-scope context truncated at the char cap");
  });
});

describe("runReview — capped agentic tools (6.3)", () => {
  const reader: RepoReader = {
    listTree: async () => ["src/pricing.ts", "src/checkout.ts"],
    readFile: async (path) =>
      path === "src/checkout.ts" ? 'import { applyDiscount } from "./pricing";\napplyDiscount(100, 10);' : HEAD_FILE,
  };

  it("is off by default: tool answers degrade with a notice", async () => {
    const model = new ReplayModel(['{"tool_calls": [{"tool": "read_file", "path": "src/checkout.ts"}]}']);
    const result = await runReview(pr, "tok", {}, baseDeps(model));
    expect(result.degraded).toBe(true);
    expect(result.notices).toContain("model requested tools but agentic mode is off");
    expect(model.requests).toHaveLength(1);
  });

  it("executes the loop when enabled and reports usage", async () => {
    const model = new ReplayModel([
      '{"tool_calls": [{"tool": "grep", "pattern": "applyDiscount"}]}',
      JSON.stringify([FINDING]),
    ]);
    const result = await runReview(pr, "tok", { agentic: true }, { ...baseDeps(model), repoReader: reader });
    expect(model.requests[0].user).toContain("enabled — you may request tools");
    expect(model.requests[1].user).toContain("src/checkout.ts:2: applyDiscount(100, 10);");
    expect(result.findings).toHaveLength(1);
    expect(result.agenticUsage).toMatchObject({ hops: 1, cappedOut: false });
    expect(result.degraded).toBe(false);
  });
});

describe("runReview — verifier pass (6.4)", () => {
  const SECOND_FINDING = {
    ...FINDING,
    line: 5,
    title: "ZERO constant is unused",
    body: "The exported ZERO constant is never used.",
  };

  it("is off by default (no second model call)", async () => {
    const model = new ReplayModel([JSON.stringify([FINDING])]);
    const result = await runReview(pr, "tok", {}, baseDeps(model));
    expect(model.requests).toHaveLength(1);
    expect(result.verification).toBeUndefined();
  });

  it("keeps/drops per verdict; drops are disclosed in the summary comment", async () => {
    const model = new ReplayModel([
      JSON.stringify([FINDING, SECOND_FINDING]),
      JSON.stringify([
        { id: 1, verdict: "keep", evidence: "src/pricing.ts:2" },
        { id: 2, verdict: "drop", reason: "out-of-scope", evidence: "src/pricing.ts:5 — export const ZERO = 0;" },
      ]),
    ]);
    const deps = baseDeps(model);
    const result = await runReview(pr, "tok", { verify: true }, deps);

    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].user).toContain('"id": 1');
    expect(result.findings.map((f) => f.title)).toEqual([FINDING.title]);
    expect(result.verification).toMatchObject({ degraded: false, keptCount: 1, rewrittenCount: 0 });
    expect(result.verification?.dropped).toHaveLength(1);
    expect(deps.upserts[0]).toContain("**Dropped by verification** (1):");
    expect(deps.upserts[0]).toContain("[out-of-scope]");
  });

  it("applies rewrites to the finding body", async () => {
    const model = new ReplayModel([
      JSON.stringify([FINDING]),
      JSON.stringify([{ id: 1, verdict: "rewrite", rewritten: "Better body.", evidence: "src/pricing.ts:2" }]),
    ]);
    const result = await runReview(pr, "tok", { verify: true }, baseDeps(model));
    expect(result.findings[0].body).toBe("Better body.");
    expect(result.verification?.rewrittenCount).toBe(1);
  });

  it("fails OPEN on unparseable verifier output — originals published, degraded noted", async () => {
    const model = new ReplayModel([JSON.stringify([FINDING]), "I refuse to answer in JSON."]);
    const result = await runReview(pr, "tok", { verify: true }, baseDeps(model));
    expect(result.findings).toHaveLength(1);
    expect(result.verification?.degraded).toBe(true);
    expect(result.notices.join(" ")).toContain("verification degraded");
  });

  it("skips verification with a disclosure when the cost cap would be exceeded (6.6)", async () => {
    const model = new ReplayModel([JSON.stringify([FINDING])]);
    // Reviewer call records 10 input tokens; cap of 10 leaves no room for the verifier.
    const result = await runReview(
      pr,
      "tok",
      { verify: true, tokenCaps: { maxInputTokens: 10 } },
      baseDeps(model),
    );
    expect(model.requests).toHaveLength(1);
    expect(result.notices).toContain("verification skipped: cost cap");
    expect(result.earlyStop).toBe(true);
    expect(result.findings).toHaveLength(1); // still published — never a hard failure
  });
});

describe("runReview — risk-based escalation (6.5)", () => {
  const AUTH_DIFF = DIFF.split("src/pricing.ts").join("src/auth/pricing.ts");

  // Providers read API keys from process.env at call time.
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.GEMINI_API_KEY = "test-key";
  });
  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  function routedFetch(): FetchLike {
    return async (url) => {
      if (url.includes("api.anthropic.com")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              content: [{ type: "text", text: "[]" }],
              usage: { input_tokens: 5, output_tokens: 1 },
            }),
        };
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: "[]" }] } }],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
            }),
        };
      }
      return { ok: true, status: 200, text: async () => AUTH_DIFF };
    };
  }

  function escalationDeps(reviewModel = "haiku"): RunDeps {
    return {
      fetchImpl: routedFetch(),
      repoFiles: {},
      existingComments: NO_COMMENTS,
      headFiles: {},
      post: async () => {},
      upsertSummary: async () => {},
      env: { REVIEW_MODEL: reviewModel, ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "k" },
    };
  }

  it("escalates risky paths to the claude-sonnet-5 anthropic default with a notice", async () => {
    // haiku shortcut → anthropic protocol → Sonnet default.
    const result = await runReview(pr, "tok", {}, escalationDeps("haiku"));
    expect(result.usage?.model).toBe("claude-sonnet-5");
    expect(result.notices.join(" ")).toContain("escalated to claude-sonnet-5");
  });

  it("does not escalate a non-anthropic shortcut without an escalation model", async () => {
    // gemini shortcut has no guessable stronger model → stays on gemini.
    const result = await runReview(pr, "tok", {}, escalationDeps("gemini"));
    expect(result.usage?.model).toBe("gemini-2.5-flash");
  });

  it("escalates any provider when escalationModel is set (same-provider rebuild)", async () => {
    const result = await runReview(
      pr,
      "tok",
      { provider: "anthropic", escalationModel: "claude-opus-4-8" },
      { ...escalationDeps("haiku"), env: { ANTHROPIC_API_KEY: "k" } },
    );
    expect(result.usage?.model).toBe("claude-opus-4-8");
    expect(result.notices.join(" ")).toContain("escalated to claude-opus-4-8");
  });

  it("respects the escalation: false override", async () => {
    const result = await runReview(pr, "tok", { escalation: false }, escalationDeps("haiku"));
    expect(result.usage?.model).toBe("claude-haiku-4-5");
  });
});

describe("runReview — PR intent + security checklist (features #3, #5)", () => {
  it("injects the PR intent block from injected intent", async () => {
    const model = new ReplayModel(["[]"]);
    const deps = { ...baseDeps(model), prIntent: { title: "Fix discount math", body: "Closes #42.", linkedIssues: [42] } };
    await runReview(pr, "tok", {}, deps);
    const user = model.requests[0].user;
    expect(user).toContain("Title: Fix discount math");
    expect(user).toContain("Linked issues (closed by this PR): #42");
  });

  it("renders (none) for PR intent when the fetch yields nothing", async () => {
    const model = new ReplayModel(["[]"]);
    // baseDeps' diffFetch serves the diff for every URL; the intent JSON.parse fails → fail-soft.
    await runReview(pr, "tok", {}, baseDeps(model));
    expect(model.requests[0].user).toContain("<pr-intent>\n(none)\n</pr-intent>");
  });

  it("injects a per-language CWE checklist for the diff's languages", async () => {
    const model = new ReplayModel(["[]"]);
    await runReview(pr, "tok", {}, { ...baseDeps(model), prIntent: undefined });
    const user = model.requests[0].user;
    expect(user).toContain("**TypeScript/JavaScript**");
    expect(user).toContain("CWE-89");
  });
});

describe("runReview — verifier grounding + abstention (features #1, #6)", () => {
  const SECOND = {
    ...FINDING,
    line: 5,
    title: "ZERO constant is unused",
    body: "The exported ZERO constant is never used.",
  };

  it("discloses an insufficient-context abstention distinctly from a drop", async () => {
    const model = new ReplayModel([
      JSON.stringify([FINDING, SECOND]),
      JSON.stringify([
        { id: 1, verdict: "keep", evidence: "src/pricing.ts:2 — Math.round(totalCents" },
        { id: 2, verdict: "drop", reason: "insufficient-context" },
      ]),
    ]);
    const deps = baseDeps(model);
    const result = await runReview(pr, "tok", { verify: true }, deps);

    expect(result.findings.map((f) => f.title)).toEqual([FINDING.title]);
    expect(result.verification?.dropped).toHaveLength(1);
    expect(result.verification?.dropped[0].reason).toBe("insufficient-context");
    expect(deps.upserts[0]).toContain("Could not confirm — insufficient context");
    expect(deps.upserts[0]).not.toContain("Dropped by verification");
  });

  it("keeps a finding whose keep evidence is fabricated, and discloses it as ungrounded", async () => {
    const model = new ReplayModel([
      JSON.stringify([FINDING]),
      JSON.stringify([{ id: 1, verdict: "keep", evidence: "src/pricing.ts:2 — launchTheMissiles()" }]),
    ]);
    const deps = baseDeps(model);
    const result = await runReview(pr, "tok", { verify: true }, deps);

    expect(result.findings).toHaveLength(1); // kept — never silently dropped
    expect(result.verification?.ungrounded).toHaveLength(1);
    expect(result.verification?.ungrounded[0].reason).toBe("quote-not-found");
    expect(deps.upserts[0]).toContain("could not ground its cited evidence for 1 verdict");
  });
});
