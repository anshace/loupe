# 09 — Feature Requirements Catalog

**Derived from:** research 04 (commercial landscape — CodeRabbit, Qodo/PR-Agent, Greptile, Ellipsis, Sourcery, Copilot, Graphite, BugBot), cross-checked against 01–03 (OSS reference architectures), 05 (GitHub mechanics), 06 (context strategies).
**Priorities:** P0 = must exist for the tool to be usable at all (maps to M0–M2). P1 = expected of a credible reviewer / core learning goals (M3–M4). P2 = later / v2+ (M5 or beyond).
**Milestone refs** point at `08-synthesis-architecture-and-milestones.md`.

---

## A. Table-stakes features
Every serious 2026 product has these; they are the entry price of admission (research 04 §"Table stakes").

| ID | Requirement (one line) | Priority | Milestone |
|---|---|---|---|
| TS-01 | Automatic review triggered on PR opened/reopened/ready-for-review with no manual invocation | P0 | M0–M1 |
| TS-02 | Inline, line-anchored comments on the diff (not just one top-level blob), posted as a single batched GitHub review | P0 | M1 |
| TS-03 | Auto-generated plain-English PR summary (what changed, risk level, verdict) as one upserted comment | P0 | M1–M2 |
| TS-04 | Structured findings with severity (critical/high/medium/low/nit) and category, scored against an explicit rubric | P0 | M1–M2 |
| TS-05 | Diff-size-aware handling: noise-file filtering (lockfiles/generated/vendored) and a visible truncation marker on large PRs — never silent truncation | P0 | M1 |
| TS-06 | Idempotent re-runs: dedupe against existing bot comments; never spam duplicates on repeated pushes | P0 | M2 |
| TS-07 | Repo-committed config file (`.aireview.toml`): severity threshold, ignored paths, toggles — teams expect to tune noise | P0 | M2 |
| TS-08 | Explicit do-not-report list (no style nits, no speculative concerns, no out-of-diff issues below high severity) baked into the prompt | P0 | M2 |
| TS-09 | Committable fix suggestions on findings where a concrete fix is obvious (GitHub ```suggestion``` blocks), not just prose | P1 | M2–M3 |
| TS-10 | Security-issue detection (common CWE-class bugs: injection, auth bypass, secrets in code) as a first-class finding category | P1 | M2 |
| TS-11 | Slash-command invocation on demand (`/review`, `/review full`) via PR comment, gated to collaborators | P1 | M3 |
| TS-12 | Follow-up Q&A on the PR (`/ask <question>`), answering with diff + repo context | P1 | M3 |
| TS-13 | Multi-LLM-provider flexibility behind one interface (Gemini/Anthropic/OpenAI-compatible; bring-your-own-key) | P1 | M1 onward (thin interface from day one) |
| TS-14 | Free-tier operation mode: whole pipeline runnable at $0/month (free LLM tier + Actions/Workers free tiers) | P0 | M1 |
| TS-15 | Re-review on new pushes (`synchronize`) without re-flagging already-acknowledged findings | P1 | M5 (naive full re-review acceptable through M4) |

## B. Differentiators
Where products currently compete (research 04 §"Differentiators") — the subset chosen as THIS project's edge, feasible solo.

| ID | Requirement (one line) | Priority | Milestone |
|---|---|---|---|
| DF-01 | Verifier/adversary second pass: every finding is kept/rewritten/dropped with cited file:line evidence and a closed drop-reason enum (Magpie/PR-AF's biggest quality lever; no commercial tool exposes this transparently) | P1 | M4 |
| DF-02 | Cross-file context via agentic search (grep/read enclosing scopes, follow imports/callers with capped hops) — Greptile-style codebase awareness without an index | P1 | M4 |
| DF-03 | AST-based context expansion: reviewer always sees the full enclosing function/class of each hunk (tree-sitter), not arbitrary ±3 lines | P1 | M4 |
| DF-04 | Per-repo house-rules file (`HOUSE_RULES.md`) whose conventions override reviewer claims and suppress known false-positive patterns | P1 | M2 |
| DF-05 | Narrow-scope-done-well positioning: bugs/correctness/security only by default (BugBot's wedge) — noise-averse by design, config can widen | P1 | M2 |
| DF-06 | Risk-based model routing: cheap model for routine diffs, frontier model auto-escalation for auth/payments/migration paths | P1 | M4 |
| DF-07 | Per-run and per-month LLM cost caps with real token accounting from provider responses; degrade to free-tier model rather than fail | P1 | M2 (caps), M4 (routing) |
| DF-08 | Transparency: every posted finding carries its confidence, category, and (post-M4) verification status — auditable, not oracle-style | P1 | M2–M4 |
| DF-09 | Custom org rules in config injected into review ("all handlers must validate input"), scoped per path-glob | P2 | M5 |
| DF-10 | Incremental re-review state: persist last-reviewed SHA + hunk hashes; review only `before..after` on push; carry forward unresolved findings as "still open" (fixes the documented Copilot failure mode) | P2 | M5 |
| DF-11 | Prompts as versioned in-repo markdown files, diffable and A/B-testable like code | P1 | M1 |
| DF-12 | Personal eval harness: ~20 curated PRs with known bugs, scored for precision/recall per prompt/model change | P1 | M4 |

## C. Later features
Real features in the market, deliberately out of scope for v1 (see non-goals in file 08). Recorded so they're a decision, not an omission.

| ID | Requirement (one line) | Priority | Source / note |
|---|---|---|---|
| LT-01 | Autofix agent: generate, test in sandbox, and push a fix commit on request (Ellipsis, BugBot Autofix) | P2 | Requires code-execution sandbox; violates v1 "never writes code" non-goal |
| LT-02 | Check Runs integration: pass/fail conclusion + annotations in the checks tab, usable as a branch-protection gate | P2 | Natural M3+ extension once the App exists; ~1 endpoint of work |
| LT-03 | GitLab support (Discussions + Commit Statuses adapter), then Bitbucket | P2 | Engine is platform-agnostic in shape; adapters only if a real user appears |
| LT-04 | Embeddings-RAG over house rules/ADRs/past review outcomes as supplementary context (sqlite-vec) | P2 | M5 experiment; research 06 says agentic search likely wins at this scale |
| LT-05 | Sequence/flow diagram generation in the PR summary (CodeRabbit) | P2 | Mermaid-in-comment is cheap to try; pure polish |
| LT-06 | Learned rules: adapt from accepted/rejected/resolved feedback on past findings (BugBot "learned rules") | P2 | Needs M5 state + outcome tracking first |
| LT-07 | Linked-ticket/issue context pulled into the prompt (intent vs diff gap check) | P2 | Qodo ticket-context feature; cheap once App reads issues |
| LT-08 | Multi-model adversarial debate with convergence detection (Magpie) | P2 | 10+ calls/PR; explicitly rejected for v1 economics |
| LT-09 | Review analytics dashboard (findings over time, FP rate, cost per repo) | P2 | The M5 run log is the data source; UI only if ever multi-user |
| LT-10 | Multi-tenant hosted service: installations, per-org config isolation, usage metering/billing | P2 | Explicit v1 non-goal; Workers+App architecture leaves the door open |
| LT-11 | Test-coverage assessment and unit-test generation (CodeRabbit Pro Plus, Qodo) | P2 | Distinct product surface; skip |
| LT-12 | In-IDE / pre-PR review channel (Sourcery, Copilot) | P2 | Different delivery surface entirely; skip |
| LT-13 | `/compliance`-style governance checks (ticket-requirement, duplication, org policy) | P2 | Qodo differentiator; enterprise-shaped, not hobby-shaped |
| LT-14 | HITL approval queue with confidence-weighted routing before posting | P2 | ai-pr-review-agent pattern; severity threshold is v1's noise valve |

---

## Priority summary

- **P0 (10):** TS-01…TS-08, TS-14 — plus the implicit platform plumbing (webhook/Action trigger, HMAC verification at M3). This set alone = a usable, non-annoying reviewer by end of M2.
- **P1 (14):** TS-09…TS-13, TS-15, DF-01…DF-08, DF-11, DF-12 — credibility and review quality; done by end of M4.
- **P2 (everything else):** M5 and the LT table — each needs a demonstrated concrete need before build.
