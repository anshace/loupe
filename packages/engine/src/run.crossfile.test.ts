/** run.ts wiring for cross-file caller injection (report item #8). */
import { describe, expect, it } from "vitest";
import type { RepoReader } from "./agentic";
import type { ExistingComments } from "./dedupe";
import type { FetchLike } from "./diff";
import type { ModelRequest, ModelResponse, ReviewModel } from "./model";
import { runReview } from "./run";
import type { RunDeps } from "./run";
import type { PrIdentity } from "./types";

const pr: PrIdentity = { owner: "anshace", repo: "demo", prNumber: 9 };
const NO_COMMENTS: ExistingComments = { reviewComments: [], issueComments: [] };

// A PR that changes an EXPORTED signature (adds a required param).
const SIG_DIFF = `diff --git a/src/pricing.ts b/src/pricing.ts
--- a/src/pricing.ts
+++ b/src/pricing.ts
@@ -1,3 +1,3 @@
-export function applyDiscount(totalCents: number): number {
+export function applyDiscount(totalCents: number, pct: number): number {
   return totalCents;
 }`;

// The caller in ANOTHER file was NOT updated — still one argument.
const REPO: Record<string, string> = {
  "src/pricing.ts": "export function applyDiscount(totalCents, pct) {\n  return totalCents;\n}\n",
  "src/checkout.ts": 'import { applyDiscount } from "./pricing";\nconst t = applyDiscount(100);\n',
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

const reader: RepoReader = {
  listTree: async () => Object.keys(REPO),
  readFile: async (path) => REPO[path],
};

function baseDeps(model: ReviewModel): RunDeps {
  return {
    fetchImpl: diffFetch(SIG_DIFF),
    model,
    repoFiles: {},
    existingComments: NO_COMMENTS,
    headFiles: { "src/pricing.ts": REPO["src/pricing.ts"] },
    repoReader: reader,
    prIntent: undefined,
    post: async () => {},
    upsertSummary: async () => {},
  };
}

describe("runReview — cross-file caller injection (report item #8)", () => {
  it("is off by default: the block renders (none)", async () => {
    const model = new ReplayModel(["[]"]);
    await runReview(pr, "tok", {}, baseDeps(model));
    expect(model.requests[0].user).toContain("<cross-file-callers>\n(none)\n</cross-file-callers>");
  });

  it("force-injects the unupdated caller when crossFileCallers is on", async () => {
    const model = new ReplayModel(["[]"]);
    await runReview(pr, "tok", { crossFileCallers: true }, baseDeps(model));
    const user = model.requests[0].user;
    expect(user).toContain("Cross-file callers of changed signatures");
    expect(user).toContain("`applyDiscount` in `src/pricing.ts`");
    expect(user).toContain("`src/checkout.ts:2`");
    expect(user).toContain("applyDiscount(100)");
  });

  it("discloses truncation via a notice when the site cap is hit", async () => {
    const model = new ReplayModel(["[]"]);
    const result = await runReview(
      pr,
      "tok",
      { crossFileCallers: true, crossFileCaps: { maxFileReads: 1 } },
      baseDeps(model),
    );
    // maxFileReads:1 stops the scan before the caller is read → capped/truncated.
    expect(result.notices.some((n) => n.includes("cross-file caller injection truncated"))).toBe(true);
  });
});
