# Cheapest / Free Stack for a Solo-Dev AI PR Review Agent (2026)

Research date: 2026-07-29

---

## 1. Runtime approach: GitHub Action vs hosted webhook server

### GitHub Action (workflow-triggered)
- Trigger: `pull_request` event in a workflow YAML in the target repo (or a reusable/shared workflow called from many repos).
- **Cost:** GitHub-hosted runners are **free and unlimited for public repositories** on every plan. For **private repos** the Free plan gives **2,000 Linux minutes/month** (Windows minutes count 2x, macOS 10x against the quota) plus 500MB artifact storage. [GitHub Actions billing](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions), [CICDCalculator.com](https://cicdcalculator.com/github-actions-free-tier)
- **No server to run, no uptime to manage, no webhook endpoint to secure** — GitHub handles auth (via `GITHUB_TOKEN` or a GitHub App token), delivery, retries, and the runtime environment.
- Downsides: cold-start per run (10-30s to spin up a runner + checkout + install deps), can only react to events in repos where the workflow file is installed (harder to offer as a "install on any repo" SaaS-like product — although you can publish a **reusable workflow** or a GitHub Action others `uses:` in their own workflow, which sidesteps this), execution time capped per job (default 6h, rarely relevant), and you're triggering per-repo rather than centrally — good for "I review my own repos," awkward for "I run a hosted service for other people's repos" (there you actually want a GitHub App + webhook).
- Best fit: **your own repos, or open-source repos where you want zero infra.**

### Hosted webhook server (GitHub App + webhook endpoint)
- A GitHub App receives `pull_request`/`issue_comment` webhooks at a URL you host; you verify the HMAC signature, call the LLM, and post a review via the GitHub REST/GraphQL API.
- Needed when: you want to **install the bot on many repos/orgs you don't own** (a real "product"), want persistent state (across PRs, orgs), want a dashboard, or want sub-second reaction / custom queuing logic.
- Costs real hosting money (or free-tier hosting, see §2) plus the operational burden of an always-on (or on-demand) endpoint, webhook secret rotation, and delivery retries (GitHub retries failed webhook deliveries but you still need to handle idempotency).

**Recommendation for a solo dev / small project:** start with the GitHub Action. It is genuinely free for public repos, requires no server, and the entire PR-review agent can be a single `.github/workflows/review.yml` + a script that calls Claude and posts a comment via `actions/github-script` or the `gh` CLI. Move to a GitHub App + webhook server only when you need to sell/distribute it to third-party repos or need cross-repo memory/state.

---

## 2. Hosting free tiers (only relevant if you go the webhook-server route)

| Platform | Free tier as of mid-2026 | Verdict |
|---|---|---|
| **Cloudflare Workers** | 100,000 requests/day, 10ms CPU time/request (Free plan), up to 50 subrequests/request. No credit card required. [AgentDeals](https://agentdeals.dev/vendor/cloudflare-workers) | **Best free option for a webhook receiver.** A PR-review webhook handler is I/O-bound (call GitHub API, call LLM API) — Workers' CPU-time limit is about *compute*, not wall-clock waiting on network I/O, so it's rarely the constraint. Genuinely durable free tier, not a teaser. |
| **Vercel (Hobby)** | 1M serverless function invocations/month, 100 GB bandwidth, 100 hours function execution, 4 CPU-hrs. **Commercial use is explicitly prohibited on Hobby.** [DeployWise](https://deploywise.dev/blog/vercel-free-tier-limits-2026) | Fine for a personal/non-commercial bot; violates ToS if you monetize or offer it to others as a paid product. |
| **Railway** | **No free tier since 2023**; removed prepaid credits in early 2026, now requires a card and metered post-paid billing (a small "$1/month free credit" is not usable for real hosting). [Render blog / ExpressTech](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026) | Skip for a free stack. |
| **Render** | Still has a real, permanent free tier for web services + static sites + Postgres, **no credit card required**. Free web services spin down after inactivity (cold starts of 30s+ on next request) and rotate periodically. [Render](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026) | Good "just works" fallback if you want a Node/Python server rather than Workers' edge-function model. Cold starts are a real annoyance for webhooks with tight delivery-retry windows. |
| **Fly.io** | **No free tier for new users** since 2024 — new accounts get a time/VM-hour-limited free trial only, then require a card. | Skip for a free stack. |
| **Home server + tunnel (e.g. Cloudflare Tunnel / ngrok / Tailscale Funnel)** | $0 infra cost beyond your own electricity/ISP; Cloudflare Tunnel is free and gives you a stable public HTTPS endpoint without port-forwarding. | Legitimate for a hobby project, but adds "my home internet/PC must be always on" as a reliability dependency — generally worse than Cloudflare Workers for something meant to be reliable. Good for local testing/dev of the webhook handler before deploying to Workers. |

**Recommendation:** if you need a persistent webhook endpoint, use **Cloudflare Workers** — it's the only one of these with a durable, no-card-required, genuinely-free-forever tier suited to a request/response webhook workload.

---

## 3. Language / framework

| Choice | Notes |
|---|---|
| **Node/TypeScript + Hono + Octokit** | Hono is a tiny, fast web framework that runs natively on Cloudflare Workers (also Node, Deno, Bun) — pairs perfectly with the Workers free tier above. Octokit (`@octokit/rest`, `@octokit/webhooks`) is GitHub's official SDK: typed REST/GraphQL client + webhook signature verification + event typing. This is the natural pairing for the "Workers + webhook" path. |
| **Node/TypeScript + Express + octokit** | Same idea but for a traditional Node server (Render, a VPS). Slightly heavier than Hono, more familiar to most devs. |
| **Probot** | A purpose-built framework *specifically* for GitHub Apps, built on top of Octokit. Handles webhook routing (`app.on('pull_request.opened', ...)`), auth (app + installation tokens), and has first-class local dev tooling (`smee.io` proxy for webhook forwarding to localhost). Actively maintained (commits as recent as July 2026). **This is the standard, most batteries-included choice if you're building a real GitHub App** rather than a from-scratch Hono/Express handler — it removes almost all the GitHub-specific plumbing (signature verification, event dispatch, token exchange) that you'd otherwise hand-roll with raw Octokit. Downside: Probot is designed to run as a long-lived Node process (or on their serverless adapters for Vercel/AWS Lambda/GCF) — it's not built for the Workers edge runtime, so if Workers is your hosting target, plain Hono + Octokit is a better fit than Probot. |
| **Python + FastAPI + PyGithub** | Good if your LLM tooling / prompt-building / diff-parsing logic is Python-heavy (e.g. you want tree-sitter, ast, or data-science-flavored diff analysis). FastAPI has built-in request validation and is fast to write. PyGithub is a mature, if slightly less ergonomic than Octokit, GitHub API client. Deploys fine to Render's free tier (Python + Gunicorn/Uvicorn) but does **not** run on Cloudflare Workers (Workers only really support JS/TS/Rust/Python-via-Pyodide-with-real-limitations) — so Python pushes you toward Render (with its cold-start downside) rather than the more durable Workers free tier. |
| **The GitHub Action approach (§1) sidesteps all of this** | You don't need a web framework at all — just a script (Node, Python, or even bash + `curl` + `jq`) invoked directly by the Action, reading the PR diff from the GitHub Actions context and calling the LLM API. |

**Recommendation:**
- If going the **GitHub Action** route (recommended for solo/free): plain Node or Python script, no framework needed. TypeScript + `@actions/github` + `@actions/core` (official GitHub Action toolkit) + Anthropic/OpenAI SDK is the cleanest.
- If going the **webhook server** route and targeting Cloudflare Workers: **Hono + Octokit**.
- If going the webhook server route and want the most batteries-included GitHub App experience (and are fine hosting on Render/a VPS/Lambda rather than Workers): **Probot**.

---

## 4. LLM API costs (current pricing, per 1M tokens, USD) and free tiers

| Provider / model | Input | Output | Notes |
|---|---|---|---|
| **Anthropic Claude Haiku 4.5** | $1.00 | $5.00 | Fastest/cheapest current Claude model; good enough for most single-file diff review comments. |
| **Anthropic Claude Sonnet 5** | $3.00 ($2.00 intro thru 2026-08-31) | $15.00 ($10.00 intro) | Strong reasoning for deeper review (architecture, security-sensitive diffs). No free tier — Anthropic has no perpetual free API tier, only free credits at signup for some accounts. |
| **Anthropic prompt caching** | ~0.1x input cost on cache read, ~1.25x on cache write | — | Very relevant for PR review: cache your system prompt + repo-context/style-guide once, pay full price only on the diff itself. Can cut effective cost 50-90% for repeated review runs against the same repo conventions. |
| **OpenAI GPT-4.1-mini** | $0.40 | $1.60 | [pricepertoken.com](https://pricepertoken.com/pricing-page/model/openai-gpt-4.1-mini) |
| **OpenAI GPT-4o-mini** | $0.15 | $0.60 | Cheapest widely-used OpenAI model; [pecollective.com](https://pecollective.com/tools/gpt-4o-pricing/) |
| **OpenAI o4-mini** (reasoning) | Priced separately from 4.1-mini, roughly mid-tier reasoning-model pricing (search didn't return an exact current number — check `platform.openai.com/pricing` directly before committing budget) | — | Reasoning models spend extra hidden "thinking" tokens billed as output — can blow past a naive per-PR budget estimate. |
| **Google Gemini 2.5 Flash** | $0.30 | $2.50 | 1M context, no long-context surcharge. Being deprecated Oct 16, 2026 — check for Gemini 3 Flash at time of building. [tldl.io](https://www.tldl.io/resources/google-gemini-api-pricing) |
| **Gemini free tier (AI Studio)** | Free, Flash/Flash-Lite only (Pro is paid-only since April 2026) | 5-15 RPM, up to ~1,000 requests/day | **This is a genuinely usable free tier for a low-volume PR bot** — if your repo does <30 PRs/day, Gemini Flash's free AI Studio quota alone could run the whole bot at $0 forever, with the caveat that Google can and does use/review Studio-tier traffic differently than paid API traffic (check current ToS on data usage before using for private/proprietary code). |
| **DeepSeek V4-Flash** | $0.14 (cache miss), $0.0028 (cache hit) | $0.28 | Extremely cheap; 50x cache-hit discount rewards a stable system prompt (same caching logic as Claude). [morphllm.com](https://www.morphllm.com/deepseek-api) |
| **DeepSeek V4-Pro** | $0.435 (promo, standard $1.74) | $0.87 (promo, standard $3.48) | Stronger reasoning tier, still far cheaper than Western frontier models. |
| **Groq (Llama models, hosted inference)** | Free tier: 30 RPM, ~6-30K TPM, 1,000-14,400 requests/day depending on model (org-level, not per-key) | Paid tier ~10x the free quota | Free tier is usable for a low-traffic personal bot; Groq's edge is **speed** (very fast tokens/sec via custom silicon), not necessarily review quality — Llama 3.x models are weaker at code review than Claude/GPT/Gemini, but free is free. [tokenmix.ai](https://tokenmix.ai/blog/groq-free-tier-limits-2026) |
| **OpenRouter free (`:free`) models** | $0/token, no card needed | 50 requests/day (no paid credits ever added) or 1,000/day (if you've bought ≥$10 in credits once) | Roster is volatile — free models get delisted/relisted constantly (7 free endpoints including Llama-3.3-70b and Qwen3-Coder were pulled in a single 9-day window in July 2026). **Do not build a product that depends on a specific free OpenRouter model staying available** — treat it as a bonus/dev-only tier, with a paid fallback model configured. [buldrr.com](https://buldrr.com/openrouter-free-models-list-2026-all-27-models-ranked-tested/) |

### Rough cost-per-PR-review estimate

Assume a typical PR diff + a system prompt with review guidelines ≈ 3,000-8,000 input tokens, and a review comment output of 300-1,000 tokens (larger for multi-file/architectural review).

| Model | Cost per review (5K in / 600 out, no caching) | Cost per review (with caching on a stable system prompt) |
|---|---|---|
| Claude Haiku 4.5 | ~$0.008 | ~$0.004-0.006 |
| Claude Sonnet 5 (intro pricing) | ~$0.016 | ~$0.008-0.012 |
| GPT-4o-mini | ~$0.001 | n/a (no native prompt caching pricing tier like Anthropic/DeepSeek) |
| GPT-4.1-mini | ~$0.003 | — |
| Gemini 2.5 Flash | ~$0.003 | — |
| DeepSeek V4-Flash | ~$0.0007 (cache miss) / ~$0.0004 (cache hit) | Cheapest paid option by a wide margin |
| Gemini Flash (free tier) | $0 | $0 (subject to ~1,000 req/day cap) |
| Groq Llama (free tier) | $0 | $0 (subject to RPM/RPD caps, weaker review quality) |

**At solo-dev PR volumes (a handful to a few dozen PRs/day across your own repos), every option above — including the paid ones — costs pennies to a few dollars a month.** The free tiers (Gemini AI Studio, Groq) can plausibly cover $0/month forever at that volume; DeepSeek is the cheapest meaningfully-capable paid fallback if you outgrow free tiers or want a stronger model as backup.

---

## 5. Do you need a queue/state layer for v1?

**No — not for v1.** A PR-review bot is fundamentally a stateless request/response transform: GitHub sends a `pull_request` event → you fetch the diff → you call the LLM → you post a comment. There is no cross-request state required for the core loop.

Where state *would* matter, and why you can defer it:
- **Deduplicating repeated reviews on the same commit SHA** (avoid re-reviewing unchanged pushes) — can be done statelessly by checking existing PR comments/reviews via the GitHub API before posting, no DB needed.
- **Rate-limiting your own LLM spend per repo/user** — for a solo dev's own repos this isn't a real risk; add a simple in-memory or KV counter only once you open the bot to others.
- **Long review "conversations" that need to remember prior turns/feedback across pushes** — genuinely needs state, but is a v2 feature (most PR bots re-review each push fresh and that's fine).
- **A queue** (e.g. to smooth bursts of many PRs, retry failed LLM calls, or avoid webhook-delivery timeouts) matters only once you have real traffic volume or need retries beyond what GitHub's built-in webhook retry gives you. GitHub Actions naturally serializes/queues per-workflow already; a webhook handler on Cloudflare Workers can call the LLM synchronously within the request unless you're hitting Workers' CPU-time limits (rare for I/O-bound calls) — no queue needed at solo scale.

**Recommendation:** ship v1 with **zero database, zero queue** — pure function from webhook/Action event → LLM call → GitHub API comment. Add a lightweight KV store (Cloudflare KV, or a flat file/SQLite in a GitHub Action's workspace) only when you actually hit a concrete need (e.g., dedup, per-repo config, or basic usage counters).

---

## 6. Vector DB free tiers (only relevant if you add RAG — e.g. retrieving past review comments, style guides, or codebase context)

For v1 of a PR reviewer, RAG is usually unnecessary — the PR diff plus a system-prompt style guide is enough context. If you later want retrieval (e.g., "find similar past bugs," "pull relevant architecture docs"), here are the free options:

| Option | Free tier | Fit |
|---|---|---|
| **sqlite-vec** (SQLite extension) | $0 — runs embedded, no hosted service at all | Best zero-infra option: ship a `.sqlite` file with vector embeddings alongside your bot's code/Action. No network hop, no account, no quota. Ideal if your corpus (style guide chunks, past review notes) is small (thousands to low tens-of-thousands of vectors) and doesn't need to be shared across processes. Works great inside a GitHub Action (checkout the DB file as a repo artifact) or a Cloudflare Worker with a Durable Object/D1-backed approach (D1 doesn't yet have native vector ops as of this writing — check current Cloudflare Vectorize instead for the Workers-native option). |
| **pgvector on Neon (free tier)** | 100 CU-hours/month compute, 0.5GB storage/project, up to 100 projects, scale-to-zero. Ships pgvector + HNSW indexing out of the box. | Good if you're already running Postgres for other state, or want a hosted DB you can query from a webhook server. Scale-to-zero means cold-start latency on the first query after idle — fine for a low-traffic bot. |
| **pgvector on Supabase (free tier)** | 2 free projects, 500MB DB, 1GB file storage, 5GB bandwidth. pgvector + HNSW included. | Similar to Neon; pick whichever you're more comfortable with generally (Supabase bundles auth/storage/realtime if you want a dashboard later; Neon is more "just Postgres"). |
| **Qdrant Cloud (free tier)** | 1GB RAM / 4GB disk / 0.5 vCPU, 1 node, no credit card. Handles roughly ~1M vectors at 768 dimensions. Free clusters auto-suspend after 1 week idle, deleted after 4 weeks idle. | Purpose-built vector DB with the richest filtering/hybrid-search feature set of the free options here. The idle-suspend behavior is a real gotcha for a bot that only runs occasionally — factor in a "wake up the cluster" step or accept the reactivation delay. Best if you specifically want production-grade vector search semantics (payload filtering, hybrid search) rather than "good enough" via pgvector or sqlite-vec. |

**Recommendation for RAG, if/when you need it:** start with **sqlite-vec** (zero infra, ships with your code) for anything under ~50K vectors. Move to **pgvector on Neon** if you're already using Postgres for other bot state. Reach for **Qdrant Cloud** only if you need its filtering/hybrid-search features specifically — its idle-suspend policy is a poor fit for a bot that's dormant most of the time.

---

## 7. Recommended stacks

### "Totally free" — for your own repos, indefinitely, $0/month
- **Runtime:** GitHub Action (`.github/workflows/review.yml` on `pull_request`), public repos only (or private repos within the 2,000 free min/month budget — a review job typically takes well under a minute, so this covers thousands of PRs/month even on private repos).
- **Language:** Node + TypeScript, using `@actions/github` + `@actions/core` (no web framework needed — it's a script, not a server).
- **LLM:** Google Gemini 2.5 Flash via the free AI Studio tier (up to ~1,000 requests/day) as primary, with a hard-coded fallback to a cheap paid model (DeepSeek V4-Flash) if you exceed quota or want higher quality — but if you truly want $0, just accept occasional rate-limit skips on the free tier, or add Groq's free Llama tier as a second fallback.
- **State/queue:** none.
- **RAG:** none; if needed later, sqlite-vec committed alongside the workflow.
- **Why this works:** zero infrastructure to run or pay for, ever. The only "cost" is engineering time and accepting Gemini/Groq's free-tier rate limits and (for Gemini) the ToS caveat around free-tier data usage — don't run this on proprietary/sensitive code without checking Google's current AI Studio data policy.

### "Cheap and solid" — a few dollars a month, better reliability and quality
- **Runtime:** GitHub Action for your own repos **and** a Cloudflare Workers-hosted GitHub App if you want to offer the bot to other repos/orgs too.
- **Language:** TypeScript + Hono + Octokit on Workers (free tier: 100K req/day is far more than enough); or just the Action script if you don't need the App.
- **LLM:** **Claude Haiku 4.5** as the default reviewer (cheap, fast, good code-review quality) with **Claude Sonnet 5** used selectively for large/high-risk diffs (e.g., diffs touching auth, payments, migrations — detect via changed file paths and escalate model choice). Use Anthropic prompt caching on your system prompt/style guide to cut repeated-review cost further. Expected spend: a few dollars/month even at tens of PRs/day.
- **State/queue:** none required; add Cloudflare KV (also free-tier) only for simple dedup/rate-limit counters if opening the bot to others.
- **RAG:** sqlite-vec or Cloudflare Vectorize if you want it to reference a style guide/past-decisions corpus.
- **Why this works:** still essentially free-tier infrastructure (Workers), but you're paying a small, controlled LLM bill in exchange for materially better review quality and reliability than the free-tier-LLM-only stack, plus you get a real GitHub App you can install anywhere, not just repos where you've committed a workflow file.

### "Production-grade" — for a bot you'd actually run as a small product/service
- **Runtime:** GitHub App + Cloudflare Workers (or Render if you need a long-lived Node process/Probot) as the webhook receiver; GitHub Action remains available as an alternative install path for repos that prefer it.
- **Language:** TypeScript + Probot (if hosting on Render/Vercel/Lambda) *or* Hono + Octokit (if staying on Workers, hand-rolling the GitHub-App-specific bits Probot would otherwise give you) + a proper job queue (Cloudflare Queues, or a simple Postgres-backed job table) so webhook delivery is decoupled from LLM latency and you can retry failures without blocking GitHub's delivery window.
- **LLM:** Claude Sonnet 5 as default for real review depth, Claude Haiku 4.5 for quick/low-risk diffs, with model selection driven by diff size/risk heuristics; prompt caching enabled; consider a paid OpenRouter or direct multi-provider setup so you can fail over between providers on outage/rate-limit.
- **State/queue:** Postgres (Neon or Supabase paid tier once you outgrow free) for: installation/repo config, per-repo style-guide overrides, dedup of reviewed commit SHAs, usage/cost tracking per customer if monetized. A lightweight queue (Cloudflare Queues, or Postgres-as-queue via `SELECT ... FOR UPDATE SKIP LOCKED`) to smooth bursts and support retries.
- **RAG:** pgvector in the same Postgres instance (simplest — one fewer service to run) storing embeddings of style guides, past review comments, and architecture docs per installation; move to Qdrant Cloud only if you need advanced filtering/hybrid search at meaningful scale.
- **Why this works:** this is the shape you'd want once the bot has real multi-tenant usage, needs to be reliable under bursty traffic, needs per-customer configuration/billing, and where "free tier ran out" is an acceptable, even expected, trigger to start paying for Postgres/Workers-beyond-free/LLM at scale — but note every piece here still *starts* on a free tier (Neon/Supabase free, Cloudflare free, Workers free) and only converts to paid as you cross real usage thresholds, so the migration path from "cheap and solid" to "production-grade" is incremental, not a rewrite.

---

## Sources

- [GitHub Actions billing docs](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions)
- [GitHub Actions free tier explainer — CICDCalculator.com](https://cicdcalculator.com/github-actions-free-tier)
- [Cloudflare Workers free tier — AgentDeals](https://agentdeals.dev/vendor/cloudflare-workers)
- [Vercel free tier limits 2026 — DeployWise](https://deploywise.dev/blog/vercel-free-tier-limits-2026)
- [Real free tiers in 2026 — Render blog](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026)
- [Probot GitHub org](https://github.com/probot), [Probot framework repo](https://github.com/probot/probot)
- [GPT-4.1-mini pricing — pricepertoken.com](https://pricepertoken.com/pricing-page/model/openai-gpt-4.1-mini)
- [GPT-4o-mini/GPT-4o pricing — pecollective.com](https://pecollective.com/tools/gpt-4o-pricing/)
- [Gemini API pricing 2026 — TLDL](https://www.tldl.io/resources/google-gemini-api-pricing)
- [Gemini free tier note — nocode.mba](https://www.nocode.mba/articles/google-ai-studio-pricing)
- [DeepSeek API pricing — Morph](https://www.morphllm.com/deepseek-api)
- [Groq free tier limits 2026 — TokenMix](https://tokenmix.ai/blog/groq-free-tier-limits-2026)
- [OpenRouter free models list — buldrr.com](https://buldrr.com/openrouter-free-models-list-2026-all-27-models-ranked-tested/)
- [Neon vs Supabase free tier — AgentDeals](https://agentdeals.dev/neon-vs-supabase)
- [Qdrant Cloud free plan — costbench.com](https://costbench.com/software/vector-databases/qdrant/free-plan/)
- Anthropic model pricing: from the bundled `claude-api` skill reference (Anthropic first-party API rates, cached 2026-06-24; Sonnet 5 intro pricing valid through 2026-08-31)
