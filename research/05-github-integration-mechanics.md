# PR Review Bot — GitHub (and GitLab/Bitbucket) Integration Mechanics

Research date: 2026-07-29

## 1. Integration approach: GitHub App vs OAuth App vs GitHub Action vs PAT+webhook

### 1.1 GitHub App (recommended for a real product)
- Installs at the **repo or org level**, independent of any human user account. Auth is via a **JWT signed with the app's private key** to mint short-lived (~1 hour) **installation access tokens** scoped to exactly the repos/permissions granted.
- Permissions are **fine-grained, opt-in, and named** (e.g. `pull_requests: write`, `contents: read`, `checks: write`) rather than a single bundled OAuth scope like `repo`. Admins can see and approve exactly what the app can touch.
- Webhooks are **built into the app registration** — you pick events once in the app settings; every installation automatically forwards those events, no per-repo webhook config needed.
- Only GitHub Apps (not OAuth Apps) can create **Check Runs** — required if you want rich inline annotations + a checks-tab UI status.
- Tokens auto-expire and are re-minted per installation, which limits blast radius of a leak versus a long-lived PAT.
- This is the standard shape for commercial PR-review bots (CodeRabbit, Greptile, Korbit, etc. all ship as GitHub Apps).

### 1.2 OAuth App
- Authenticates **as a user**, with coarse scopes (`repo` grants read+write to code, issues, deployments, webhook config, everything at once — no way to grant "PR comments only").
- Webhooks must be manually configured per-repo/org via the API; nothing is bundled at the app level.
- Cannot create Check Runs.
- Reasonable only for user-facing OAuth login flows (e.g. "sign in with GitHub" for your dashboard), not for the bot's repo access — pair it with a GitHub App for actual repo operations.

### 1.3 GitHub Action (marketplace action embedded in customer's own workflow)
- Zero infra to run/host — it executes inside GitHub's own runners inside the customer's CI, triggered by workflow YAML the customer commits (`on: pull_request`).
- Auth is the ephemeral `GITHUB_TOKEN` (or a PAT/App token the customer supplies as a secret) — permissions are declared per-workflow via the `permissions:` block (e.g. `pull-requests: write`, `contents: read`, `checks: write`).
- Pros: no webhook infra, no server to run, works fully inside customer's trust boundary, easy adoption ("just add this step").
- Cons: you don't control execution environment/version pinning as tightly, you're at the mercy of the customer's runner minutes/concurrency, harder to do stateful cross-PR logic (rate-limit backends, org-wide dashboards), and secrets for your own LLM/API keys must be handed to the customer's repo secrets store (trust + rotation burden shifts to them).
- Good complementary/lightweight distribution channel even if the core product is a GitHub App.

### 1.4 Webhook + Personal Access Token (PAT)
- Simplest to hand-roll: register a classic/fine-grained PAT under one human/bot account, manually add a webhook to each repo, verify signature, and call the API with the PAT as bearer auth.
- Downsides: **one long-lived token** (if classic) with broad scope, tied to a human account that can leave/be deactivated, no automatic multi-tenant installation model, per-repo manual webhook wiring, no Check Runs support, worse audit story (all actions appear to come from a person, not "App"). Fine for a personal script or MVP prototype, not for a product serving multiple orgs.

### Summary tradeoff table

| | GitHub App | OAuth App | GitHub Action | PAT + webhook |
|---|---|---|---|---|
| Granular permissions | Yes | No (scope bundles) | Yes (`permissions:` block) | No (PAT scopes are coarse) |
| Check Runs API | Yes | No | Yes (via GITHUB_TOKEN) | No |
| Multi-org install model | Yes (installations) | Partial | N/A (per-repo workflow) | No |
| Webhook config effort | None (declared once) | Per-repo manual | None (event trigger in YAML) | Per-repo manual |
| Token lifetime | ~1hr, auto-rotated | Long-lived unless refreshed | Ephemeral per-job | Long-lived (classic) or configurable (fine-grained) |
| Infra you must host | Yes (webhook receiver) | Yes | No | Yes |
| Best fit | SaaS product across many repos/orgs | User login only | Lightweight/self-hosted distribution | Prototype / single-repo script |

Sources: [Migrating OAuth apps to GitHub Apps](https://docs.github.com/en/developers/apps/getting-started-with-apps/migrating-oauth-apps-to-github-apps), [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps), [Scopes for OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

## 2. Permissions needed (GitHub App)

Minimum permission set for a PR review bot:

- **Pull requests: Read & write** — read PR metadata/diff, post review comments, submit reviews, update PR state.
- **Contents: Read** (write only if you want the bot to push commits/fixes) — needed to fetch file contents/blobs for full-file context beyond the diff hunk.
- **Checks: Read & write** — create/update Check Runs with annotations and a pass/fail conclusion shown in the PR's checks tab.
- **Issues: Read & write** (issue_comment applies to both issues and PRs in the GitHub data model) — needed to read/post the summary comment and to react to slash-commands like `/review`.
- **Metadata: Read** — mandatory baseline permission for every GitHub App, granted implicitly.
- Optional: **Members/Organization**, **Administration** — not needed for a pure review bot; avoid requesting more than necessary since over-broad permission requests are a top reason security-conscious orgs reject an app install.

Source: [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app), [GitHub App permissions checklist](https://www.trylyra.ai/blog/github-app-permissions/).

## 3. Webhook events to subscribe to

| Event | Action filter | Why |
|---|---|---|
| `pull_request` | `opened` | Trigger a first full review when a PR is created |
| `pull_request` | `reopened` | Re-trigger review after a PR is reopened |
| `pull_request` | `synchronize` | Fires on every push of new commits to the PR branch — trigger an **incremental** re-review of just the new commits |
| `pull_request` | `ready_for_review` | Skip draft PRs; only review once marked ready |
| `issue_comment` | `created` | Parse for slash-commands (`/review`, `/review full`, `/summarize`) — GitHub's data model treats PR conversation comments as `issue_comment` events even though the "issue" is a PR |
| `pull_request_review_comment` | `created` | Detect replies to the bot's own inline comments (e.g. "please re-check this") |
| `pull_request_review` | `submitted` | React to a human reviewer's approve/request-changes to decide whether to also gate merge |
| `check_run` / `check_suite` | `rerequested` | Support "re-run check" button from the PR checks UI |
| `installation` / `installation_repositories` | `created`/`deleted` | Track which repos the app is installed on for provisioning/deprovisioning |

Note: for GitHub Apps you select these events once in app settings (delivered to one webhook URL for all installations); for the PAT+webhook path you'd configure them per repo under Settings → Webhooks.

Source: [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

## 4. Webhook signature verification (`X-Hub-Signature-256`)

- When a webhook secret is configured, GitHub sends `X-Hub-Signature-256: sha256=<hex_hmac>` — the HMAC-SHA256 hex digest of the **raw request body** using the shared secret as the HMAC key.
- Verification steps:
  1. Read the **raw, unparsed** request body bytes (do not re-serialize JSON — whitespace/ordering differences break the HMAC).
  2. Compute `hmac_sha256(secret, raw_body)` and hex-encode it, prefixed with `sha256=`.
  3. Compare to the header value using a **constant-time comparison** (`crypto.timingSafeEqual` in Node, `hmac.compare_digest` in Python) — never `===`/`==`, to avoid timing side-channel attacks.
  4. Reject the request (401/403) if the header is missing or the comparison fails, before doing any further processing.
- Each GitHub App has its own webhook secret set at app-registration time (not per-installation); each classic per-repo webhook has its own secret set when the hook is created.
- GitHub also sends `X-Hub-Signature` (SHA-1) for legacy compatibility — always prefer/require the 256 variant.

Sources: [Webhook events and payloads — securing your webhooks](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [community discussion on signature validation](https://github.com/orgs/community/discussions/182735).

## 5. When to trigger a review

- **On open** (`pull_request.opened`): full review of the entire diff against the merge base.
- **On push/synchronize** (`pull_request.synchronize`): the payload includes `before` and `after` SHAs — diff only `before..after` (the new commits) rather than re-reviewing the whole PR, to keep latency/cost down and avoid re-flagging already-acknowledged issues. Track the last-reviewed commit SHA per PR in your own DB.
- **On-demand via comment command**: parse `issue_comment.created` bodies for a command prefix (e.g. `/review`, `/review full`, `/explain`), react to the triggering comment (👀 reaction) for feedback, then run the review pipeline. Useful for forcing a full re-review or invoking a different review mode.
- **On reopen**: treat like a fresh full review since substantial time/drift may have passed.
- Debounce/coalesce rapid pushes (e.g. force-push storms, rebases) with a short delay or by keying work off the latest `synchronize` event per PR to avoid duplicate concurrent reviews.
- Skip draft PRs (`draft: true` in payload) unless explicitly asked, and skip when the actor is the bot itself (avoid infinite loops on its own comments).

## 6. Posting results — APIs and payload shapes

### 6.1 Individual review comment (inline, anchored to a diff line)
`POST /repos/{owner}/{repo}/pulls/{pull_number}/comments`
- `body` (string)
- `commit_id` (string) — SHA the comment applies to
- `path` (string) — file path
- Line anchoring, two supported modes:
  - **Legacy `position`**: an integer counted from the first `@@` hunk header in the unified diff (not the file's absolute line number) — position 1 is the line right after the hunk header.
  - **Modern `line` + `side`**: `line` is the file's line number; `side` is `LEFT` (old/base file) or `RIGHT` (new/head file) — this is the preferred, more intuitive mode and is what most bots use today.
  - For multi-line comments: add `start_line`/`start_side` alongside `line`/`side` to anchor a range.

### 6.2 Batch review submission (preferred for a bot — one round-trip, one notification)
`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`
- `commit_id` (optional, defaults to head)
- `body` (string; required if `event` is `REQUEST_CHANGES` or `COMMENT`)
- `event`: `APPROVE` | `REQUEST_CHANGES` | `COMMENT` (omit to leave the review `PENDING` and submit later)
- `comments`: array of `{ path, line, side, body, start_line?, start_side? }` (or legacy `position`) — this batches all inline findings into one review object instead of N separate comment API calls, producing a single "X reviewed" notification.
- If left pending, finalize with `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events` with `{ event, body }`.

### 6.3 Check Runs (rich annotations + status-check gate)
- `POST /repos/{owner}/{repo}/check-runs` to create; `PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}` to update as the review progresses.
- Fields: `name`, `head_sha`, `status` (`queued`|`in_progress`|`completed`), `conclusion` (`success`|`failure`|`neutral`|`cancelled`|`skipped`|`timed_out`|`action_required`), `started_at`/`completed_at` (ISO8601), `external_id`.
- `output`: `{ title, summary, text, annotations[], images[] }`.
  - `annotations[]`: `{ path, start_line, end_line, start_column?, end_column?, annotation_level: "notice"|"warning"|"failure", message, title?, raw_details? }` — capped at 50 annotations per API call; issue multiple `PATCH` calls to add more.
- Only GitHub Apps can create Check Runs (not OAuth Apps/PATs) — this is a strong argument for the App integration path if you want the checks-tab UX and branch-protection-required-check gating.

### 6.4 Summary comment (upsert pattern)
- No PR-summary-specific endpoint — implement as a regular issue comment: `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` (PR number == issue number in GitHub's model).
- To **upsert** rather than spam a new comment on every push: first `GET /repos/{owner}/{repo}/issues/{issue_number}/comments`, find your bot's prior comment (match by a hidden marker string embedded in the comment body, e.g. an HTML comment `<!-- bot-summary-marker -->`, or by `user.id` == your app's bot user id), then `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` to edit it in place instead of creating a new one.

### 6.5 Fetching PR content for review
- `GET /repos/{owner}/{repo}/pulls/{pull_number}/files` — paginated list of changed files with `patch` (unified diff hunk), `additions`, `deletions`, `status`.
- `GET /repos/{owner}/{repo}/pulls/{pull_number}/commits` — list commits in the PR (useful to diff only new commits since last review).
- `GET /repos/{owner}/{repo}/compare/{base}...{head}` with `Accept: application/vnd.github.v3.diff` — full diff between two SHAs, useful for incremental (`before`..`after` from the `synchronize` payload) diffing.
- Full file content when more context than the hunk is needed: `GET /repos/{owner}/{repo}/contents/{path}?ref={sha}`.

Sources: [REST API endpoints for pull request reviews](https://docs.github.com/en/rest/pulls/reviews), [REST API endpoints for check runs](https://docs.github.com/en/rest/checks/runs), community discussion on diff/compare limitations.

## 7. Rate limits

- **Primary REST limit**: for GitHub App installation tokens, the limit scales with the number of repositories and org members the installation covers (starts around 5,000/hour baseline for an installation, scaling up) — higher than the flat 5,000/hour for a PAT on a personal account.
- **Secondary/abuse rate limits** apply regardless of primary limit headroom:
  - No more than 100 concurrent requests.
  - No more than 900 points/minute for REST endpoints (different endpoints cost different point values).
  - No more than 90 seconds of CPU time per 60 seconds of wall time.
  - No more than 2,000 OAuth/App token (installation token) requests per hour.
- Practical implications for a bot: cache installation tokens for their ~1hr lifetime instead of re-minting per request; batch inline comments via the single Reviews API call rather than N individual comment calls; respect `Retry-After`/`X-RateLimit-Remaining` headers and back off; avoid tight polling loops — prefer webhooks over polling for state changes.

Source: [Rate limits for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/rate-limits-for-github-apps), [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## 8. Handling forks and secrets safely

- A PR opened **from a fork** against `pull_request` trigger context: GitHub issues a **read-only, no-secrets** `GITHUB_TOKEN` and withholds repo/org secrets — this protects against a malicious fork PR exfiltrating secrets or mutating the base repo via a modified workflow file.
- `pull_request_target` runs in the context (and with the secrets/write-token) of the **base repo's default branch workflow**, regardless of what the PR branch contains — this is what lets a bot post comments/checks on fork PRs with real credentials, but it is dangerous if you also explicitly `actions/checkout` the untrusted PR head and then execute anything from it (build scripts, `npm install` postinstall, etc.) — that combination is the classic "pwn request" vector letting a fork PR steal secrets or push to the base repo.
- Safe pattern for a GitHub-App-based bot (not a GitHub Action) sidesteps most of this: your own server holds the installation token/secrets, never runs the PR's code, and only ever reads diffs via the API and calls the review/comment endpoints — so fork-vs-same-repo doesn't materially change your trust boundary the way it does for an in-repo Action.
- If shipping as a **GitHub Action** instead: use `pull_request` (not `pull_request_target`) whenever you must execute any of the PR's own code (linters, test runners) so no secrets are exposed; if you need write access to post comments on fork PRs, split into two workflows — an untrusted `pull_request`-triggered job that only produces an artifact (e.g. lint JSON output), and a trusted `workflow_run`-triggered job (runs on base branch, has secrets) that downloads that artifact and posts the comment/check, never checking out or executing the fork's code.

Sources: [Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target), [GitHub Security Lab: Preventing pwn requests](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/).

## 9. Local webhook development

- **smee.io**: official, GitHub-recommended, purpose-built proxy for GitHub App webhook development. Register a channel (`https://smee.io/<random>`), set it as the app's webhook URL, run the `smee` CLI client locally to forward payloads to `http://localhost:PORT/webhook`. Free, zero-config, but channels are **unauthenticated/unencrypted relays** — never use in production, dev/test only.
- **ngrok** (or **cloudflared tunnel**, **localtunnel**): general-purpose reverse tunnels exposing a local port as a public HTTPS URL; more flexible (arbitrary services, not just GitHub) and give you a real HTTPS endpoint to plug directly into the webhook config, plus request inspection UI (ngrok). Cloudflare Tunnel is free for persistent/named tunnels without ngrok's session-length or reconnect-URL limitations on the free tier.
- Recommended flow: use smee.io during early GitHub-App-specific webhook wiring (matches GitHub's own quickstart tutorials), switch to ngrok/cloudflared once you need to test against other integrations (Slack, GitLab) or want request replay/inspection tooling.

Source: [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps), [smee.io GitHub App docs](https://github.com/vikiboss/smee-it).

## 10. Brief comparison: GitLab and Bitbucket

| | GitHub | GitLab | Bitbucket Cloud |
|---|---|---|---|
| Terminology | Pull Request | Merge Request | Pull Request |
| Integration primitive | GitHub App (installation-based) | Project/Group Access Token + Webhook, or GitLab "OAuth Application"/Integration | App password / OAuth consumer + Webhook (no first-class "App" install model) |
| Event delivery | `pull_request`, `issue_comment`, `pull_request_review`, `check_run` etc. as distinct event **type headers** with an `action` field in the payload | `Merge Request Hook`, `Note Hook` (comments), `Push Hook`, distinct event names via `X-Gitlab-Event` header | Combined event+action in one header, e.g. `pullrequest:created`, `pullrequest:updated`, `pullrequest:approved`, `pullrequest:fulfilled` (merged), `pullrequest:rejected` |
| Signature verification | `X-Hub-Signature-256` HMAC | Static `X-Gitlab-Token` shared-secret header (not HMAC — plain string compare) | **No built-in webhook signature/auth mechanism** — Bitbucket relies on network-level protection (allow-listing Atlassian's egress IPs) or a custom secret embedded in the callback URL |
| Inline review comments | Reviews API with `path`/`line`/`side` | Discussions API (`POST /projects/:id/merge_requests/:mr_iid/discussions`) with `position` object referencing base/head/start SHAs and line numbers | Pull Request Comments API with `inline: { path, to/from line }` |
| Status/check equivalent | Check Runs API | Commit Statuses API (`POST /projects/:id/statuses/:sha`) | Commit Build Status API (`POST /repositories/{workspace}/{repo}/commit/{sha}/statuses/build`) |

Practically: architect the review engine's core (diff parsing, LLM prompting, finding model) provider-agnostic, then write a thin adapter per platform for (a) webhook auth, (b) event-name mapping, (c) comment/status posting — GitHub is the highest-priority target given market share, GitLab is the most similar in shape (real signature-ish header, GraphQL+REST parity), Bitbucket is the outlier needing the most custom auth handling.

Sources: [Webhook Authentication Learnings for GitHub, GitLab, and Bitbucket](https://dev.to/jerk/webhook-authentication-learnings-for-github-gitlab-and-bitbucket-4kml), general platform docs comparison via search.

---

## Key takeaways for the review-bot design

1. Build as a **GitHub App** — it's the only path with fine-grained permissions, Check Runs support, and a clean multi-org install model; treat GitHub Actions as an optional lightweight distribution channel, not the primary architecture.
2. Subscribe to `pull_request` (opened/synchronize/reopened/ready_for_review), `issue_comment` (for slash-commands), and `pull_request_review`; always verify `X-Hub-Signature-256` with constant-time HMAC comparison before trusting a payload.
3. On `synchronize`, diff only `before..after` for incremental review; persist last-reviewed SHA per PR yourself — GitHub gives no native "what's new since I last reviewed" primitive.
4. Post findings via the batched **Reviews API** (one call, one notification) rather than many individual review-comment calls; add a **Check Run** with annotations if you want a checks-tab gate; upsert a single summary comment by matching a hidden marker instead of spamming new comments per push.
5. Respect both primary and secondary (900 pts/min, 100 concurrent, 2000 token-mints/hr) rate limits; cache installation tokens for their ~1hr life.
6. Never execute a fork PR's own code with secrets attached — a pure API-driven GitHub App reviewer largely sidesteps the `pull_request_target` "pwn request" trap that hits Action-based reviewers.
7. Use smee.io for GitHub-App-specific local webhook dev; graduate to ngrok/cloudflared tunnel for multi-platform or inspection-heavy testing.
8. GitLab is architecturally closest to GitHub (adapt via Discussions + Commit Statuses APIs); Bitbucket needs the most bespoke auth handling since it has no native signature verification.
