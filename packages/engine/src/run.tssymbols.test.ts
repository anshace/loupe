/** run.ts wiring for the TS language service (report item #33): the tsSymbols
 *  agentic tools and the tsDiagnostics zero-hallucination findings, both gated
 *  behind an injected SymbolService. */
import { describe, expect, it } from "vitest";
import type { ExistingComments } from "./dedupe";
import type { FetchLike } from "./diff";
import type { ModelRequest, ModelResponse, ReviewModel } from "./model";
import { runReview } from "./run";
import type { RunDeps } from "./run";
import type { SymbolQuery, SymbolService } from "./symbols";
import type { PrIdentity } from "./types";

const pr: PrIdentity = { owner: "anshace", repo: "demo", prNumber: 11 };
const NO_COMMENTS: ExistingComments = { reviewComments: [], issueComments: [] };

// A PR adding a call site in checkout.ts (line 2 is the added line).
const DIFF = `diff --git a/src/checkout.ts b/src/checkout.ts
--- a/src/checkout.ts
+++ b/src/checkout.ts
@@ -1,1 +1,2 @@
 import { applyDiscount } from "./pricing";
+const t = applyDiscount(100);`;

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

/** A mock SymbolService that reports one TS2554 on the added line + answers refs. */
function mockService(): SymbolService {
  return {
    findDefinition: async (q: SymbolQuery) => [
      { path: "src/pricing.ts", line: 1, column: 18, text: `export function ${q.symbol}(...) {` },
    ],
    findReferences: async (q: SymbolQuery) => [
      { path: "src/checkout.ts", line: 2, column: 11, text: `applyDiscount(100)` },
    ],
    hover: async () => "function applyDiscount(totalCents: number, pct: number): number",
    getDiagnostics: async () => [
      {
        path: "src/checkout.ts",
        line: 2,
        column: 11,
        category: "error",
        code: 2554,
        message: "Expected 2 arguments, but got 1.",
      },
      // A pre-existing error on a NON-added line must be filtered out.
      { path: "src/checkout.ts", line: 1, column: 1, category: "error", code: 2554, message: "old error" },
      // A program-incompleteness code must be filtered out.
      { path: "src/checkout.ts", line: 2, column: 1, category: "error", code: 2307, message: "Cannot find module './pricing'." },
    ],
  };
}

function baseDeps(model: ReviewModel, extra: Partial<RunDeps> = {}): RunDeps {
  return {
    fetchImpl: diffFetch(DIFF),
    model,
    repoFiles: {},
    existingComments: NO_COMMENTS,
    headFiles: { "src/checkout.ts": 'import { applyDiscount } from "./pricing";\nconst t = applyDiscount(100);\n' },
    prIntent: undefined,
    post: async () => {},
    upsertSummary: async () => {},
    ...extra,
  };
}

describe("runReview — TS language service (report item #33)", () => {
  it("tsDiagnostics off by default: no type-error findings even with a service", async () => {
    const model = new ReplayModel(["[]"]);
    const result = await runReview(pr, "tok", {}, baseDeps(model, { symbolService: mockService() }));
    expect(result.findings.some((f) => f.category === "type-error")).toBe(false);
  });

  it("tsDiagnostics on: surfaces the added-line TS2554 as a zero-hallucination finding", async () => {
    const model = new ReplayModel(["[]"]);
    const result = await runReview(
      pr,
      "tok",
      { tsDiagnostics: true },
      baseDeps(model, { symbolService: mockService() }),
    );
    const typeErrors = result.findings.filter((f) => f.category === "type-error");
    expect(typeErrors).toHaveLength(1); // pre-existing + module-not-found filtered out
    expect(typeErrors[0].file).toBe("src/checkout.ts");
    expect(typeErrors[0].line).toBe(2);
    expect(typeErrors[0].title).toContain("TS2554");
    expect(result.notices.some((n) => n.includes("TS compiler"))).toBe(true);
  });

  it("tsDiagnostics on but NO service injected: cleanly skipped, engine unaffected", async () => {
    const model = new ReplayModel(["[]"]);
    const result = await runReview(pr, "tok", { tsDiagnostics: true }, baseDeps(model));
    expect(result.findings.some((f) => f.category === "type-error")).toBe(false);
    expect(result.notices.some((n) => n.includes("TS compiler"))).toBe(false);
  });

  it("tsSymbols advertises the symbol tools in {{TOOLS}} only when agentic + service are present", async () => {
    const withBoth = new ReplayModel(["[]"]);
    await runReview(
      pr,
      "tok",
      { agentic: true, tsSymbols: true },
      baseDeps(withBoth, { symbolService: mockService(), repoReader: { listTree: async () => [], readFile: async () => undefined } }),
    );
    expect(withBoth.requests[0].user).toContain("find_definition");
    expect(withBoth.requests[0].user).toContain("find_references");

    // tsSymbols on but agentic OFF → tools not advertised (no tool loop to run them).
    const noAgentic = new ReplayModel(["[]"]);
    await runReview(pr, "tok", { tsSymbols: true }, baseDeps(noAgentic, { symbolService: mockService() }));
    expect(noAgentic.requests[0].user).not.toContain("find_definition");
  });

  it("tsSymbols tools are executed by the agentic loop when the model calls them", async () => {
    // Hop 1: the model asks for references; hop 2: it answers with no findings.
    const model = new ReplayModel([
      JSON.stringify({ tool_calls: [{ tool: "find_references", path: "src/pricing.ts", symbol: "applyDiscount" }] }),
      "[]",
    ]);
    const result = await runReview(
      pr,
      "tok",
      { agentic: true, tsSymbols: true },
      baseDeps(model, { symbolService: mockService(), repoReader: { listTree: async () => [], readFile: async () => undefined } }),
    );
    // The second model turn must contain the rendered reference result.
    expect(model.requests.length).toBeGreaterThanOrEqual(2);
    expect(model.requests[1].user).toContain("src/checkout.ts:2:11");
    expect(result.agenticUsage?.hops).toBe(1);
  });
});
