# Design: build-pr-review-agent

## Context

Greenfield repo — no code exists yet. A research corpus under `research/` (01–09)
was completed 2026-07-29; `research/08-synthesis-architecture-and-milestones.md`
is the synthesis this design follows. See `proposal.md` for motivation.

Constraints shaping every decision:

- **Solo dev (Ansh), learning-first**: milestones are ordered by concept coverage
  (Actions → diffs/prompting → idempotency → Apps/webhooks → context/verification
  → state/RAG), not just feature value.
- **Shared machine, everything local**: no publishing, no deploys, no pushes until
  Ansh explicitly says otherwise. Development and testing run locally (smee.io
  proxy for webhook dev when that phase starts).
- **Free-tier-first**: $0/mo must be achievable; worst realistic case ~$5/mo
  (research 08 §5). Cost guards are built in from M2, not bolted on.

## Goals / Non-Goals

**Goals**

- A working PR reviewer on Ansh's own repos: inline comments + one upserted
  summary, re-review on push, per-repo config — free-tier-first throughout.
- One trigger-agnostic review engine that survives the Action→App transition
  without a rewrite.
- Low noise as a first-class quality bar (the #1 reason AI reviewers get
  uninstalled).
- Learn the full stack hands-on: Actions, unified diffs, GitHub App auth,
  webhooks, prompt engineering, agentic context, verifier architecture.

**Non-Goals** (research 08 §4, condensed — enforced structurally)

- No autofix / code-writing / pushing commits / merging — comments and
  suggestions only.
- No GitLab/Bitbucket/Azure DevOps; GitHub only (engine platform-agnostic in
  shape, zero adapters built).
- No multi-model debate — one reviewer + one verifier, that's it.
- No dashboard/web UI/analytics product; no multi-tenancy, billing, or SaaS.
- No HITL approval queue — severity threshold in config is the noise valve.
- No embeddings-RAG as core architecture (M5 experiment only); no queue/DB
  before M5.
- No cloning-and-executing untrusted PR code (sidesteps the
  `pull_request_target` pwn-request class entirely).

## Decisions

| # | Decision | Chosen | Rejected alternatives |
|---|---|---|---|
| 1 | Trigger mechanism | GitHub Action (M0–M2), GitHub App webhook (M3+); **engine = trigger-agnostic TS library** | App-first; PAT+webhook |
| 2 | Hosting (App phase) | Cloudflare Workers | Render, Railway, Fly.io, home server+tunnel |
| 3 | Language/framework | TypeScript everywhere; Action = plain script + `@actions/github`; Worker = Hono + Octokit | Probot; Python/FastAPI |
| 4 | LLM routing | Gemini 2.5 Flash free tier (dev) → Claude Haiku 4.5 default w/ prompt caching (M2+) → Sonnet 5 escalation on risky paths; thin provider interface | Single fixed model; OpenRouter `:free`; DeepSeek-as-primary |
| 5 | Context strategy | Diff parse + noise filter + enclosing-function expansion; agentic search (grep/read, capped) from M4 | Embeddings-RAG as foundation |
| 6 | Storage | None M0–M4 (stateless dedupe via existing PR comments); M5: Cloudflare KV (App) or flat file (Action) | Postgres/queue from day one |
| 7 | Prompts | Versioned markdown files in-repo | Inline strings in code |
| 8 | Write path | LLM proposes (structured JSON only), deterministic code disposes (all GitHub mutations) | Model with write access / tool-driven posting |
| 9 | LLM roles | Reviewer + verifier/adversary (M4) | Single pass; multi-model debate |

**1. Trigger — Action first, App later, engine agnostic (THE key structural
decision).** The review engine is a pure TypeScript library that takes
`(PR identity, auth token, config)` and knows nothing about how it was invoked.
The Action wrapper (workflow YAML + `GITHUB_TOKEN`, zero infra, zero webhook
security surface, ships day one) and the App wrapper (HMAC-verified Worker,
installation tokens) are thin adapters around the same core, and both keep
working after M3. The App is the only path to Check Runs, slash commands on
any repo, and multi-repo installs — but it's a milestone, not a prerequisite.
PAT+webhook rejected: long-lived coarse token, per-repo wiring, no Check Runs
(research 05 §1).

**2. Hosting — Cloudflare Workers.** Only host with a durable, no-card,
genuinely-free-forever tier (100K req/day; hobby volume is orders of magnitude
below). The webhook handler is I/O-bound, so the 10ms CPU limit doesn't bite.
Render's 30s+ cold starts are hostile to webhook delivery windows; Railway and
Fly no longer have real free tiers (research 07 §2). KV free tier covers M5
state on the same platform.

**3. TypeScript everywhere.** One language across Action script, Worker, and
engine — no context-switching for a solo dev. Octokit gives typed API access
and webhook signature verification for free; Hono runs natively on Workers.
Probot rejected: batteries-included but wants a long-lived Node process, a poor
fit for the Workers runtime. Python rejected: doesn't run properly on Workers,
would force Render and its cold starts; tree-sitter has good npm bindings
anyway.

**4. LLM provider/model routing.** Dev/default: Gemini 2.5 Flash free tier
(~1,000 req/day) — prompt iteration burns hundreds of test reviews, and free
makes that cost-free. Quality default from M2: Claude Haiku 4.5 (~$0.008/review;
prompt caching on the stable system prompt cuts 50–90% of repeat input cost).
Escalation: Sonnet 5 for diffs touching auth/payments/migrations, detected by
path heuristic. All behind a thin `ReviewModel` interface so provider swaps are
config, not code. Groq Llama is the free secondary fallback; OpenRouter `:free`
rejected as a dependency — the roster is volatile (research 07 §4). Gemini
free-tier ToS caveat handled in Risks.

**5. Context strategy — agentic, not RAG.** Base layer: parse unified diff into
files→hunks with valid right-side line numbers; drop lockfiles/generated/
vendored/binary files; expand each hunk to its enclosing function/class (regex
heuristic first, tree-sitter later). From M4: give the reviewer capped
grep/read tool access for cross-file symbol lookups. No embeddings-RAG until
the M5 experiment — the 2026 consensus (Claude Code, Cursor, Amp all dropped
vector indexes) is that agentic search gets ~90% of RAG quality with zero index
infra, no staleness, and no embedding pipeline; right context beats more
context (research 06 §7, 08 §2).

**6. Storage — none until proven needed.** The core loop is a stateless
transform: event → diff → LLM → comment. Dedupe is done statelessly by reading
existing bot comments via the API. M5 adds `{pr → last-reviewed SHA, hunk
hashes}` in Cloudflare KV (App path) or a flat file (Action path) for
incremental re-review. Reference projects that added a DB early regretted the
ops surface.

**7. Prompts as versioned markdown files.** Diffable, reviewable, A/B-testable
without code changes (ClawSweeper / ai-pr-review-agent pattern). The prompt
carries the severity rubric, do-not-report list, and programmatically computed
valid line ranges injected as a hard constraint.

**8. LLM proposes, code disposes.** The model only ever emits structured JSON
findings; a defensive parser (alternate key names, bare lists, per-finding
failure isolation, line clamping) never crashes on bad output. Deterministic
code does all scoring, dedup, line-mapping, formatting, and every GitHub
mutation. The model never holds write credentials — this structurally caps the
prompt-injection blast radius.

**9. Reviewer + verifier two-role architecture (M4).** A second, tool-equipped
LLM pass re-reads the actual code and must keep/rewrite/drop each finding with
cited `file:line` evidence and a closed drop-reason enum (false-claim /
pre-existing / repo-convention / out-of-scope / theoretically-impossible).
This is the single highest-leverage mechanism against false positives.
Multi-model debate rejected: 10+ calls/PR for marginal gain at this scale.

## Milestone plan

Condensed from research 08 §3 — see that file for full scope, learning goals,
and exit criteria.

| Milestone | Scope (one line) | Exit criterion (one line) |
|---|---|---|
| **M0** | Workflow + ~50-line script posts a static stats comment on PR open | Opening a test PR yields a comment in ~1 min using only `GITHUB_TOKEN` |
| **M1** | Fetch/parse diff, noise filter, one Gemini call → JSON findings → batched review with inline comments | Buggy PR gets ≥1 correct inline comment on the right line; bad LLM output never crashes; run <2 min |
| **M2** | Severity rubric + do-not-report list, line-range constraint, fallback chain, dedupe, summary upsert, `.aireview.toml`, Haiku + caching | Double-push → zero duplicate comments; summary edited in place; house rule suppresses its finding |
| **M3** | GitHub App + Cloudflare Worker: HMAC verify, event routing, installation tokens, `/review`/`/ask` gated to collaborators | App reviews PRs on ≥2 repos with no workflow file; forged webhooks → 401; rando's `/review` ignored |
| **M4** | Enclosing-scope expansion (tree-sitter), capped agentic search, verifier pass, risk-based Sonnet escalation, cost caps | Verifier kills ≥30% of raw findings correctly on a ~20-PR eval set; one cross-file break caught; no run exceeds cost cap |
| **M5** | Incremental re-review via stored SHA/hunk hashes, carry-forward of open findings, custom rules, optional sqlite-vec RAG experiment, run log | 1-line push to a 50-file PR reviews only the new range; custom rule fires; written RAG-on vs RAG-off comparison |

## Risks / Trade-offs

- **Prompt injection via PR content (diff/description/comments)** → model holds
  no write credentials (decision 8), no autofix by design (non-goal), slash
  commands gated to repo collaborators, findings schema-validated before any
  API call.
- **LLM noise / false positives (the uninstall driver)** → do-not-report list +
  hard severity rubric in the prompt (M2), configurable severity threshold in
  `.aireview.toml`, verifier pass with evidence requirement (M4), dedupe +
  summary upsert so re-reviews never spam.
- **Gemini free-tier ToS on data use** → free tier used only on test/public
  repos; anything real/proprietary routes to Haiku (paid API traffic).
- **Webhook forgery (M3+)** → raw-body HMAC-SHA256 verification with
  constant-time compare before any parsing; unsigned/invalid → 401.
- **Cost runaway** → per-run token cap, monthly budget env var that degrades
  the bot to the free-tier model when exceeded, real token counts from provider
  responses (not char estimates), hard loop caps on agentic search.
- **Large PRs blow the context/token budget** → diff size caps with a visible
  truncation marker in the summary (never silent), per-file chunking, noise
  filter runs before anything reaches the model.
- **Line-anchoring failures (comments on invalid diff lines)** → valid line
  ranges computed in code and injected as a prompt constraint; fallback chain
  exact line → nearest diff line (≤50) → file-level → summary.
- **Trigger duality complexity (Action + App coexisting)** → accepted
  trade-off; mitigated by the engine being a pure library with two thin
  adapters — the Action path stays green in CI after M3.

## Open Questions

- Exact `.aireview.toml` schema: key names, per-path rule scoping syntax, how
  `HOUSE_RULES.md` and config interact. Decide at M2 when the first real keys
  are needed.
- Tree-sitter language set for M4: start with TS/JS + Python only, or whatever
  Ansh's repos actually contain at that point?
- Check Runs at M3 or later: the App permissions include `checks: r/w`, but
  whether to surface findings as Check Run annotations (vs review comments
  only) can be deferred until the App exists.
- M5 state backend for the Action path: committed flat JSON file vs SQLite
  artifact — pick when incremental re-review is built.
- Whether `/ask` (Q&A command) ships in M3 alongside `/review` or slips to M4.
