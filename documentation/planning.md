# Planning

Where Loupe stands, what's left before it can be used on a real PR, and what
the next round of feature work looks like. This document is a snapshot
(2026-07-30) built from the primary sources — it doesn't replace them:

- Milestone scope/exit-criteria: [`research/08-synthesis-architecture-and-milestones.md`](../research/08-synthesis-architecture-and-milestones.md) §3, condensed also in [`design.md`](../openspec/changes/build-pr-review-agent/design.md)'s milestone table.
- Task-level done/pending status: [`openspec/changes/build-pr-review-agent/tasks.md`](../openspec/changes/build-pr-review-agent/tasks.md).
- Feature backlog: [`research/10-feature-improvements.md`](../research/10-feature-improvements.md) (ranked, tiered).
- Live-test procedure: [`guides/04-how-to-run-and-test.md`](../guides/04-how-to-run-and-test.md), [`docs/github-app-setup.md`](../docs/github-app-setup.md).

---

## 1. Milestone roadmap (M0–M5)

All scope and exit criteria below come from `research/08` §3 (design.md
reproduces the same table). "Implementation" reflects the checkboxes in
`tasks.md`; "Live-verified" tracks the *exit criterion* specifically, which in
every milestone requires a real GitHub PR — none of that has run yet (see
§3).

| Milestone | Scope (one line) | Exit criterion | Implementation | Live-verified |
|---|---|---|---|---|
| **M0** | Workflow + ~50-line script posts a static stats comment on PR open | Opening a test PR yields a comment in ~1 min using only `GITHUB_TOKEN` | DONE (2.1–2.3) | NO — task 2.4 pending |
| **M1** | Fetch/parse diff, noise filter, one LLM call → JSON findings → batched review with inline comments | Buggy PR gets ≥1 correct inline comment on the right line; bad LLM output never crashes; run <2 min | DONE (3.1–3.10) | NO — task 3.11 pending |
| **M2** | Severity rubric + do-not-report list, line-range constraint, fallback chain, dedupe, summary upsert, `.aireview.toml`, Haiku + caching | Double-push → zero duplicate comments; summary edited in place; house rule suppresses its finding | DONE (4.1–4.11) | NO — tasks 4.12/4.13 pending |
| **M3** | GitHub App + Cloudflare Worker: HMAC verify, event routing, installation tokens, `/review`/`/ask` gated to collaborators | App reviews PRs on ≥2 repos with no workflow file; forged webhooks → 401; rando's `/review` ignored | Worker code DONE (5.2–5.8); **App itself not registered** | NO — task 5.1 (register) not started, 5.9 pending |
| **M4** | Enclosing-scope expansion (tree-sitter), capped agentic search, verifier pass, risk-based Sonnet escalation, cost caps | Verifier kills ≥30% of raw findings correctly on a ~20-PR eval set; one cross-file break caught; no run exceeds cost cap | DONE (6.1–6.7, eval set grew to 23 cases) | PARTIAL — offline replay eval passes structurally (§2), but the required **live-model** measurement (6.8) hasn't run; verifier ships **off by default** until it does |
| **M5** | Incremental re-review via stored SHA/hunk hashes, carry-forward of open findings, custom rules, optional sqlite-vec RAG experiment, run log | 1-line push to a 50-file PR reviews only the new range; custom rule fires; written RAG-on vs RAG-off comparison | DONE (7.1–7.6) | NO — tasks 7.7/7.8 pending (incl. writing the comparison note itself, which needs live runs) |

Takeaway: **every milestone's code is done**; what's outstanding in all six
cases is the *live* half of the exit criterion — a real GitHub repo, a real
PR, a real LLM key — plus, uniquely for M3, the one-time App registration
step itself. That's the entire remaining-work list, detailed in §3.

---

## 2. Current status snapshot

**Built:** M0–M5 complete against the `research/08` roadmap and
`design.md`'s milestone plan — hello-world Action, single-pass review,
quality/idempotency (config, house rules, dedupe, summary upsert), GitHub App
+ Worker (built, not deployed), context depth + verifier, incremental
re-review + custom rules + run log + optional RAG. See
[`guides/01-how-it-works.md`](../guides/01-how-it-works.md) for the
stage-by-stage pipeline walkthrough.

**Tests:** 547 passing across 38 test files (`vitest run`, re-confirmed
2026-07-30 — supersedes the 399/32 figure in `guides/01` and `guides/04`,
which predate the quality round below).

**Offline eval:** `node evals/run.mjs` over 23 seeded dummy-PR cases —
18/18 expected findings found, 0 missed, 1 unexpected (potential FP,
`secret-in-code` case — worth a look before tagging v1, not blocking), 1
verifier-drop, exit 0, **PASS**. This validates pipeline wiring against a
canned/replay provider; it is not the live-model measurement task 6.8 needs.

**Repo state:** `anshace/loupe` on GitHub, **PRIVATE**.

**Prompts:** current defaults are `prompts/reviewer-v7.md` and
`prompts/verifier-v2.md` (see `prompts/README.md` for the full version
history). v7 splits fixes into a committable `suggestedLine` vs. free-text
`suggestion`; verifier-v2 requires grounded `file:line` + verbatim-quote
evidence on every verdict (not just drops) and adds the `insufficient-context`
abstention reason. **The verifier pass itself remains off by default** in
engine config, pending the live 30%-kill-rate bar from task 6.8.

**Quality round shipped** (commit `51cca53`, on top of the M0–M5 build):
Tier-1 items from `research/10` — grounding + mechanical quote check,
secret/credential pre-pass (`secrets.ts`), PR-intent/scope-mismatch context
(`intent.ts`), GitHub Actions workflow supply-chain checks
(`workflowcheck.ts`), CWE/input-validation checklists, insufficient-context
abstention, committable suggestion blocks, reverse-import + forced
cross-file-caller injection (`importgraph.ts`), and summary polish
(severity table, risk-verdict line, permalinks, ordering). Two Tier-1 items
don't yet show clear evidence of shipping — the eval trend log
(`evals/history.jsonl`, item #11) and feedback-observability capture
(reaction/thread-resolution reading, item #12) — worth confirming or picking
up first in the next round (§5).

**Provider flexibility** (commit `ed23cb3`): config now supports any
OpenAI-compatible endpoint (OpenAI, OpenRouter, DeepSeek, Together, Groq,
local Ollama), any Anthropic endpoint, and Gemini — selected by `provider`
(protocol) rather than a hardcoded vendor list. This is a superset of
`research/08`'s original three-provider plan (Gemini/Haiku/Groq); the
underlying `ReviewModel` interface decision is unchanged.

**Shipping now — Mode B, the GitHub Action** (commit `9282a63` packaged it:
`ncc` bundle + `action.yml`, ready for `uses: anshace/loupe@v1` once tagged).
Zero hosting; each consumer brings their own `GITHUB_TOKEN` and LLM key. See
[`guides/02-plan-b-open-source-action.md`](../guides/02-plan-b-open-source-action.md).

**Deferred — Mode A, the GitHub App + Cloudflare Worker.** Code is built and
tested (`packages/worker`, M3 tasks 5.2–5.8), but the App is not registered
(task 5.1) and nothing is deployed — deploying it means Ansh's own key funds
every installer's LLM calls. See
[`guides/03-future-github-app.md`](../guides/03-future-github-app.md).

---

## 3. Remaining work: live-verification phase

Everything below is deferred by explicit project decision (`CLAUDE.md`,
2026-07-29): develop and test against unit tests + mock providers, defer
every task that needs a real GitHub repo/PR/API key to one final
verification pass. The full step-by-step procedure lives in
[`guides/04-how-to-run-and-test.md`](../guides/04-how-to-run-and-test.md);
this is the checklist view, mapped to the exact task IDs in `tasks.md`.

**Setup (guides/04 steps 1–3), once:**

- [ ] Push the testbed repo — `code-review-testbed`
  (`C:\Users\Ansh\Documents\ANSH\code-review-testbed`) isn't on GitHub yet:
  `gh repo create anshace/code-review-testbed --private --source . --push`.
- [ ] Publish the bot far enough to be invoked from the testbed — either the
  packaged `action.yml` (tag `v1`, `uses: anshace/loupe@v1`) or the interim
  checkout-and-run invocation already sketched in the testbed's workflow file.
- [ ] Add the workflow + an LLM key as a repo secret
  (`ANTHROPIC_API_KEY` or `GEMINI_API_KEY`).

**Action-path verification, per task ID:**

- [ ] **2.4** — opening a dummy PR produces the M0 stats comment within ~1
  min using only `GITHUB_TOKEN`; re-running the workflow doesn't crash.
- [ ] **3.11** — a seeded-bug PR gets ≥1 correct inline comment on the right
  line; a docs-only PR gets a clean "no issues" summary; garbage LLM output
  never crashes the run; total run <2 min.
- [ ] **4.12** — a second push to the same PR produces zero duplicate
  comments; the summary is edited in place; a `HOUSE_RULES.md` `suppress:`
  rule matching the seeded bug suppresses it; a draft PR gets no comments.
- [ ] **4.13** — a repo with no `.aireview.toml` reviews on defaults; a
  broken/unparseable config still completes the run with a visible
  "invalid config" notice, never a crash; editing config takes effect on the
  next PR with no redeploy.
- [ ] **6.8** — `REVIEW_MODEL=haiku nub run eval` (live mode, real key) over
  the 23-case eval set: verifier (`verify: true`) kills ≥30% of raw findings
  and the drops are correct on manual inspection; the
  `cross-file-signature-break` case is caught via agentic search; no case
  exceeds the cost cap. **This is the run that decides whether verifier
  default flips to on.**
- [ ] **7.7** — pushing a 1-line fix to a ~50-file dummy PR with
  `REVIEW_STATE_PATH` set reviews only the new commit range; still-unfixed
  prior findings appear under "Still open from previous runs," not re-posted
  inline.
- [ ] **7.8** — a custom `[[rules]]` entry in `.aireview.toml` (e.g. "all API
  handlers must validate input with zod") fires on a violating PR; then write
  the RAG-on vs RAG-off comparison note in `docs/` from live eval-set runs.

**App-path verification (only if/when Mode A is revisited):**

- [ ] **5.1** — register the GitHub App per
  [`docs/github-app-setup.md`](../docs/github-app-setup.md) (permissions,
  webhook secret, PKCS#8 private key conversion, smee.io local loop).
- [ ] **5.9** — App installed on ≥2 local test repos reviews both with no
  workflow file; forged/unsigned webhooks get 401; a collaborator's
  `/review` triggers a run with a 👀 reaction ack; a non-collaborator's
  `/review` produces nothing.

---

## 4. Go-public checklist

Only after every box in §3's Action-path list is checked (App path is
optional — Mode B is what's shipping):

- [ ] All Action-path live-verification tasks (2.4, 3.11, 4.12, 4.13, 6.8,
  7.7, 7.8) checked off with real evidence, not just offline eval.
- [ ] Secrets review: confirm no real API keys, `.pem` files, or webhook
  secrets are committed anywhere in the bot repo's history (`.dev.vars` is
  gitignored; double-check before flipping visibility — shared-machine rule).
- [ ] Decide/document the public README's default model recommendation
  (currently Haiku 4.5 default, Sonnet 5 escalation) with the confirmed cost
  numbers from a live 6.8 run, not just the projection in §6.
- [ ] Add a license file (none currently present in the repo root) if going
  public — open decision, not yet made.
- [ ] Flip `anshace/loupe` from private to public
  (`gh repo edit anshace/loupe --visibility public` or the GitHub UI) — an
  explicit Ansh decision per `CLAUDE.md`, not automatic.
- [ ] Tag `v1` (`git tag v1 && git push --tags` or `gh release create v1`) so
  the README's `uses: anshace/loupe@v1` example actually resolves.
- [ ] No further announcement/publish step needed — solo project; flip +
  tag is the whole "launch."

---

## 5. Feature backlog (from research/10)

Full ranked list, merge map, and rationale:
[`research/10-feature-improvements.md`](../research/10-feature-improvements.md).
This section is a decision aid, not a restatement — read the source file
before picking the next batch.

**Tier 1 (items #1–12)** is the set already largely delivered by the quality
round in §2 above; items #11 (eval trend log) and #12 (feedback-observability
capture) are the two not yet confirmed shipped — cheapest next pickup if
Tier 1 needs closing out before moving to Tier 2.

**Tier 2 — worthwhile, medium effort, validate on the eval harness (items
#13–26):** groups into four themes —
- *Precision:* chain-of-verification questions in the verifier (#13),
  few-shot exemplars mined from Loupe's own drops (#14), self-consistency
  voting scoped to critical/high findings (#15), ingesting the repo's
  existing lint/tsc/SARIF output as verifier ground truth (#16), git
  blame/history context for the verifier's `pre-existing` drop-reason (#20).
- *Recall + actionability:* related-tests discovery + coverage-gap findings
  (#17), multi-line suggestion ranges (#18), blast-radius/churn escalation
  signals building on the import-graph tool (#19).
- *Heavier security:* a hand-rolled dangerous-sink/taint rule pack (#21,
  effort L), supply-chain/CVE + license checks on new dependencies (#22).
- *Loupe's own security + measurement:* prompt-injection self-defense on
  attacker-reachable prompt content (#23), an A/B + regression eval harness
  with McNemar testing (#24), mining real bug-fix commits into a larger eval
  corpus via SZZ (#25, effort L), and an optional walkthrough narrative field
  (#26, polish).

**Tier 3 — nice-to-have / higher effort / needs prior substrate (items
#27–33):** bounded "verifier-of-verifier" reflection (#27), a JSON
field-ordering experiment flagged as uncertain-value by the source research
(#28), empirical calibration mined from run-log history (#29), calibration
metrics — Brier/ECE/Cohen's kappa (#30), a learned-rule suggestion queue
(#31, effort L, needs #12 first), conversational in-thread replies (#32,
**Worker/App path only** — blocked on Mode A shipping), and a real TS
language service + `tsc` diagnostics (#33, effort L). A lower-priority
rounding-out list (ctags-lite index, concurrency/resource-leak checklist,
ranked repo-map priming, public benchmark adapters, shadow-mode dual-run,
promptfoo, DSPy tuning) sits below all of the above — build only on
demonstrated need.

**Recorded out-of-scope** (not omissions — deliberate calls, with
substitutes noted): cross-vendor model ensembles, a full adversarial
multi-stage refute/promote pipeline, a persisted SCIP/LSIF graph index,
shelling out to real SAST tools (Semgrep/CodeQL), and autofix/CI-log
correlation. Rationale for each is in `research/10`'s "OUT OF SCOPE" table.

---

## 6. Cost outlook

Condensed from `research/08` §5 (hobby scale: ~100–150 reviews/month, avg 5K
input/800 output tokens per reviewer call, ×2.2 from M4 for the verifier pass
+ occasional Sonnet escalation). See the source file for full assumptions.

| Item | M0–M2 | M3–M4 | M5 |
|---|---|---|---|
| GitHub Actions | $0 | $0 | $0 |
| Cloudflare Workers + KV (Mode A only, not deployed) | — | $0 | $0 |
| LLM — Gemini Flash free tier (dev/testing) | $0 | $0 | $0 |
| LLM — Haiku 4.5 reviews (prompt caching) | ~$0.50–1 | ~$1.50–2.50 | ~$2–3 |
| LLM — Sonnet 5 escalations (~10% of PRs) | — | ~$0.30–0.50 | ~$0.50 |
| Storage (KV/SQLite, free tier) | $0 | $0 | $0 |
| **Total** | **≈ $0–1/mo** | **≈ $2–3/mo** | **≈ $3–5/mo** |

Worst realistic case ~$5/mo; $0/mo is achievable on free-tier LLMs (Gemini
Flash or Groq) with the ToS caveat that Gemini's free tier isn't appropriate
for proprietary code (test/public repos only — `design.md` Risks). Cost
guards already built in from M2: per-run token/cost cap, a monthly budget env
var that degrades to the free-tier model when exceeded, and real token
counts from provider responses. The M3–M4/M5 columns above assume the App is
deployed; since Mode A remains undeployed (§2), actual current spend tracks
the M0–M2 column regardless of which milestone's *code* is installed.

The provider-flexibility work (`ed23cb3`, §2) doesn't change this table's
shape — Haiku 4.5 remains the quality default; the extra providers (OpenAI,
OpenRouter, DeepSeek, Together, local Ollama) are alternate knobs a user can
turn, not a change to Loupe's own projected spend.
