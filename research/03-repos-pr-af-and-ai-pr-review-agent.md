# Repo Analysis: PR-AF vs ai-pr-review-agent

Both repos exist and are real, working open-source AI PR review agents. Analysis below is based on cloning both repos (shallow) and reading README, architecture docs, and key source files directly, plus GitHub API metadata.

---

## Repo maturity snapshot (as of 2026-07-29)

| | [Agent-Field/pr-af](https://github.com/Agent-Field/pr-af) | [ayush488-glitch/ai-pr-review-agent](https://github.com/ayush488-glitch/ai-pr-review-agent) |
|---|---|---|
| Stars | 350 | 5 |
| Forks | 33 | 2 |
| Contributors | 4 | 1 |
| Commits (visible) | 30 | 30 |
| Created | 2026-03-11 | 2026-05-12 |
| Last push | 2026-07-24 | 2026-06-04 (stale ~2 months) |
| Language | Go (+ Python) | Python |
| License | none detected via API (repo shows Apache 2.0 badge in README) | none detected |
| Open issues | 7 | 1 |

PR-AF is an actively maintained, community-adopted project with real traction (350 stars, 33 forks, multiple contributors, weekly pushes). ai-pr-review-agent is a solo side project / learning build — no pushes in ~2 months, single contributor, near-zero external adoption. This gap should be read into every comparison below: PR-AF's patterns are validated by production use on a public benchmark; ai-pr-review-agent's patterns are validated only by its own test suite and internal "phase gates."

---

## 1. PR-AF (Agent-Field/pr-af)

### What it is
"#1 open-source code reviewer on Martian Code-Review-Bench" — an agentic, multi-phase PR reviewer built on the authors' own agent framework, **AgentField** (https://github.com/Agent-Field/agentfield). Positions itself explicitly as a deep, thorough CI/CD gatekeeper (35-50 min reviews) rather than a fast interactive tool, with Claude Code recommended for the fast inner loop and PR-AF as the slow, rigorous outer gate.

### Architecture — 7-phase adaptive pipeline
Documented in exhaustive detail in `docs/ARCHITECTURE.md` (685 lines). Key idea: the review strategy is **generated at runtime from the PR's content**, not selected from a fixed checklist.

1. **Intake** (`.ai()` fast path + `.harness()` fallback) — classifies PR type, complexity, languages, areas touched, risk signals, and an `ai_generated` confidence score (heuristic detection of AI-authored code — over-descriptive names, comment density, structural uniformity, unusual imports, tests that mirror implementation).
2. **Anatomy** — two sub-steps in parallel:
   - 2a *Structural* (pure code, no LLM): diff parsing, change clustering, **blast-radius computation** via an import/dependency graph, stats.
   - 2b *Semantic* (`.harness()`): PR narrative, risk-surface identification, unrelated-change detection, intent-vs-diff gap checks.
3. **Planning** (`.harness()`, "the key innovation") — a planner LLM **meta-prompts**: it reasons per change-cluster about what could go wrong and generates N `ReviewDimension` objects, each containing a *dynamically authored* review prompt, target files, context files, priority, and budget. No hardcoded reviewer types (no `security_reviewer.py` etc.) — there is exactly one generic `reviewer.py` agent that gets instantiated N times with different runtime prompts.
4. **Parallel Review** — N reviewer instances run under an `asyncio.Semaphore` (default max 8 concurrent), each can follow references up to 3 hops, self-escalate by spawning up to 2 child harnesses for deep investigation, and streams `ReviewFinding` objects onto a shared `asyncio.Queue` as they're produced (not batched at the end).
5. **Review Layer (streaming, 3 parallel agents)**:
   - *Cross-Reference Resolver* — watches the finding stream for compound risks/assumption violations/consistency gaps across different reviewers' findings; can spawn up to 5 deep-dive investigations.
   - *Adversary Reviewer* — actively challenges findings (false positive? pre-existing issue? established convention? overstated severity?), hunts for what all reviewers missed, and applies extra AI-code skepticism when `ai_generated > 0.5` (checking hallucinated imports/APIs, over-abstraction, shallow tests).
   - *Coverage Gate* (`.ai()`) — checks if all change clusters / high-blast-radius files got reviewed; spawns "gap reviewers" if not, up to 2 iterations.
6. **Synthesis** (pure code, no LLM) — deterministic scoring (`base_weight[severity] * confidence * multipliers` for cross-ref compounds, adversary confirmation/challenge, AI-generated-PR bump, high blast radius), dedup (exact by code, near-dup by `.ai()` gate), diff-coordinate line mapping, confidence-threshold filtering, and REQUEST_CHANGES/COMMENT/APPROVE event derivation.
7. **Output** (pure code) — posts a single GitHub PR Review API call (`POST .../pulls/{n}/reviews`) with a body summary, an `event`, and an array of inline `comments` (path/line/side/body). Also supports structured JSON, SARIF, and standalone Markdown output modes. Comment format is templated: `### {emoji} {title}\n\n{body}\n\n{suggestion}\n\n---\nFound by: {dimension} · Confidence: {x} · {category}`.

Three nested, hard-capped control loops keep cost bounded: inner (per-reviewer: 3 reference hops, 2 child spawns), middle (cross-ref: 5 deep-dives), outer (coverage: 2 iterations) — explicitly to prevent "adaptive systems become unbounded cost sinks."

### Trigger mechanisms
Two independent trigger paths, both found in source:
1. **GitHub Actions label trigger** — add the `pr-af` label to a PR; a workflow (`.github/workflows/pr-af-review.yml` template in README) spins up the control plane + PR-AF via Docker Compose in-runner and calls `python3 scripts/ci_runner.py`. Zero required config, uses `GITHUB_TOKEN`.
2. **`@pr-af` mention webhook** (Go port, `go/internal/node/webhook.go`, ported line-for-line from a Python `app.py`) — listens for GitHub `issue_comment` events, verifies the HMAC-SHA256 signature (`X-Hub-Signature-256`), ignores non-PR comments and non-`created` actions, extracts any free-text "hints" typed after the mention, and fire-and-forgets an async call to the control plane (`POST /api/v1/execute/async/{node}.review`) with `{pr_url, depth: "standard", dry_run: false, hints?}`. Failures never block the webhook response (returns `execution_id: null`).
3. Also directly callable via `af call pr-af.review` CLI or raw `curl` to the AgentField control-plane REST API — this is the primary programmatic entry point, everything else wraps it.

### Context gathering
- Diff obtained via the control-plane's repo checkout (`PR_AF_WORKDIR`, one workspace per `<repo>-pr<N>`), not just the GitHub diff blob — reviewers get actual file-system/tool access (read files, follow imports) inside a harness, not just a diff string.
- Programmatic blast-radius / dependency graph (`blastradius.go`, `diffengine`) built from import/require statements — used to decide which *unmodified* files matter for review.
- Planner explicitly assigns `target_files` and `context_files` per dimension, giving each reviewer a curated, purpose-built context rather than the whole repo or whole diff.

### LLM usage / prompting
- Runs on OpenRouter by default (`PR_AF_MODEL=openrouter/moonshotai/kimi-k2.5`), model-agnostic: benchmarked with DeepSeek-class, GLM-5.2, and Opus-class models; explicit model-routing table assigns tiers (`budget`/`mid`/`premium`) per agent role — budget models for intake/coverage/dedup gates, premium for planner/reviewer/cross-ref/adversary (because "plan quality determines review quality").
- Meta-prompting is the core mechanism: an LLM (planner) writes the prompts that other LLM instances (reviewers) will run under, generated fresh per PR.
- Findings must carry `evidence` (concrete code references) and go through a "Falsifiability Gate" — before a finding becomes a comment, the system actively tries to invalidate it.
- Cost/time governed by explicit budgets: `PR_AF_MAX_COST_USD` (default $2.00/run), `PR_AF_MAX_DURATION_SECONDS` (default 3600s), per-phase budget fractions (review phase gets 90% of allocation).

### Comment posting
Single `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` call bundling the executive summary and all inline comments (path/line/side/body) — one atomic GitHub review, not N separate comment calls. Supports SARIF output for GitHub's Security tab as an alternate sink.

### Tech stack
Go (primary implementation as of this snapshot — a full parity port of an original Python implementation, both shipped side-by-side and independently runnable: Python as `pr-af:8004`, Go as `pr-af-go:8007`), built on the authors' **AgentField** control-plane/agent framework, Docker Compose deployment, Railway one-click deploy, OpenRouter for LLM access, GitHub REST API via `GH_TOKEN`. Extensive Go test suite (`*_test.go` next to nearly every internal package) plus JSON schema golden files for harness output parity testing between the Go and Python implementations.

### Strengths
- **Rigorous, novel architecture**: dynamic per-PR review-dimension generation (no fixed reviewer taxonomy) is a genuinely distinctive design versus "run a checklist prompt over the diff."
- **Adversarial self-challenge** as a first-class phase — directly targets the AI-code-reviewer false-positive problem that plagues the category.
- **Evidence-grounding + falsifiability gate** before posting — a concrete mechanism for reducing noise, not just a stated goal.
- **Deterministic, auditable scoring** kept out of the LLM entirely (Phase 6) — reproducible, testable, tunable independent of prompt changes.
- **Public, reproducible benchmark** (Martian Code-Review-Bench) with per-PR judge verdicts and scoreboard data shipped in-repo (`benchmark/`) — an unusual level of accountability for an OSS AI tool's claims.
- **Real adoption signal**: 350 stars, 33 forks, active weekly commits, 4 contributors, dual-language (Go+Python) parity implementation — evidence this is used, not just published.
- Hard budget/time/loop caps baked into the design from the start, preventing the classic "agentic pipeline that silently costs $40 on one PR" failure mode.

### Weaknesses
- **Very slow**: 35-50 minutes per review by the authors' own admission — explicitly positioned as a CI gate, not an inner-loop tool, which limits applicability for teams wanting fast PR feedback.
- **Cost**: still real LLM spend even if "10x cheaper than closed-source" — a $2 cap per run across potentially dozens of parallel harness calls is not free at scale.
- **Complexity**: 7 phases, 3 nested loops, meta-prompting, dual Go/Python implementations — a large surface area to operate, debug, and extend; onboarding cost for contributors is nontrivial.
- Depends on the authors' own AgentField control-plane framework as a hard runtime dependency — not a standalone script; adopting PR-AF means adopting (or standing up) AgentField too.
- Benchmark is self-reported by the project (with reproduction scripts, which mitigates but doesn't eliminate the conflict-of-interest concern).

### Lessons for building a PR review agent
1. **Don't fix the reviewer taxonomy** — let a planning LLM read the diff/anatomy and generate bespoke review dimensions (and their prompts) per PR. This scales review depth to actual PR risk rather than running the same 5 checks on every PR.
2. **Separate "find issues" from "challenge issues"** into distinct agent roles; the adversary role is explicitly credited as the single highest-value mechanism for cutting false positives.
3. **Keep scoring/dedup/line-mapping/comment-formatting/GitHub-posting entirely in deterministic code**, never LLM — this is repeated as an explicit design rule (`.ai()` vs `.harness()` vs Code decision table) and is worth adopting directly.
4. **Every LLM gate needs a fallback path** (e.g. intake `.ai()` → `.harness()` on low confidence) so speed optimizations never become correctness risks.
5. **Hard-cap every loop** (reference-follow hops, child-agent spawns, cross-ref deep-dives, coverage iterations) — "without caps, adaptive systems become unbounded cost sinks" is a directly quotable design principle.
6. Ship a **public, reproducible benchmark** alongside the tool if credibility/traction matters — this seems to correlate with PR-AF's much larger adoption versus the second repo.

Sources read directly: `README.md`, `docs/ARCHITECTURE.md`, `go/internal/node/webhook.go`, repo file tree, GitHub API metadata (Agent-Field/pr-af).

---

## 2. ai-pr-review-agent (ayush488-glitch/ai-pr-review-agent)

### What it is
"A production-grade, open source AI Pull Request Review Agent," structured explicitly as a **20-phase learning/course build** ("Each phase is one chapter in the course. Ends green. Has a written gate before the next phase starts.") — built by a single author (Ayush Singh) as a demonstration/practice project, heavily sponsored/oriented around Tiger Cloud (TimescaleDB) as a unifying data layer, apparently for a Tiger Data developer-relations content piece ("for on-camera demo," "Built by Ayush Singh").

### Architecture
Classic modular-monolith fan-out/aggregate pipeline, orchestrated with **LangGraph** as an explicit `StateGraph`:

```
START → build_context → fan_out_agents → aggregate_results → post_review → END
```

- `build_context`: fetches PR metadata + diff from GitHub.
- `fan_out_agents`: runs 4 fixed specialist agents in parallel — **security, quality, test-coverage, docs** — each a subclass of a shared `BaseAgent`.
- `aggregate_results`: merges the 4 agents' findings, derives an overall verdict, decides HITL routing.
- `post_review`: posts to GitHub or routes to a human approval queue.

Unlike PR-AF, the reviewer roles are **fixed and hardcoded** (no dynamic dimension generation) — the differentiation between agents is entirely in each agent's system prompt (loaded from a versioned prompt registry `backend/prompts/templates/{agent}/v1.txt`, with an inline fallback prompt in code if the registry file is missing).

LangGraph is chosen specifically for: (1) automatic Redis-backed checkpointing so a crashed review can resume mid-pipeline, (2) automatic partial-state merging, (3) built-in event hooks for OpenTelemetry tracing, (4) room for future conditional-edge branching (e.g., routing straight to HITL) — though at the time of the snapshot read, checkpointing uses an in-memory placeholder (`MemorySaver`), not yet wired to Redis in this graph module.

### Trigger mechanism
Standard GitHub `pull_request` webhook, POST `/webhook/github`, in FastAPI:
1. Read raw body (bytes, before JSON parsing — required so the HMAC hash matches exactly what GitHub signed).
2. Validate `X-Hub-Signature-256` HMAC-SHA256 → 401 if invalid.
3. Parse payload into a typed `WebhookEvent` → 400 if malformed; returns 200 "ignored" for event types it doesn't handle (push, star, fork, etc. — anything that isn't `pull_request`).
4. Idempotency check + enqueue combined in one call to Redis/ARQ (`enqueue_review_job`) — duplicate deliveries return 200 "already_queued" rather than erroring; Redis outage returns 503 so GitHub retries.
5. Returns 200 immediately (must respond within GitHub's 10s window) — actual review work happens asynchronously in an ARQ worker.

Notably clean separation: settings are injected via FastAPI `Depends(get_settings)` rather than imported as a global singleton specifically so the webhook route is unit-testable without a `.env` file (explicitly called out as an "Orthogonality / GlobalDataCoupling" fix in the code comments).

### Context gathering
- `GitHubClient` (async, httpx-based) fetches PR metadata, the raw unified diff (via `Accept: application/vnd.github.diff`, a single request rather than stitching paginated file patches), and paginated file lists (up to 100/page, loops until exhausted — explicitly guards against silently missing files on >100-file PRs).
- Diff is size-capped at 500KB with a visible truncation marker appended so agents "know" the diff is incomplete rather than silently reviewing a partial diff.
- **RAG layer**: PR diff + codebase context retrieved via semantic search — chunked code, ADRs, and prior reviews embedded and stored in Tiger Cloud / pgvectorscale (DiskANN index), explicitly replacing what would otherwise be a separate Qdrant vector store. Retrieved context is injected into each agent's user-message as a labeled "PRIOR CODEBASE CONTEXT" block, explicitly framed as supplementary, not authoritative ("RAG is enhancement not foundation").
- **Peer context** (Phase 8 addition): a compact summary of what other agents already found (agent name, finding count, highest severity, up to 5 flagged files — not full finding text) can optionally be injected into each agent's prompt to reduce duplicate flagging across specialists.
- Per-agent context token budget with bottom-truncation (rough 1-token≈4-chars heuristic) and a truncation notice appended so the LLM can caveat incomplete-context findings.

### LLM usage / prompting
- OpenAI GPT-4o by default, with an explicit provider-routing branch also supporting Anthropic — `BaseAgent._dispatch_llm_call` switches on `ModelConfig.provider`.
- Prompt structure follows an explicit primacy/recency design: **system prompt** = JSON-format instruction FIRST (so the model "remembers" the output contract across long generation) + agent-specific domain instructions; **user message** = PR metadata → truncation warning → RAG context → peer context → the diff itself LAST (recency effect, diff freshest in context when generation starts).
- Two-level prompt strategy: primary source is a versioned prompt-registry file on disk (`templates/{agent}/v1.txt`, enabling prompt versioning/A-B testing without code changes); fallback is an inline `_system_prompt()` string per agent class, used only if the registry file is missing from a bad deploy (logged as a WARNING, not silently swallowed).
- **Output guardrail** is the most defensive/careful piece of code in the repo: handles non-JSON output, wrong-key JSON (`issues`/`results`/`problems`/`violations` as alternates to `findings`), a bare list instead of an object, and malformed individual finding objects — never raises, always returns a safe `(findings, confidence)` tuple; low/failed confidence (0.3) explicitly routes to human review (HITL) rather than either blocking or silently passing.
- Per-agent verdict derivation (`APPROVE` / `REQUEST_CHANGES` / `CRITICAL_BLOCK`) is separate from the system-wide review verdict — a documented "Safety-Threshold Rule" requires 2+ agents to independently agree on `CRITICAL_BLOCK` before the whole pipeline escalates to human review, specifically to prevent one miscalibrated agent from triggering HITL on every PR.
- Daily budget cap (`BudgetGuard`) checked before every LLM call; exceeding it produces a safe degraded result (routes to HITL) instead of failing the pipeline.

### Comment posting
`GitHubClient.post_pr_review()` → `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`, using a typed `PostReviewPayload`/`PostReviewResponse` pair (Pydantic). The client itself is written with unusually strong production hygiene: four independent httpx timeouts (connect/read/write/pool), exponential-backoff retry (1s/2s/4s) limited to 5xx/network errors only, explicit 3-tier exception hierarchy (`GitHubAPIError` → `GitHubNotFoundError`/`GitHubRateLimitError`), and proactive rate-limit-header monitoring (warns when `X-RateLimit-Remaining` drops below 100, well before hard failure).

### Tech stack
FastAPI (Python 3.10) · LangGraph (orchestration/checkpointing) · Redis + ARQ (job queue) · **Tiger Cloud / TimescaleDB with pgvectorscale** (unifies vector search, event/trace hypertables, and structured Postgres data into one database — explicitly replaces a would-be 3-store setup of Qdrant + a time-series store + Postgres) · OpenAI GPT-4o (+ Anthropic option) · Next.js frontend (review dashboard, HITL queue, trace viewer, economics/cost dashboard) · OpenTelemetry · Railway deploy.

### Strengths
- **Exceptionally well-commented, pedagogically structured codebase** — nearly every file opens with a rationale block citing specific "wiki" design-pattern references (Stability-Patterns.md, Timeouts.md, RAG-Architecture.md, LLMOps-Essentials.md, WorkTask-Contract.md) and explains *why*, not just *what*. Genuinely useful as a teaching artifact for how to structure an agentic system with proper engineering hygiene.
- **Output guardrail design** is more defensive/thorough than typical hobby projects — explicitly enumerates every way an LLM's JSON output can go wrong and has a tested fallback for each.
- **Novel data-layer consolidation**: using TimescaleDB + pgvectorscale to unify vector RAG storage, time-series agent-event tracing, and relational review/cost data into one Postgres instance is a clean architectural idea worth reusing regardless of vendor.
- **HITL (human-in-the-loop) design** is genuinely thought through: confidence-weighted routing, a documented 2-agent-agreement threshold before hard escalation, and a dispute/feedback/escalation subsystem (`backend/hitl/`) rather than a bolted-on afterthought.
- **GitHub client hygiene**: timeouts, retries, rate-limit headroom monitoring, and a clean exception hierarchy — solid reference implementation for any GitHub-integrating agent.
- Cost/economics is a first-class module (`backend/economics/`: budget guard, cost repository, routing advisor) with its own dashboard, not just logged and ignored.

### Weaknesses
- **Effectively a solo demo/course project, not a maintained product**: 5 stars, 1 contributor, no commits in ~2 months as of this analysis — much of the "production-grade" framing (title, ADRs, phase gates) is aspirational rather than field-proven; there is no external validation (no benchmark, no adoption data) comparable to PR-AF's.
- **Fixed reviewer taxonomy** (security/quality/tests/docs) — cannot adapt its review focus to what a specific PR actually touches the way PR-AF's dynamic dimension planner can; a PR that's 100% payments logic still just gets the same four generic lenses.
- **Heavy vendor/sponsor coupling**: the README and architecture are built explicitly around Tiger Cloud/TimescaleDB (a sponsored integration, "$1,000 in free credits," "Tiger MCP... for on-camera demo") — a large share of the documented value proposition is about the data-layer vendor, not about review quality itself.
- No adversarial/self-challenge mechanism, no evidence-grounding/falsifiability gate, no cross-agent compound-risk detection comparable to PR-AF's cross-reference resolver — each specialist agent's findings go straight to aggregation without a "prove this finding is real" step, so false-positive control relies only on prompt quality and a static confidence threshold.
- Extensive scaffolding (20 phases, ADRs, "economics" dashboard, dispute/escalation subsystem) for what is, in the code actually read, still a fairly standard fan-out/aggregate LLM-per-diff reviewer — the architectural ambition is broader than what's demonstrably working end-to-end (e.g., the LangGraph graph module itself notes its checkpointer is still a placeholder, not yet wired to Redis).
- No public benchmark or reproducible accuracy claims — "production-grade" is asserted, not measured.

### Lessons for building a PR review agent
1. **The output guardrail pattern is worth copying wholesale**: never trust an LLM's JSON shape; try multiple known key names, accept a bare list, catch per-finding parse errors individually (don't fail the whole batch for one bad item), and route low-confidence/malformed output to a human queue rather than silently dropping or blocking.
2. **Primacy/recency prompt structuring** (format instruction first, diff last) is a small, concrete, testable technique worth using directly.
3. **Separate the LLM verdict per agent from the system verdict**, and require multi-agent agreement before hard-escalating to a human — reduces single-agent miscalibration from cascading into constant HITL noise.
4. **A unified time-series+vector+relational datastore** (rather than 3 separate systems) meaningfully simplifies an agentic system's operational surface — worth considering even outside the specific vendor used here.
5. **GitHub API client discipline** (per-call timeouts, retry only on 5xx/network, rate-limit headroom warnings, typed exception hierarchy) is a good minimum bar for any tool that talks to GitHub's API at review-time.
6. **Caution as a counter-lesson**: heavy documentation/ADR/phase scaffolding does not by itself indicate a validated or adopted system — cross-check GitHub stars/forks/commit recency/contributor count before treating a repo's own claims ("production-grade") at face value.

Sources read directly: `README.md`, `backend/webhook_receiver/router.py`, `backend/orchestrator/graph.py`, `backend/agents/base_agent.py`, `backend/integrations/github_client.py`, repo file tree, GitHub API metadata (ayush488-glitch/ai-pr-review-agent).

---

## Side-by-side takeaways

| Dimension | PR-AF | ai-pr-review-agent |
|---|---|---|
| Review strategy | Dynamic, LLM-generated per-PR dimensions | Fixed 4 specialists (security/quality/tests/docs) |
| False-positive control | Dedicated adversary agent + falsifiability gate + evidence grounding | Prompt quality + static confidence threshold + HITL |
| Cross-finding reasoning | Dedicated cross-reference resolver (compound risk) | None found |
| Scoring | Deterministic code, fully separated from LLM | Simple mean-confidence + severity mapping |
| Trigger | Label-based GH Action + `@mention` webhook + direct API/CLI | Standard `pull_request` webhook only |
| Data layer | Repo checkout + programmatic blast-radius graph | RAG over TimescaleDB/pgvectorscale + peer-agent context |
| Orchestration engine | Custom AgentField control plane (Go/Python) | LangGraph StateGraph + ARQ/Redis |
| Maturity | 350★, 33 forks, 4 contributors, active | 5★, 2 forks, 1 contributor, stale ~2mo |
| Benchmark evidence | Public, reproducible (Martian Code-Review-Bench) | None |
| Speed | ~35-50 min/review (explicit CI-gate tradeoff) | Not benchmarked in repo |

Bottom line: PR-AF is the stronger reference for *review-quality architecture* (dynamic planning, adversarial challenge, evidence grounding, deterministic scoring) and is the one with actual field validation. ai-pr-review-agent is the stronger reference for *production engineering hygiene in the surrounding plumbing* (output guardrails, GitHub client resilience, HITL design, unified data layer) but should be read as a well-documented learning project rather than a proven tool.
