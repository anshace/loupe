# GitHub App setup checklist (task 5.1 — deferred, do manually later)

The worker code (packages/worker) is done and tested; nothing is deployed and
no App is registered yet. When you're ready, follow this checklist. Everything
here stays local except the App registration itself on github.com.

## 1. Register the App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

- **Name**: anything unique, e.g. `ansh-code-review`. The App's bot login
  becomes `<name>[bot]` — that exact string is the worker's `BOT_LOGIN` var
  (self-event skipping).
- **Homepage URL**: the repo URL is fine.
- **Webhook URL**:
  - For local dev: your smee.io channel URL (see §4).
  - After a real deploy: `https://<worker>.workers.dev/webhook`.
- **Webhook secret**: generate one (`openssl rand -hex 32`), save it — it
  becomes `GITHUB_WEBHOOK_SECRET`.

### Permissions (from design.md / tasks.md 5.1 — least privilege)

| Permission     | Access        | Why |
|----------------|---------------|-----|
| Pull requests  | Read & write  | fetch diffs, post reviews/inline comments |
| Contents       | Read-only     | `.aireview.toml`, `HOUSE_RULES.md` at PR head |
| Issues         | Read & write  | summary comment upsert, /ask replies, 👀 reactions |
| Checks         | Read & write  | Check Runs (open question — may stay unused at M3) |
| Metadata       | Read-only     | mandatory baseline |

### Subscribed events

- **Pull request** (`pull_request`: opened / synchronize / reopened / ready_for_review)
- **Issue comment** (`issue_comment`: created — carries `/review` and `/ask`)

- **Where can this App be installed?** Only on this account is fine.

## 2. Collect the three App secrets

1. **App ID** — shown on the App's settings page → `GITHUB_APP_ID`.
2. **Private key** — "Generate a private key" downloads a `.pem`.
   GitHub hands out **PKCS#1** (`-----BEGIN RSA PRIVATE KEY-----`); the worker
   requires **PKCS#8** (`-----BEGIN PRIVATE KEY-----`, WebCrypto limitation).
   Convert once:
   ```
   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem
   ```
   The full PKCS#8 file content (including BEGIN/END lines) → `GITHUB_APP_PRIVATE_KEY`.
3. **Webhook secret** — from §1 → `GITHUB_WEBHOOK_SECRET`.

## 3. Store secrets

**Local dev** (`wrangler dev` reads `packages/worker/.dev.vars`, gitignored):

```
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
```

**Deployed worker** (later, when deploying is explicitly decided):

```
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GEMINI_API_KEY
```

Optional non-secret vars (`[vars]` in wrangler.toml or `.dev.vars`):
`BOT_LOGIN=<app-name>[bot]`, `REVIEW_MODEL=haiku|gemini|groq`,
`GROQ_API_KEY` if the Groq fallback is used.

## 4. Local webhook loop with smee.io

Workers dev runs on localhost, which GitHub can't reach; smee.io proxies
deliveries in:

1. Open https://smee.io → **Start a new channel** → copy the URL.
2. Set that URL as the App's Webhook URL.
3. Terminal 1: `nub run dev:worker` (embeds the prompt, then `wrangler dev`
   on http://localhost:8787).
4. Terminal 2: `npx smee-client --url https://smee.io/<channel> --target http://localhost:8787/webhook`
5. Install the App on the test repo(s), open/push to a dummy PR, watch the run.

Note: smee forwards the original `X-Hub-Signature-256` header untouched, so
HMAC verification works end-to-end through the proxy.

## 5. Verify (task 5.9)

- Install the App on ≥2 local test repos; PRs on both get reviews with **no
  workflow file** in either repo.
- `curl -X POST http://localhost:8787/webhook -d '{}'` (unsigned) → **401**.
- Tampered signature → **401**; nothing is processed.
- Collaborator comments `/review` → 👀 reaction appears first, then the review
  (even when the head SHA was already reviewed).
- Non-collaborator `/review` or `/ask` → absolutely nothing (no run, no
  comment, no reaction).
- `/ask <question>` from a collaborator → 👀 then one comment answering from
  the diff.
