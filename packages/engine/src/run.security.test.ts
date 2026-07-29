/**
 * Integration tests for the deterministic security pre-passes (features #2, #4)
 * wired into the full review pipeline: secret findings and workflow findings
 * must flow through the normal publish path (anchor + suppress + dedupe) and
 * survive a degraded model response.
 */
import { describe, expect, it } from "vitest";
import type { ExistingComments } from "./dedupe";
import type { FetchLike } from "./diff";
import { MockProvider } from "./model";
import { runReview } from "./run";
import type { RunDeps } from "./run";
import type { AuthToken, EngineConfig, PrIdentity, ReviewPayload } from "./types";

const pr = { owner: "anshace", repo: "demo", prNumber: 9 };
const NO_COMMENTS: ExistingComments = { reviewComments: [], issueComments: [] };

function diffFetch(diff: string): FetchLike {
  return async () => ({ ok: true, status: 200, text: async () => diff });
}

function newFileDiff(path: string, lines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..2222222 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    lines.map((l) => `+${l}`).join("\n"),
  ].join("\n");
}

interface Captured {
  posts: ReviewPayload[];
  upserts: Array<{ body: string; existingId?: number }>;
  deps: RunDeps;
}

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

const baseConfig: EngineConfig = { event: { headSha: "abc123" }, minSeverity: "low", escalation: false };

function run(config: EngineConfig, deps: RunDeps) {
  return runReview(pr, "tok", config, deps);
}

const SECRET_DIFF = newFileDiff("src/config.ts", ["export const config = {", '  apiKey: "AKIA1234567890ABCDEF",', "};"]);

describe("runReview — secret pre-pass (feature #2)", () => {
  it("emits a critical inline comment for a committed secret, without the model finding it", async () => {
    const { posts, deps } = capture();
    const result = await run(baseConfig, { ...deps, fetchImpl: diffFetch(SECRET_DIFF), model: new MockProvider("[]") });

    const secret = result.findings.find((f) => f.category === "secret");
    expect(secret).toBeDefined();
    expect(secret?.severity).toBe("critical");
    expect(secret?.file).toBe("src/config.ts");
    expect(secret?.line).toBe(2);
    // Redacted — the raw key never appears in the posted comment.
    expect(posts[0].comments.some((c) => c.path === "src/config.ts" && c.line === 2)).toBe(true);
    expect(posts[0].comments.map((c) => c.body).join("\n")).not.toContain("AKIA1234567890ABCDEF");
  });

  it("survives a degraded model response — the deterministic finding still posts", async () => {
    const { posts, deps } = capture();
    const result = await run(baseConfig, {
      ...deps,
      fetchImpl: diffFetch(SECRET_DIFF),
      model: new MockProvider("I'm sorry, I can't do that."),
    });
    expect(result.degraded).toBe(true);
    expect(result.findings.some((f) => f.category === "secret")).toBe(true);
    expect(posts[0].comments.some((c) => c.path === "src/config.ts")).toBe(true);
  });

  it("respects secret_allow_paths from .aireview.toml", async () => {
    const { deps } = capture();
    const result = await run(baseConfig, {
      ...deps,
      repoFiles: { config: 'secret_allow_paths = ["src/**"]' },
      fetchImpl: diffFetch(SECRET_DIFF),
      model: new MockProvider("[]"),
    });
    expect(result.findings.some((f) => f.category === "secret")).toBe(false);
  });
});

describe("runReview — workflow supply-chain checks (feature #4)", () => {
  const WORKFLOW_DIFF = newFileDiff(".github/workflows/ci.yml", [
    "jobs:",
    "  build:",
    "    steps:",
    "      - uses: evil-org/action@v1",
  ]);

  it("emits a supply-chain finding for an unpinned third-party action", async () => {
    const { posts, deps } = capture();
    const result = await run(baseConfig, { ...deps, fetchImpl: diffFetch(WORKFLOW_DIFF), model: new MockProvider("[]") });

    const finding = result.findings.find((f) => f.category === "supply-chain");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("high");
    expect(finding?.file).toBe(".github/workflows/ci.yml");
    expect(finding?.line).toBe(4);
    expect(posts[0].comments.some((c) => c.path === ".github/workflows/ci.yml" && c.line === 4)).toBe(true);
  });
});
