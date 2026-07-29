/**
 * The Hono app (task 5.2): the GitHub App webhook adapter for Cloudflare
 * Workers. Route handlers stay thin — verification (verify.ts), routing
 * (route.ts), and work (handlers.ts) are separately tested modules.
 */
import { Hono } from "hono";
import { InstallationTokenCache } from "./appAuth";
import type { HandlerDeps, WorkerEnv } from "./handlers";
import { handleCommandDispatch, handleReviewDispatch } from "./handlers";
import { mapWebhook } from "./route";
import { verifyWebhookSignature } from "./verify";

export function createApp(deps: HandlerDeps = {}): Hono<{ Bindings: WorkerEnv }> {
  const app = new Hono<{ Bindings: WorkerEnv }>();

  // Installation-token cache lives per isolate; lazily built on first use so
  // env bindings (only available per-request on Workers) can seed it.
  let tokenCache: InstallationTokenCache | undefined;
  const tokens = (env: WorkerEnv): InstallationTokenCache =>
    (tokenCache ??= new InstallationTokenCache({
      appId: env.GITHUB_APP_ID,
      privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
      fetchImpl: deps.fetchImpl,
    }));

  app.get("/healthz", (c) => c.text("ok"));

  app.post("/webhook", async (c) => {
    // 1. Raw body FIRST — the signature covers the exact bytes GitHub sent.
    const rawBody = await c.req.text();
    const verified = await verifyWebhookSignature(
      c.env.GITHUB_WEBHOOK_SECRET,
      rawBody,
      c.req.header("x-hub-signature-256"),
    );
    // 2. Missing/invalid signature → 401, and NOTHING below runs (no parse).
    if (!verified) return c.text("signature missing or invalid", 401);

    // 3. Only a verified body is ever parsed.
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.text("payload is not valid JSON", 400);
    }

    const dispatch = mapWebhook(c.req.header("x-github-event"), payload);
    if (dispatch.kind === "ignore") return c.body(null, 204);

    const work =
      dispatch.kind === "review"
        ? handleReviewDispatch(dispatch, c.env, tokens(c.env), deps)
        : handleCommandDispatch(dispatch, c.env, tokens(c.env), deps);

    // Production consideration: GitHub's delivery timeout is ~10s, while a
    // review run (diff fetch + model call + posting) can take far longer.
    // waitUntil ACKs the delivery immediately and keeps the isolate alive
    // until the deferred work settles; without it the runtime could cancel
    // the promise as soon as the response is returned.
    c.executionCtx.waitUntil(
      work.catch((err: unknown) => {
        console.error("webhook processing failed:", err instanceof Error ? err.message : err);
      }),
    );
    return c.text("accepted", 202);
  });

  return app;
}
