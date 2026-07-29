/**
 * Integration tests through the Hono app: signature gate ordering (5.3),
 * event routing into the engine entry (5.4), token minting (5.5),
 * collaborator gating for /review + /ask (5.6), and the 👀 reaction being
 * added before any review work (5.7) — all via recorded mock fetch ordering.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FetchLike, ReviewResult, runReview } from "@code-review/engine";
import { MockProvider } from "@code-review/engine";
import { createApp } from "./app";
import type { HandlerDeps, WorkerEnv } from "./handlers";
import { signWebhookBody } from "./verify";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const SECRET = "webhook-s3cret";
const ENV: WorkerEnv = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: PRIVATE_PEM,
  GITHUB_WEBHOOK_SECRET: SECRET,
  BOT_LOGIN: "review-bot[bot]",
};

const FAKE_RESULT = { findings: [], posted: true } as unknown as ReviewResult;

const repoParts = {
  repository: { name: "repo", owner: { login: "owner" } },
  installation: { id: 555 },
};

const prOpened = {
  action: "opened",
  pull_request: { number: 42, draft: false, head: { sha: "abc123" } },
  sender: { login: "alice" },
  ...repoParts,
};

function comment(body: string, user = "alice"): Record<string, unknown> {
  return {
    action: "created",
    issue: { number: 42, pull_request: { url: "x" } },
    comment: { id: 900, body, user: { login: user } },
    sender: { login: user },
    ...repoParts,
  };
}

interface Recorded {
  label: string;
  url: string;
  method: string;
  body?: string;
}

/** Mock GitHub API recording every call, with a per-user permission table. */
function mockGitHub(permissions: Record<string, string> = { alice: "write" }) {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const accept = init?.headers?.accept ?? "";
    const respond = (label: string, json: unknown, status = 200) => {
      calls.push({ label, url, method, body: init?.body });
      return {
        ok: status < 300,
        status,
        text: async () => (typeof json === "string" ? json : JSON.stringify(json)),
      };
    };

    if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) {
      return respond("mint-token", {
        token: "installation-token",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (/\/collaborators\/([^/]+)\/permission$/.test(url)) {
      const user = decodeURIComponent(/\/collaborators\/([^/]+)\/permission$/.exec(url)![1]);
      const permission = permissions[user];
      return permission ? respond("permission", { permission }) : respond("permission", "Not Found", 404);
    }
    if (/\/issues\/comments\/\d+\/reactions$/.test(url)) {
      return respond("eyes-reaction", { id: 1, content: "eyes" }, 201);
    }
    if (/\/pulls\/42$/.test(url) && accept.includes("diff")) {
      return respond(
        "fetch-diff",
        "diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
      );
    }
    if (/\/pulls\/42$/.test(url)) {
      return respond("fetch-pr", { head: { sha: "head-sha-from-api" }, draft: false });
    }
    if (/\/issues\/42\/comments$/.test(url) && method === "POST") {
      return respond("post-comment", { id: 2 });
    }
    return respond("unexpected", { url }, 500);
  };
  return { calls, fetchImpl };
}

interface TestHarness {
  request: (payload: unknown, eventName?: string, tamper?: (body: string) => Promise<string> | string) => Promise<Response>;
  flush: () => Promise<void>;
  calls: Recorded[];
  review: ReturnType<typeof vi.fn>;
}

function harness(deps: Partial<HandlerDeps> & { permissions?: Record<string, string> } = {}): TestHarness {
  const { calls, fetchImpl } = mockGitHub(deps.permissions);
  const review = vi.fn(async () => {
    calls.push({ label: "run-review", url: "(engine)", method: "CALL" });
    return FAKE_RESULT;
  });
  const app = createApp({
    fetchImpl: deps.fetchImpl ?? fetchImpl,
    review: review as unknown as typeof runReview,
    model: deps.model ?? new MockProvider(),
  });

  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException: () => undefined,
    props: {},
  };

  return {
    calls,
    review,
    flush: async () => {
      await Promise.all(tasks);
    },
    request: async (payload, eventName = "pull_request", tamper) => {
      const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
      const signature = tamper ? await tamper(raw) : await signWebhookBody(SECRET, raw);
      return app.request(
        "/webhook",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": eventName,
            ...(signature ? { "x-hub-signature-256": signature } : {}),
          },
          body: raw,
        },
        ENV,
        ctx as never,
      );
    },
  };
}

describe("POST /webhook — signature gate (5.3)", () => {
  it("rejects an unsigned delivery with 401 and touches nothing", async () => {
    const h = harness();
    const res = await h.request(prOpened, "pull_request", () => "");
    expect(res.status).toBe(401);
    await h.flush();
    expect(h.calls).toHaveLength(0);
    expect(h.review).not.toHaveBeenCalled();
  });

  it("rejects a forged signature with 401 even when the JSON is valid and actionable", async () => {
    const h = harness();
    const res = await h.request(prOpened, "pull_request", (raw) => signWebhookBody("wrong-secret", raw));
    expect(res.status).toBe(401);
    await h.flush();
    // Valid JSON + invalid signature: the parse/dispatch stage is never reached.
    expect(h.calls).toHaveLength(0);
    expect(h.review).not.toHaveBeenCalled();
  });

  it("verifies BEFORE parsing: invalid JSON with a valid signature reaches the parse stage (400)", async () => {
    const h = harness();
    const res = await h.request("{not json", "pull_request");
    expect(res.status).toBe(400);
  });

  it("invalid JSON with an invalid signature is a 401, not a 400", async () => {
    const h = harness();
    const res = await h.request("{not json", "pull_request", () => "sha256=" + "00".repeat(32));
    expect(res.status).toBe(401);
  });
});

describe("POST /webhook — pull_request routing (5.4 + 5.5)", () => {
  it("dispatches an opened PR into runReview with the mapped RunEvent and a minted token", async () => {
    const h = harness();
    const res = await h.request(prOpened);
    expect(res.status).toBe(202);
    await h.flush();

    expect(h.review).toHaveBeenCalledTimes(1);
    const [pr, token, config] = h.review.mock.calls[0] as unknown[];
    expect(pr).toEqual({ owner: "owner", repo: "repo", prNumber: 42 });
    expect(token).toBe("installation-token");
    expect(config).toMatchObject({
      botIdentity: "review-bot[bot]",
      event: { isDraft: false, actor: "alice", headSha: "abc123", onDemand: false },
    });
    expect(h.calls.map((c) => c.label)).toEqual(["mint-token", "run-review"]);
  });

  it("passes draft state through so the engine gate can skip it", async () => {
    const h = harness();
    await h.request({ ...prOpened, pull_request: { ...prOpened.pull_request, draft: true } });
    await h.flush();
    expect(h.review.mock.calls[0][2]).toMatchObject({ event: { isDraft: true } });
  });

  it("answers 204 for non-triggering pull_request actions and does nothing", async () => {
    const h = harness();
    const res = await h.request({ ...prOpened, action: "labeled" });
    expect(res.status).toBe(204);
    await h.flush();
    expect(h.calls).toHaveLength(0);
  });

  it("answers 204 for unrelated events", async () => {
    const h = harness();
    const res = await h.request({ zen: "Anything added dilutes everything else." }, "ping");
    expect(res.status).toBe(204);
  });

  it("mints the installation token once across deliveries (in-memory cache)", async () => {
    const h = harness();
    await h.request(prOpened);
    await h.request({ ...prOpened, action: "synchronize" });
    await h.flush();
    expect(h.calls.filter((c) => c.label === "mint-token")).toHaveLength(1);
    expect(h.review).toHaveBeenCalledTimes(2);
  });
});

describe("POST /webhook — /review command (5.6 + 5.7)", () => {
  it("runs on-demand for a write collaborator, with 👀 added BEFORE the review runs", async () => {
    const h = harness();
    const res = await h.request(comment("/review"), "issue_comment");
    expect(res.status).toBe(202);
    await h.flush();

    // Recorded ordering is the contract: permission gate → ack → work.
    expect(h.calls.map((c) => c.label)).toEqual([
      "mint-token",
      "permission",
      "eyes-reaction",
      "fetch-pr",
      "run-review",
    ]);
    const [pr, , config] = h.review.mock.calls[0] as unknown[];
    expect(pr).toEqual({ owner: "owner", repo: "repo", prNumber: 42 });
    // onDemand overrides the already-reviewed-SHA skip; head comes from the API.
    expect(config).toMatchObject({
      event: { onDemand: true, actor: "alice", headSha: "head-sha-from-api", isDraft: false },
    });
  });

  it("ignores a non-collaborator completely: no run, no comment, no reaction", async () => {
    const h = harness({ permissions: { alice: "read" } });
    const res = await h.request(comment("/review"), "issue_comment");
    expect(res.status).toBe(202); // GitHub gets its ack; internally nothing happens
    await h.flush();
    expect(h.calls.map((c) => c.label)).toEqual(["mint-token", "permission"]);
    expect(h.review).not.toHaveBeenCalled();
  });

  it("treats a 404 permission response (total stranger) the same way", async () => {
    const h = harness({ permissions: {} });
    await h.request(comment("/review", "rando"), "issue_comment");
    await h.flush();
    expect(h.calls.map((c) => c.label)).toEqual(["mint-token", "permission"]);
    expect(h.review).not.toHaveBeenCalled();
  });

  it("accepts maintain permission", async () => {
    const h = harness({ permissions: { alice: "maintain" } });
    await h.request(comment("/review"), "issue_comment");
    await h.flush();
    expect(h.review).toHaveBeenCalledTimes(1);
  });

  it("answers 204 for a plain comment", async () => {
    const h = harness();
    const res = await h.request(comment("nice work!"), "issue_comment");
    expect(res.status).toBe(204);
    await h.flush();
    expect(h.calls).toHaveLength(0);
  });
});

describe("POST /webhook — /ask command (5.6)", () => {
  it("answers with one model call over the diff, posted as a comment, ack first", async () => {
    const model = new MockProvider("The rename is safe — no other callers.");
    const h = harness({ model });
    const res = await h.request(comment("/ask is the rename safe?"), "issue_comment");
    expect(res.status).toBe(202);
    await h.flush();

    expect(h.calls.map((c) => c.label)).toEqual([
      "mint-token",
      "permission",
      "eyes-reaction",
      "fetch-diff",
      "post-comment",
    ]);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0].user).toContain("is the rename safe?");
    expect(model.requests[0].user).toContain("diff --git");

    const posted = JSON.parse(h.calls.find((c) => c.label === "post-comment")!.body!) as { body: string };
    expect(posted.body).toContain("The rename is safe — no other callers.");
    expect(h.review).not.toHaveBeenCalled();
  });

  it("stays completely silent for a non-collaborator /ask", async () => {
    const h = harness({ permissions: { alice: "read" } });
    await h.request(comment("/ask what does this do?"), "issue_comment");
    await h.flush();
    expect(h.calls.map((c) => c.label)).toEqual(["mint-token", "permission"]);
  });
});

describe("GET /healthz", () => {
  it("responds ok without auth", async () => {
    const app = createApp({ fetchImpl: mockGitHub().fetchImpl });
    const res = await app.request("/healthz", {}, ENV);
    expect(res.status).toBe(200);
  });
});
