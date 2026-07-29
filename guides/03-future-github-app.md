# 03 — The Future GitHub App (Mode A) — DEFERRED

**Status: not being built now.** The worker code that makes this mode
possible is already implemented and tested (`packages/worker`, part of M3),
but nothing is registered, deployed, or installed anywhere. This guide exists
so future-Ansh (or future-Claude) can pick it up without re-deriving the
plan. For what IS shipping now, see
**[guide 02](./02-plan-b-open-source-action.md)**.

## What the hosted App model is, and how it differs

Today (Mode B, the Action): every consumer adds a workflow file to their own
repo and brings their own `GITHUB_TOKEN` + LLM key. There is no install step
and nothing hosted by Ansh.

The App model (Mode A) inverts that:

- **One GitHub App**, registered once by Ansh (`docs/github-app-setup.md` has
  the exact registration steps and permission set).
- **One hosted webhook server** — `packages/worker`, a Hono app on Cloudflare
  Workers — that GitHub pushes `pull_request` and `issue_comment` events to.
- **Users just click Install** on their repo(s). No workflow YAML, no
  per-repo secret, no per-repo wiring at all.
- **Per-installation tokens**: the worker already implements JWT → GitHub
  App installation-token minting with ~1h in-memory caching
  (`packages/worker/src/appAuth.ts`), so the same App can review PRs across
  every repo it's installed on without any repo-side configuration.
- It also unlocks slash commands (`/review`, `/ask`) gated to repo
  collaborators, and Check Runs as a natural extension later — neither of
  which the Action path can offer without a workflow file.

Both modes drive the exact same `packages/engine` core — the worker adapter
is proven out by the same 399-test suite (`packages/worker/src/route.test.ts`
and friends run in the same `vitest run`), it's simply never been pointed at
a real GitHub App or a real deployment.

## Step-by-step to make it real LATER

When this is picked back up, in order:

1. **Register the App.** Full checklist already written:
   [`docs/github-app-setup.md`](../docs/github-app-setup.md). Covers exact
   permissions (`Pull requests: r/w`, `Contents: read`, `Issues: r/w`,
   `Checks: r/w`, `Metadata: read`), subscribed events (`pull_request`,
   `issue_comment`), and the two secrets to collect (App ID, private key —
   note GitHub hands out PKCS#1 and the worker needs PKCS#8, conversion
   command included in that doc; webhook secret).
2. **Deploy the worker to Cloudflare.**
   - `wrangler secret put GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
     `GITHUB_WEBHOOK_SECRET`, plus whichever LLM key(s) (`ANTHROPIC_API_KEY`,
     `GEMINI_API_KEY`, `GROQ_API_KEY`) the deployment will use.
   - `wrangler kv namespace create REVIEW_STATE` and wire the real namespace
     id into `packages/worker/wrangler.toml`'s KV binding (today it holds a
     placeholder; `wrangler dev` simulates the binding locally without one).
   - `wrangler deploy` (from `packages/worker`) publishes the Worker and
     gives back a `https://<name>.<subdomain>.workers.dev` URL.
3. **Point the App's webhook URL at the deployed Worker** —
   `https://<worker>.workers.dev/webhook` — replacing the smee.io dev proxy
   URL used during local development.
4. **Flip the App to Public** (GitHub App settings → make it installable by
   others) once steps 1–3 are verified working on Ansh's own repos. Only then
   can anyone besides Ansh install it.

Live-verification checklist for this path (task 5.9) lives in
[guide 04](./04-how-to-run-and-test.md).

## The economic reality: one key, every user's bill

This is the load-bearing trade-off of Mode A, and the reason it's deferred:

With a single LLM API key configured server-side on the Worker, **every
review, on every installed repo, on every user's account, is billed to
Ansh's own key.** The per-run token caps and monthly-budget degrade-to-free
mechanism (`packages/engine/src/cost.ts`) put a ceiling on runaway spend per
run and per month, but they don't change who pays — it's still Ansh funding
every installation's usage, capped rather than unbounded.

Compare Mode B (guide 02): every consumer brings their own key, so Ansh's
account is never billed for anyone else's reviews. That asymmetry is exactly
why the Action ships first and the App waits.

For a real multi-user product built on top of this App, you would need — all
of which are **explicit v1 non-goals**, cited from `design.md`:

- **Bring-your-own-key per installation** — today one server-side key serves
  every install; per-installation key storage/isolation doesn't exist.
- **Per-tenant config isolation** — `.aireview.toml`/`HOUSE_RULES.md` are
  already per-repo, but there's no per-organization or per-customer account
  model, billing plan, or isolation boundary above "per repo."
- **Usage metering / billing** — the run log (`runlog.ts`) gives per-run
  cost data for *Ansh's own* self-analytics, not a billing system for
  charging installs.
- **A dashboard** — `design.md`'s non-goals are explicit: *"No dashboard/web
  UI/analytics product; no multi-tenancy, billing, or SaaS."* The PR comments
  and a JSONL log file are the entire UI by design.

None of that is being built now. If Mode A is ever opened to the public,
these are the concrete gaps to close first — recorded here as a decision,
not an oversight.

## Status: DEFERRED

Code: done and tested. Registration, deploy, and public install: not started,
not scheduled. Revisit only after Mode B (the Action) is live-verified end to
end per [guide 04](./04-how-to-run-and-test.md), and only if there's an
actual reason to want zero-workflow-file installs badly enough to accept
footing everyone else's LLM bill.
