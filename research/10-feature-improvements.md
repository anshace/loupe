# Loupe — Feature Improvement Roadmap (de-duped, ranked)

**Date:** 2026-07-30
**Inputs:** the 67-candidate research set + the six detail files in
`research/features/` (quality-methods, context-retrieval, security-correctness,
output-actionability, eval-measurement, competitor-gaps).
**Quality priority (fixed):** (1) precision → (2) recall → (3) actionability →
(4) trust/UX.
**Guardrails honored:** zero-runtime-dep engine, free-tier-first, local-first,
no autofix/merge, no multi-model debate, no clone-and-execute of PR code.

This file supersedes the raw candidate list: overlapping proposals are merged
into single work items, each tagged with its **quality lever**, **effort
(S/M/L)**, and the **module(s) it touches** (real file names in
`packages/engine/src` unless noted). The 67 raw candidates collapse to **33
distinct work items** + **4 recorded out-of-scope decisions**.

---

## Merge map (what got combined, so nothing is silently dropped)

| Merged work item | Raw candidates folded in |
|---|---|
| Secret/credential pre-pass | "regex pre-pass" (S) + "detection pre-pass" (M) — identical |
| Committable suggestions | "fenced suggestion blocks" (S) + "validated single-line" (M) + "multi-line ranges" (S, as follow-on) |
| Self-consistency voting | "scoped to critical/high findings" (reviewer) + "low-confidence verifier verdicts" (verifier) — same technique, two gate points |
| PR-intent bundle | "PR title/description + linked-issue context" + "intent/scope-consistency finding" + "PR desc vs diff intent-consistency" (dup) |
| Import-graph cluster | "reverse-import tool" + "blast-radius escalation signal" + "ranked repo-map priming" + "deterministic signature-change caller check" |
| Test-context track | "related-tests retrieval" + "test-coverage-gap finding + suggested outline" |
| Conversational replies | "follow-up Q&A via issue_comment" + "in-thread replies on inline comments" |
| Feedback/learning loop | "capture reaction+resolution" (S) + "learned-rule suggestion queue" (L) + "feedback-driven learned rules" (L) |
| Calibration track | "empirical calibration from JSONL" + "severity/confidence Brier/ECE" + "Cohen's kappa swap check" |
| Supply-chain / deps | "CVE + license pass" + "new-dependency postinstall/provenance heuristic" |
| Security checklists | "CWE checklist" + "input-validation checklist" + "concurrency/resource-leak checklist" |
| Sink-pack + taint | "dangerous-sink SAST-lite rule pack" + "taint-flow prompting addendum" |
| TS symbol/type | "TS virtual language service" + "tsc diagnostics as findings" |

---

## TIER 1 — do these first (high quality-impact, in-scope, S/M effort)

These are the strongest precision/recall levers plus the cheapest
high-value actionability wins. Nearly all are S, prompt/schema/deterministic,
and reuse infra Loupe already has.

| # | Work item | One-line what | Lever | Effort | Touches |
|---|---|---|---|---|---|
| 1 | **Grounding on every verdict + mechanical quote check** | Require `evidence` on `keep`/`rewrite` too (not just `drop`), and deterministically verify any cited `file:line`+quote actually appears in the payload sent to the model; flag (never silently drop) mismatches | **Precision** | S | `verify.ts`, `verifier-v1.md`→v2, `types.ts` (new `SuppressReason`) |
| 2 | **Secret/credential pre-pass** | Zero-dep regex (+entropy) over *added* diff lines for AWS/GitHub/Slack/Stripe keys, PEM blocks, JWTs; emits deterministic `critical` findings that skip the LLM round-trip | **Recall+Precision** | S–M | new `secrets.ts`, `run.ts`, `.aireview.toml` allowlist |
| 3 | **PR-intent context + scope-mismatch finding** | Fetch PR title/body + linked issues (1 REST call, regex closing-keywords), inject as `{{PR_INTENT}}`; add rubric line flagging "described behavior not implemented / unrelated changes" | **Precision+Actionability** | S | `run.ts`, `types.ts` (`PrIntent`), `reviewer-v4.md`, `config.ts` |
| 4 | **GitHub Actions workflow supply-chain checks** | Deterministic checks on `.github/workflows/*.yml` diffs: unpinned action tags, `pull_request_target`+PR-head checkout, untrusted interpolation in `run:` | **Recall (security)** | S | new `workflowcheck.ts`, `run.ts` |
| 5 | **CWE + input-validation checklists (per language)** | Static extension→language table appending curated 2025 CWE Top-25 / OWASP-ASVS checklist lines to the system prompt for that file's language | **Recall** | S | `prompt.ts`, `reviewer-v4.md` |
| 6 | **Insufficient-context abstention category** | New closed-enum value the reviewer/verifier picks when it can't ground a claim — logged distinctly from "no issue found" | **Precision** | S | `types.ts`, `verify.ts`, prompts, `runlog.ts` |
| 7 | **Committable `suggestion` blocks (validated, single-line)** | Render a fix as a GitHub ` ```suggestion ` fence with backtick-escalation + exact-anchor validation (fall back to prose if not a clean same-line swap) | **Actionability** | M | `publish.ts`, `types.ts` (`suggestedLine`), `guardrail.ts`, reviewer prompt |
| 8 | **Reverse-import tool + forced signature-change caller injection** | `find_importers(path)` regex import-graph agentic tool; when a diff changes an exported signature, *force*-inject its call sites as context instead of hoping the model greps for them | **Recall (cross-file)** | M | new `importgraph.ts`, `agentic.ts`, `guardrail.ts`, `run.ts` |
| 9 | **Summary polish bundle** (4 cheap wins) | Severity-grouped findings table in summary; deterministic risk-verdict + review-effort line (reuse `escalate.ts` signal that's currently discarded); clickable blob permalinks; severity-first ordering of posted comments | **Actionability+Trust** | S each | `summary.ts`, `publish.ts`, `run.ts` |
| 10 | **Intra-run near-duplicate grouping** | Cluster the same issue repeated across files into one grouped comment before posting (pure post-processing) | **Actionability/Trust** | S | `publish.ts`, `dedupe.ts` |
| 11 | **Local eval trend log + static HTML** | Append `{date,sha,promptVersion,model,precision,recall,fpRate,dropRate}` per eval run to `evals/history.jsonl`; render a **local** HTML file (never uploaded) | **Measurement (protects P/R)** | S | `evals/` only |
| 12 | **Feedback observability capture** | When reading `existingComments` for dedupe, also read reaction counts + thread `isResolved` on Loupe's own prior comments; log accepted/disputed/unresolved. Pure observability, no behavior change | **Precision (foundation)** | S | `dedupe.ts`/fetch layer, `runlog.ts` |

**Rationale for Tier-1 ordering:** #1 closes the single concrete defect found
in the current code (the keep/drop evidence asymmetry in `verify.ts`) at zero
extra LLM cost. #2/#4 are deterministic ~100%-precision recall wins on the two
most damaging "boring" categories (leaked secrets, CI supply-chain). #3 is the
cheapest cross-cutting precision lever the engine is missing entirely. #8 is the
single most-cited competitor differentiator (cross-file bug catching) built from
substrate Loupe already has. #9–#12 are near-free and compound.

---

## TIER 2 — worthwhile, medium effort (build after Tier 1, validate on eval harness)

| # | Work item | One-line what | Lever | Effort | Touches |
|---|---|---|---|---|---|
| 13 | **Chain-of-verification questions in verifier** | Verifier must state + answer 1–2 falsifiable questions (using its capped grep/read budget) before emitting a verdict | Precision | S–M | `verifier-v1.md`→v2, `verify.ts` |
| 14 | **Few-shot exemplars from Loupe's own drops** | Add 2–4 curated real true/false-positive examples (mined from verifier-dropped history) to the reviewer prompt | Precision | M | `reviewer-v4.md` (content) |
| 15 | **Self-consistency voting (critical/high only)** | Re-run reviewer/verifier 1–2× at temp>0 on high-stakes findings; majority keeps, disagreement demotes not drops; gate to low-confidence cases to bound cost | Precision | M | `run.ts`, `verify.ts`, budget interaction |
| 16 | **Static-analysis / lint / tsc output ingestion** | Parse the repo's *existing* CI output (SARIF/eslint/tsc JSON) for touched files and inject as cited ground truth for the verifier to cross-reference | Precision | M | new parser module, `verify.ts`, `config.ts` |
| 17 | **Test-context track** | Deterministic sibling-test discovery (`foo.test.ts` etc.) → `{{RELATED_TESTS}}` block; optional coverage-gap finding phrased as factual observation (not "add tests" nag) | Recall+Actionability | S–M | `run.ts`, `reviewer-v4.md`, reuse `RepoReader` |
| 18 | **Multi-line suggestion ranges** | Extend `ReviewComment` with `startLine`/`startSide` so a small contiguous fix is also committable (same exact-anchor validation as #7) | Actionability | S | `publish.ts`, `types.ts` (after #7) |
| 19 | **Blast-radius + churn escalation signals** | OR an import-count signal (from #8's graph) and a `git log --grep revert/hotfix` churn signal into `shouldEscalate` | Precision | S | `escalate.ts` (after #8), new `history` helper |
| 20 | **Git blame/history context** | One GraphQL blame query per file+span → "last touched N days ago by M authors" line; gives the verifier's `pre-existing` drop-reason real evidence | Precision (verifier) | M | new `history.ts`, `scope.ts` wiring |
| 21 | **Dangerous-sink rule pack (SAST-lite) + taint prompting** | Hand-rolled per-language regex/light-AST pack (eval/exec, innerHTML, raw SQL, ReDoS, `shell=True`…) injected as *pre-flagged evidence lines*; require source→sink reachability citation before high/critical | Precision+Recall | L (phase JS/TS first) | new `sinkpack.ts`, `agentic.ts`, reviewer prompt |
| 22 | **Supply-chain / dependency risk** | Lockfile-diff scoped: flag `hasInstallScript:true` new deps (no API, S); OSV.dev `querybatch` for CVEs + registry license check (M/L) | Recall (supply-chain) | S→L | new `deps.ts`, `run.ts` |
| 23 | **Prompt-injection self-defense** | Scan attacker-reachable text templated into prompts (diff, HOUSE_RULES, `.aireview.toml` custom rules) for injection markers/zero-width Unicode; strip + surface a notice | Trust (Loupe's own security) | S | `guardrail.ts`, `prompt.ts`, `notices` |
| 24 | **A/B + regression eval harness** | Paired two-config runs with McNemar test + mandatory A/A self-test; `--snapshot` golden-output diff mode; LLM-judge scoring for scaled corpora | Measurement | M | `evals/run.mjs` |
| 25 | **SZZ real-bug corpus mining** | Local script mining bug-fix commits (own + cloned OSS repos) into synthetic pre-fix eval cases; grows 22→hundreds of *real* cases, $0 | Measurement (P/R fidelity) | L | `evals/` only |
| 26 | **Walkthrough narrative** | Optional sibling `walkthrough`/`effort` field on the reviewer's existing JSON (guardrail already tolerates object-wrap); fails open | Trust/UX (polish) | M | `reviewer-v4.md`, `guardrail.ts`, `summary.ts` |

---

## TIER 3 — nice-to-have / higher effort / needs the Worker path or prior substrate

| # | Work item | One-line what | Lever | Effort | Touches |
|---|---|---|---|---|---|
| 27 | **Bounded reflection ("verifier-of-verifier")** | One extra critique pass over only critical/high `keep`s, asking if the cited evidence establishes the claim | Precision | M | new `verifier-meta` prompt, `verify.ts` |
| 28 | **JSON field-ordering (quote+why before verdict)** | Force grounding fields first in the Finding schema; **validate on eval harness first** — CoT sometimes underperforms bare prompt for this task class | Precision (uncertain) | S | `types.ts`, reviewer prompt, `guardrail.ts` |
| 29 | **Empirical calibration from JSONL history** | Mine run-log into per-category/severity keep-rate table; flag/suppress persistently-low-keep-rate shapes pre-verifier | Precision | M | new offline module, `run.ts`, `config.ts` |
| 30 | **Calibration metrics (Brier/ECE, Cohen's kappa)** | Monotonicity check on severity vs acceptance; add verifier confidence field scored over time; kappa on model/prompt swaps | Measurement | S–M | `evals/`, `verify.ts` (after #12) |
| 31 | **Learned-rule suggestion queue** | Aggregate the #12 accept/dispute log to suggest `.aireview.toml` ignore-globs / HOUSE_RULES lines — human-accepted, never auto-applied | Precision (compounding) | L | new module, config (after #12) |
| 32 | **Conversational in-thread replies** | Handle `pull_request_review_comment` webhook; answer replies grounded in that finding's hunk. **Worker/App path only** | Actionability/Trust | M | worker `route.ts`/`handlers.ts` |
| 33 | **TS virtual language service + tsc diagnostics** | Real `find_definition`/`find_references`/hover via in-memory `ts.LanguageService` (no checkout); optional `tsc --noEmit` diagnostics as zero-hallucination findings (Action path, opt-in flag, needs Ansh sign-off) | Recall+Precision | L | new `packages/ts-symbols`, `agentic.ts` |
| — | ctags-lite index; concurrency/resource-leak checklist; ranked repo-map priming; public benchmark adapters (CodeReviewer/PrimeVul); shadow-mode dual-run; promptfoo adoption; DSPy offline tuning | Lower-priority rounding-out items; build only on demonstrated need (e.g. non-TS/JS repos, corpus size, eval time cost) | mixed | M–L | various / `evals/` |

---

## OUT OF SCOPE (recorded decisions, not omissions)

| Candidate | Why excluded |
|---|---|
| **Heterogeneous cheap+strong cross-vendor ensemble** | Violates "no multi-model adversarial debate"; permanent doubled paid-model bill vs free-tier ethos. Substitute: #15 same-model self-consistency. |
| **Full adversarial stage-gated refute/promote pipeline** | Materially the multi-model-debate pattern; several sequential LLM calls/finding + gating = bigger architecture than reviewer→verifier. Its one good idea (keep needs positive evidence) is captured by #1. |
| **Full SCIP/LSIF index or persisted graph DB** | Enterprise cross-repo scale; adds storage + staleness + refresh pipeline the project already rejected for embeddings-RAG. In-memory #8/#33 capture the benefit at v1 scale with zero staleness. |
| **Shell out to real SAST (Semgrep CE/OpenGrep/CodeQL)** | Requires external OCaml/Python/compiled binary → conflicts with zero-dep engine + "minimize runtime deps". Substitute: #21 hand-rolled sink pack + taint prompting. |
| **Autofix / auto-commit / failed-CI-log correlation** | Autofix violates the no-autofix non-goal outright. CI-log correlation is the most tangential candidate (reaches outside "review the diff", only helps when CI already failed) — deferred indefinitely, not built. |

---

## RECOMMENDED IMPLEMENTATION SET (next 4–6, ordered)

Each is in-scope, high-value, and well-tested in ~a day. Ordered by
quality-lever priority and dependency.

1. **Grounding on every verdict + mechanical quote check** (Tier-1 #1) —
   *Fixes the one real defect in current code (keep/drop evidence asymmetry) at
   zero extra LLM cost; pure precision.* Build first — everything downstream
   trusts the verifier.

2. **Secret/credential pre-pass** (Tier-1 #2) —
   *Deterministic ~100%-precision recall on the single most damaging category;
   skips the LLM entirely, so it can't be hallucinated away.*

3. **PR-intent context + scope-mismatch finding** (Tier-1 #3) —
   *Cheapest cross-cutting precision lever the engine wholly lacks today; also
   unlocks a genuinely useful new finding class (partial/forgotten intent).*

4. **Reverse-import tool + forced signature-change caller injection** (Tier-1 #8) —
   *The #1 competitor differentiator (cross-file bug catching), built from
   substrate Loupe already has; biggest recall win available.*

5. **Committable single-line `suggestion` blocks (validated)** (Tier-1 #7) —
   *Table-stakes actionability gap vs every competitor; turns a description of a
   fix into a one-click fix, with anchor validation so a broken button never
   ships.*

6. **Summary polish bundle** (Tier-1 #9: risk-verdict line + severity table +
   permalinks + severity ordering) —
   *Four near-free trust/actionability wins that reuse signals already computed
   (esp. the `escalate.ts` risk flag currently discarded); makes findings
   scannable so a busy human doesn't miss them.*

Deterministic wins #4 (workflow checks) and #5 (CWE checklists) are strong
same-day add-ons if appetite remains after the six above. Defer all M/L items
(self-consistency, sink pack, TS language service, feedback-loop rule mining,
SZZ corpus) until Tier-1 lands and the eval trend log (#11) exists to measure
whether they actually help — several cited papers show these techniques are not
free wins and need measurement against Loupe's own corpus.
