# Tasks: build-pr-review-agent

## 1. Project Setup

- [x] 1.1 Initialize TypeScript monorepo workspace (npm workspaces): root `package.json`, `tsconfig.json` base, strict mode, vitest for tests
- [x] 1.2 Create `packages/engine` as a pure library package with the trigger-agnostic entry signature `(prIdentity, authToken, config)` and no GitHub-trigger imports; stub types for `Finding`, `ReviewResult`, `RunOptions`
- [x] 1.3 Create `prompts/` folder for versioned markdown prompt files with a naming/versioning convention documented in a short header comment of the first file
- [x] 1.4 Create a local test repository (separate folder, own git init) with seed source files for generating dummy PRs; document the dummy-PR workflow in `docs/`
- [x] 1.5 Set up lint/typecheck/test scripts at the root and verify `npm run build && npm test` passes on the empty skeleton

## 2. M0 — Hello-World Action

- [x] 2.1 Write `.github/workflows/review.yml` for the test repo triggering on `pull_request` types `opened`, `synchronize`, `reopened`, `ready_for_review`, with a least-privilege `permissions:` block for `GITHUB_TOKEN`
- [x] 2.2 Create `packages/action` wrapper: ~50-line script that reads the event payload and extracts PR number, head SHA, file count, +/- line stats
- [x] 2.3 Post a static stats comment ("review bot was here — N files, +X/−Y") via `GITHUB_TOKEN` using `@actions/github`, going through the engine package boundary (adapter calls engine, engine returns comment body)
- [ ] 2.4 Verify: opening a dummy PR on the test repo produces the comment within ~1 min using only `GITHUB_TOKEN`; re-running the workflow does not crash

## 3. M1 — Real Single-Pass Review

- [x] 3.1 Implement diff fetching in the engine via the GitHub API (`Accept: application/vnd.github.diff`) for a PR identity + token
- [x] 3.2 Implement unified-diff parser: files → hunks with valid new-side (right-side) line numbers, producing the set of commentable lines per file
- [x] 3.3 Implement noise-file filter (lockfiles, generated, vendored, binary) applied before any model call, returning a skipped-file count for the summary
- [x] 3.4 Implement diff size cap: deterministic truncation with a machine-readable record of what was excluded (files/portions), for disclosure in the summary — never silent
- [x] 3.5 Define the thin `ReviewModel` provider interface (prompt in → raw text out + real token counts) and implement the Gemini 2.5 Flash free-tier provider behind it
- [x] 3.6 Write `prompts/reviewer-v1.md`: severity rubric (critical/high/medium/low/nit), required JSON findings schema `{severity, category, file, line, title, body, suggestion?}`, and the valid commentable line ranges injected as an explicit constraint
- [x] 3.7 Implement the defensive JSON guardrail: tolerate alternate key names and bare lists, drop individually malformed findings while keeping valid ones, degrade to summary-only on fully unparseable output — a run never terminates with an unhandled failure on bad model output (unit tests for each failure shape)
- [x] 3.8 Implement line clamping: findings anchored outside valid diff lines are clamped to the nearest valid line or reclassified file-level, without erroring the run
- [x] 3.9 Implement batched review posting: all inline findings in ONE `POST /pulls/{n}/reviews` call with an overall body — exactly one review per run
- [x] 3.10 Handle the clean-PR path: zero findings above threshold completes with a "no issues found" summary
- [ ] 3.11 Verify: a deliberately buggy dummy PR gets ≥1 correct inline comment on the right line; a docs-only PR gets a clean summary; injected-garbage LLM output does not crash; total run <2 min

## 4. M2 — Quality & Idempotency

- [x] 4.1 Add the explicit do-not-report list to the prompt (style nits, speculative concerns, unchanged-code issues below high severity) and a code-side suppression filter that drops such findings before publishing
- [x] 4.2 Implement the fallback anchoring chain: exact line → nearest commentable diff line (≤50 away) → file-level comment → inclusion in summary; assert in tests that no finding is ever silently dropped
- [x] 4.3 Implement stateless dedupe: read existing bot comments on the PR via API and skip candidate findings that duplicate an existing comment at the same location/substance
- [x] 4.4 Implement summary upsert: one summary comment per PR identified by a hidden HTML marker; edit in place when it exists, create only when absent; summary carries skipped-file count, truncation disclosure, and config notices
- [x] 4.5 Implement the run gate in the engine: skip draft PRs, skip events whose actor is the bot itself, skip when the head SHA matches the last completed review (recorded in the hidden summary marker) unless explicitly requested on demand
- [x] 4.6 Implement `.aireview.toml` loading from the reviewed revision of the target repo (via contents API at the PR head): enable/disable toggle, minimum severity threshold, ignored path globs
- [x] 4.7 Apply config semantics: disabled repo → no run and no comments; findings below threshold never published inline or in summary; ignored-glob files excluded from review with no findings ever reported against them
- [x] 4.8 Implement safe defaults: missing config → documented defaults (enabled, default threshold, standard noise ignores); malformed/invalid config → run proceeds on defaults and the summary shows a visible config-problem notice (never crash, never skip)
- [x] 4.9 Implement optional `HOUSE_RULES.md` support: file content supplied to the prompt, and findings contradicting an explicit house rule suppressed before publishing; absent file → no suppression
- [x] 4.10 Implement the Claude Haiku 4.5 provider with prompt caching on the stable system prompt; make it the quality default with Gemini Flash as the free-tier mode (provider selection via config/env, plus Groq Llama as free fallback)
- [x] 4.11 Implement per-run token/cost cap from real provider token counts and a monthly budget env var that degrades to the free-tier model when exceeded; on cap hit mid-run, stop model calls and publish what exists with an early-stop notice
- [ ] 4.12 Verify: pushing twice to the same PR produces zero duplicate comments; the summary is edited in place, not re-posted; a `HOUSE_RULES.md` rule suppresses its matching finding; style nitpicks no longer appear; a draft PR gets no comments
- [ ] 4.13 Verify: repo with no config reviews on defaults; repo with broken TOML still reviews and the summary notes the invalid config; changing config in the repo takes effect on the next PR with no redeploy

## 5. M3 — GitHub App + Worker

- [ ] 5.1 Register the GitHub App (permissions: Pull requests r/w, Contents read, Issues r/w, Checks r/w, Metadata; events: pull_request, issue_comment); store App ID, private key, and webhook secret as local dev secrets — no deploy yet
- [x] 5.2 Scaffold `packages/worker` with Hono targeting the Cloudflare Workers runtime; local dev via `wrangler dev` + smee.io webhook proxy into the test repo
- [x] 5.3 Implement raw-body HMAC-SHA256 webhook signature verification with constant-time compare BEFORE any payload parsing; missing/invalid signature → 401 and no further processing (tests with forged and unsigned payloads)
- [x] 5.4 Implement event routing: `pull_request` (opened/synchronize/reopened/ready_for_review) and `issue_comment` (`/review`, `/ask`) dispatch into the same engine gate used by the Action path
- [x] 5.5 Implement JWT → installation token minting with ~1h in-memory caching per installation
- [x] 5.6 Implement `/review` and `/ask` command handling gated to repository collaborators via the collaborators API; non-collaborator commands ignored with no run, comment, or reaction; `/review` on an already-reviewed head SHA still runs (explicit request overrides the skip)
- [x] 5.7 Implement the 👀 reaction acknowledgment on the triggering comment for accepted commands, added before any review output is posted
- [x] 5.8 Keep the Action path green: run the Action adapter's tests in CI alongside the worker's to confirm both wrappers drive the same engine
- [ ] 5.9 Verify: App installed on ≥2 local test repos reviews PRs on both with no workflow file; forged/unsigned webhooks get 401; collaborator `/review` triggers a run with a reaction ack; non-collaborator `/review` produces nothing

## 6. M4 — Context Depth + Verifier

- [x] 6.1 Implement enclosing-function/class expansion per hunk using a regex heuristic, feeding the expanded scope to the reviewer as context
- [x] 6.2 Replace the regex heuristic with tree-sitter (start with the languages actually in the test repos, e.g. TS/JS) behind the same expansion interface
- [x] 6.3 Implement capped agentic tools for the reviewer: grep and file-read against the repo via API, with hard caps on hop count, file reads, and bytes per run
- [x] 6.4 Write `prompts/verifier-v1.md` and implement the verifier pass: a second tool-equipped LLM call that must keep/rewrite/drop each finding with cited `file:line` evidence and a closed drop-reason enum (false-claim / pre-existing / repo-convention / out-of-scope / theoretically-impossible)
- [x] 6.5 Implement risk-based model escalation: path heuristic (auth/payments/migrations) routes the review to Sonnet 5; everything else stays on the default model
- [x] 6.6 Extend cost controls for the two-pass pipeline: per-PR cap covers reviewer + verifier + agentic calls; verifier and agentic search are skipped (with summary disclosure) when the cap would be exceeded
- [x] 6.7 Build a personal eval set of ~20 dummy PRs (seeded bugs, cross-file breaks, clean PRs) with expected findings recorded, plus a script that runs the pipeline over the set and reports kept/dropped/false-positive counts
- [ ] 6.8 Verify on the eval set: verifier kills ≥30% of raw findings and spot-checked kills are correct; at least one cross-file break (changed signature, un-updated caller) is caught via agentic search; no eval run exceeds the cost cap

## 7. M5 — Incremental Re-Review

- [x] 7.1 Implement the state store behind an interface: `{pr → last-reviewed SHA, hunk content-hashes}` on Cloudflare KV for the App path and a flat JSON file for the Action path
- [x] 7.2 Implement incremental scoping on `synchronize`: diff only `before..after` from the payload/state so a re-review analyzes just the changes since the last reviewed commit, not the whole PR
- [x] 7.3 Implement still-open carry-forward: previously reported unresolved findings listed as "still open" in the upserted summary (resolved ones removed), with inline comments posted only for findings on newly changed code
- [x] 7.4 Implement custom rules in `.aireview.toml`: user-written rules injected into the prompt, with per-path rule scoping
- [x] 7.5 Implement the run log (PR, model, tokens, cost, findings kept/dropped, drop reasons) written locally per run for self-analytics
- [x] 7.6 Optional RAG experiment: sqlite-vec index over house rules/ADRs/past findings, injected as clearly-labeled supplementary context behind a config flag, defaulting off
- [ ] 7.7 Verify: pushing a 1-line fix to a 50-file dummy PR re-reviews only the new commit range and comments only on new/changed hunks; still-unfixed prior findings appear as "still open" in the summary, not re-posted inline
- [ ] 7.8 Verify: a custom rule ("all API handlers must validate input with zod") fires on a violating dummy PR; write the RAG-on vs RAG-off comparison note in `docs/` from eval-set runs
