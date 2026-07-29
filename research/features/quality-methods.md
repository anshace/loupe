# Quality-methods research: LLM/agentic techniques to raise review precision & recall

Date: 2026-07-30
Scope: techniques NOT already implemented in Loupe (see "already has" list in the
research brief). Priority order per project convention: precision > recall >
actionability > trust/UX. Everything proposed below is local/free-tier-first and
buildable inside the existing zero-dep engine unless explicitly flagged out of
scope.

Grounded against the actual current implementation (read before researching):
`packages/engine/src/verify.ts`, `packages/engine/src/escalate.ts`,
`packages/engine/src/types.ts`, `prompts/reviewer-v3.md`, `prompts/verifier-v1.md`,
`openspec/changes/build-pr-review-agent/design.md`.

---

## Key baseline facts about Loupe's current pipeline (so gaps below are precise, not guesses)

- The verifier (`verify.ts`, `verifier-v1.md`) requires `reason` (closed enum) +
  `evidence` (a `file:line` + quote string) to **drop** a finding, and fails
  open (keeps) if either is missing or the whole output is unparseable. This is
  good adversarial design for *drops*.
- **Asymmetry found**: a **`keep`** verdict requires *no evidence at all* —
  `VERDICT_SYNONYMS` accepts bare `keep`/`accept`/`valid`/`confirmed` with an
  optional `evidence` field (`coerceString`, not required). Nothing checks that
  a cited `evidence` string is *actually true* against the diff/context — only
  that the string is non-empty. So the verifier can rubber-stamp a bad finding
  with zero scrutiny, or drop a good one with a fabricated-sounding but false
  citation, and the pipeline can't tell.
- The reviewer prompt (`reviewer-v3.md`) is entirely zero-shot / rule-based
  (severity rubric + do-not-report list) — no worked examples of a real
  true-positive vs. a real false-positive.
- No numeric/ordinal confidence field anywhere in `Finding`, `VerifierDecision`,
  or the prompts. The `SCORE["... filter by confidence ..."]` box in the
  architecture diagram (`research/08-synthesis-architecture-and-milestones.md`)
  is a design-time placeholder label for the deterministic dedupe/anchoring
  step, not an implemented confidence mechanism.
- The verifier's own "keep the finding" decision is never itself re-checked —
  there is exactly one verification pass, not a reflection loop.
- `escalate.ts` swaps to a single stronger model on risky paths; it is not an
  ensemble/cross-model vote — only one model runs per finding, ever.
- Per-run JSONL run log (task 7.5, already built) records model/tokens/cost and
  kept/dropped/drop-reasons per run — this is a real, currently-unused data
  asset for offline calibration (see Method 5).

---

## Method 1 — Grounding requirement on *every* verdict, with mechanical (non-LLM) quote validation

**What it is.** Two changes to the existing verifier, motivated by the
asymmetry above:
1. Require `evidence` (a `file:line` + short verbatim quote) on **every**
   verdict — `keep` and `rewrite` too, not just `drop`. A `keep` with no
   evidence is treated the way an unparseable drop is treated today (logged as
   degraded-for-that-finding; the underlying design principle of "fail open on
   ambiguity" still applies — this doesn't drop the finding, it just stops
   trusting the verifier's rubber-stamp and can flag it for the run log /
   summary notices).
2. Add a **deterministic, non-LLM** post-check: for any `evidence`/`quote`
   string a model returns (reviewer's own finding `body`, or verifier's
   `evidence`), mechanically confirm the cited `file:line` exists in the
   diff/context payload actually sent to the model, and that a
   normalized-whitespace substring match of the quoted text appears within a
   small window of that location. A citation that fails this check is treated
   as ungrounded (new `SuppressReason: "ungrounded-quote"` / logged, never
   silently dropped per the project's "never silent" rule).

**Why it raises quality.** This is the "grounding / quote-the-code" pattern
from the research brief, applied at the cheapest possible layer: it costs zero
extra LLM calls, reuses the exact diff/context strings already in memory, and
directly targets citation hallucination — a documented failure mode where
models fabricate plausible-looking citations that don't actually reference the
provided context. Citation-grounded generation research treats exactly this
kind of mechanical cross-check as the architectural fix, distinct from (and
cheaper than) trusting the model's self-reported grounding: "the key
difference is enforcing citations architecturally through mechanical
verification rather than relying on model behavior" (see Sources). A legal-
extraction paper doing the same pattern with an `evidence_grade` field and
explicit reference-vs-source comparison reports it as their primary
hallucination-elimination technique.

**Effort: S.** Prompt tweak to `verifier-v1.md` → `verifier-v2.md` (evidence
required on keep too); a pure function alongside `parseVerifierOutput` /
`coerceDecision` in `verify.ts` to validate a citation string against the
diff/context text (same style as existing `coerceString`/`coerceReason`
helpers); a new `SuppressReason` variant; tests. No new LLM calls, no new
pipeline stage.

**In scope:** yes.

---

## Method 2 — Self-consistency multi-sample voting, scoped to critical/high findings only

**What it is.** For findings the reviewer (or verifier) rates `critical` or
`high`, re-run the *same* reviewer model 1–2 additional times at temperature >
0 on just the relevant hunk, and require majority agreement (2-of-3) that the
issue exists before it's allowed to keep that severity. Disagreement demotes
the severity (e.g., to `medium`) rather than dropping outright, consistent with
the project's fail-open bias. This is deliberately *not* full self-consistency
on every finding (too costly) — it's a bounded tie-breaker on the small subset
that matters most for trust (critical/high is exactly where a false alarm is
most damaging to a maintainer's confidence in the bot).

**Why it raises quality (with numbers).** A 2026 benchmarking study of
LLM-based PR review ("Multi-Review", arXiv:2509.01494) found only 27 of the
change-points overlapped across 5 independent runs of the *same* model on the
same diff — i.e., huge run-to-run variance — and that self-aggregating 10
independent samples of one model (`Self-Agg`, n=10) raised F1 by **+43.67%**
and recall by **+118.83%** over a single-pass review baseline, precisely
because majority-voting suppresses one-off hallucinated findings while
surfacing the issues that keep reappearing across samples. A 2026 ICLR
workshop paper on reliability-aware self-consistency (ReASC) shows the
early-halting/weighted variant recovers most of the benefit for 70–80% less
compute than naive n-sample voting, which is the version worth building given
Loupe's per-run token budget.

**Effort: M.** Needs: (a) a way to re-invoke the reviewer on a narrowed
hunk-scoped prompt, (b) fuzzy matching of findings across samples (same
file + nearby line + same category), (c) severity-demotion logic, (d) budget
interaction with the existing per-run token cap (bound it to at most 2 extra
calls, only for candidates already ≥ high, so worst-case cost growth is small
and proportional to how many high-severity findings a PR actually produces),
(e) tests.

**In scope:** yes.

---

## Method 3 — Bounded second-round reflection: a "verifier-of-the-verifier" for critical/high `keep` verdicts

**What it is.** After the existing verifier pass, run one more short,
cheap-model pass — but only over findings the verifier just marked `keep` at
`critical`/`high` severity (typically a small set) — asking it to critique the
verifier's own stated evidence: "does this citation actually establish the
claim? yes/no, with its own citation." This is a genuine second reflection
round (distinct from Method 1's mechanical check and Method 4's CoVe
questions), matching the research brief's ask for "reflection/self-critique
loops beyond a single verifier pass."

**Why it raises quality.** Multi-Agent Reflexion (MAR, arXiv:2512.20845) shows
that replacing a single self-critique pass with a second, differently-framed
critique round consistently outperforms single-round reflection on both
reasoning and code tasks — the second critic catches errors the first
round's own framing was blind to. The countervailing risk documented in the
2026 literature on evaluating reflection loops is over-correction and cost:
the three metrics that matter are "pre-vs-post delta, over-correction rate,
and cost-per-improvement" — which is exactly why this should be scoped to the
already-small critical/high `keep` set rather than run on every finding.

**Effort: M.** One new bounded pipeline stage, a new short prompt
(`verifier-v1.md`'s companion, e.g. `verifier-meta-v1.md`), wiring to only fire
on critical/high `keep`s, and a decision on what a "meta-drop" does to the
`VerificationRecord` shape (extend `VerificationRecord`/`DroppedFinding` or add
a parallel `meta` note) — plus tests.

**In scope:** yes.

---

## Method 4 — Chain-of-verification-style explicit verification questions in the verifier prompt

**What it is.** Instead of asking the verifier to jump straight to a
keep/rewrite/drop verdict, require it to first state 1–2 concrete, falsifiable
verification questions per finding (e.g., "Is `discountPercent` actually
unbounded at the call site on line 40?") and answer each — using the verifier's
existing capped grep/read_file tool budget — *before* emitting the verdict.
This is the Chain-of-Verification (CoVe) pattern applied to the verdict step
Loupe already has, rather than a new pipeline stage.

**Why it raises quality.** CoVe's original paper (arXiv:2309.11495 /
ACL Findings 2024) shows independently-answered verification questions reduce
hallucination because "independent verification questions tend to provide more
accurate facts than those in the original long-form answer," improving F1 by
23% on hallucination-prone tasks, and outperforming plain CoT. This maps
cleanly onto Loupe's verifier: today it asks for a verdict directly off the
diff in one inferential leap; decomposing into question → tool-grounded answer
→ verdict is a prompt-and-parsing change to an existing stage, not new
architecture.

**Effort: S.** Prompt-only change to `verifier-v1.md` → `verifier-v2.md`
(structure the required reasoning before the JSON verdict array, or add an
optional `questions`/`answers` array per finding for transparency in the run
log). No new engine pipeline stage; minor parsing addition if the Q&A is to be
logged.

**In scope:** yes.

---

## Method 5 — Empirical calibration from Loupe's own JSONL run-log history (behavioral confidence, not self-reported)

**What it is.** Loupe already writes a per-run JSONL log (kept/dropped findings
+ drop reasons, task 7.5) but nothing reads it back. Mine that history offline
to compute, per (category, severity, [optionally] rule/path pattern), the
empirical rate at which the verifier historically kept vs. dropped findings of
that shape. Use this as a deterministic prior: categories/severities with a
persistently low historical keep-rate (e.g. <20% over ≥N runs) get an extra
scrutiny flag or default-suppress-unless-overridden before they even reach the
LLM verifier — a cheap, zero-inference-cost filter learned from the project's
own behavior.

**Why it raises quality — and why *not* to ask the LLM to self-report
confidence instead.** A 2026 study on calibrating LLM-grader confidence found
that on an ordinal 1–5 confidence scale, LLMs "rarely express low or moderate
confidence" — scores 1 and 2 are "virtually absent" — while human raters use
the full scale; i.e., raw self-reported LLM confidence is measurably
miscalibrated and truncated, so asking the model "how confident are you 1–5"
is a weak signal on its own. Empirical/behavioral calibration (using observed
outcome rates rather than the model's self-report) is the standard fix in the
selective-prediction literature, and it's *free* here because Loupe already
has the outcome log to calibrate against — this is squarely in the
free+local, zero-new-dependency spirit of the project.

**Effort: M.** A small offline script/module to aggregate the JSONL logs into
a calibration table (versioned as a data file, refreshed periodically, not a
live network call), a config knob for the suppression threshold, and wiring
into the pipeline as a pre-verifier filter step with tests. Needs enough
historical runs to be meaningful — genuinely useful only after Loupe has been
dogfooded for a while, but the mining code itself is buildable now.

**In scope:** yes.

---

## Method 6 — Few-shot exemplars mined from Loupe's own historical false positives

**What it is.** `reviewer-v3.md` is currently zero-shot: a severity rubric and
a do-not-report list, no worked examples. Add 2–4 curated few-shot pairs to the
prompt: one canonical true-positive finding (well-formed, with a real quote +
correct severity) and 2–3 real false-positive exemplars — sourced from Loupe's
*own* historical verifier-dropped findings, one per do-not-report category
that recurs most often in practice — rather than hand-invented generic
examples.

**Why it raises quality.** A 2026 empirical study on reducing false positives
in LLM-based static bug detection directly compared prompting strategies (bare
prompt, CoT, few-shot with true/false-positive exemplars, bug-type
augmentation) and found few-shot "consistently yields the best results among
the three prompt strategies," while plain chain-of-thought *underperformed* a
basic prompt on the same task — a useful, slightly counter-intuitive data
point that argues for prioritizing this over adding open-ended CoT (see Method
7's caveat). Exemplar-selection research separately shows composition matters
more than count, and that project-specific (vs. generic) exemplars improve
robustness — which is why mining Loupe's *own* historical drops, rather than
writing synthetic ones, is the recommended version here.

**Effort: M.** Initial curation is manual (pick the best 3–4 real
dropped-finding examples from eval runs so far); a "self-refreshing" variant
that periodically re-mines the JSONL logs for new/better exemplars is a
natural follow-up but would be L on its own. First static version is a prompt
file change (`reviewer-v3.md` → `reviewer-v4.md`) with no engine changes.

**In scope:** yes.

---

## Method 7 — JSON schema field-ordering: force `evidence_quote` + one-line rationale before the verdict fields

**What it is.** Add two small required fields to the `Finding` JSON schema,
ordered *before* `severity`/`title` in the object: `quote` (verbatim excerpt of
the offending code, feeding Method 1's mechanical check) and `why` (one
sentence). Because JSON generation is effectively left-to-right, requiring
these fields first is a lightweight forcing function for the model to ground
itself before committing to a verdict — without violating the existing
"JSON-only, no prose" output contract (the fields are structured, not free
text).

**Why it raises quality — stated with the honest caveat.** Prompting research
broadly supports "reasoning before the answer" as a beneficial slot ordering
for structured extraction (Prompt Report survey, arXiv:2406.06608), and
structured-output hallucination-control work explicitly uses adjacent
`reasoning`/`evidence_grade` fields ahead of the final answer for this reason.
**However**, the same false-positive-reduction study cited in Method 6 found
plain CoT prompting *underperformed* a bare prompt for this exact task class
(bug/defect classification) — the authors' hypothesis is that current strong
models may have already internalized step-by-step reasoning, so forcing it
explicitly can add noise rather than signal. Net recommendation: build this as
a schema change, but validate on Loupe's eval harness (task 6.8) before
defaulting it on — treat it as a testable variant, not an assumed win.

**Effort: S.** `Finding` type + reviewer prompt schema change, parser update
in the guardrail, tests. Directly complementary to (and required by) Method 1.

**In scope:** yes.

---

## Method 8 — Explicit "insufficient context" abstention category

**What it is.** Extend the existing closed enums (`DropReason`,
`SuppressReason`) with an explicit `insufficient-context` value the
reviewer/verifier can select when it genuinely cannot ground a claim in the
supplied diff/context — instead of either silently omitting the finding
(current default, which loses the signal that something was *noticed but
unconfirmable*) or guessing. Logged distinctly in the JSONL run log so it feeds
Method 5's calibration and gives visibility into how often context caps
(diff/enclosing-scope caps) are actually costing findings.

**Why it raises quality.** Selective-prediction / uncertainty-aware-abstention
research (e.g. arXiv:2607.04430, "Uncertainty-Aware Abstention... with
Provable Alignment Guarantees") frames this as reducing "low-confidence
guessing while preserving performance when the model does know the answer" —
the goal isn't blanket refusal but distinguishing *don't know* from *no
issue*, which today's pipeline can't tell apart (both look identical: no
finding emitted). Distinguishing them is what makes Method 5's calibration and
any future "expand context and retry" flow (e.g. requesting more agentic tool
budget specifically for the abstained cases) possible at all.

**Effort: S.** Enum extension + prompt update + minor engine/logging wiring;
reuses the existing suppressed-findings and run-log plumbing.

**In scope:** yes.

---

## Method 9 (out of scope) — Heterogeneous cheap+strong model ensemble / cross-model corroboration

**What it is.** Run two *different* model families (e.g. a cheap model as
first-pass generator, a strong different-vendor model as independent
corroborator) and combine via voting, rather than one model doing the review
and a same-vendor stronger model only stepping in on risky paths.

**Evidence it works, for completeness.** A 2026 paper on defect-focused
automated code review found that pairing a strong validator model with a
cheaper generator model can match or exceed all-strong-model performance
(the validator matters most since it's closest to the final decision); the
same benchmarking study behind Method 2 tested `Multi-Agg` (aggregating across
different LLMs) alongside `Self-Agg` and found genuine additional diversity
benefit from heterogeneous models, not just resampling one model.

**Why it's flagged out of scope for Loupe specifically.** The project's
non-goals explicitly exclude "multi-model adversarial debate," and a true
cross-vendor ensemble means paying for two different paid model calls per
finding on every run — real recurring cost against a free-tier-first,
zero-new-dependency, solo-dev project. Loupe's existing combination of
risk-based single-model escalation (`escalate.ts`) plus the adversarial
verifier pass already captures most of the same "a second, differently-tuned
judgment catches what the first missed" benefit this literature describes,
for one extra call instead of a permanent doubled-model-family bill. Method 2
(same-model self-consistency) is the recommended in-scope substitute — it gets
a meaningful slice of the ensemble benefit (majority-vote suppression of
one-off hallucinations) without the recurring cross-vendor cost or the
non-goal conflict.

**In scope: no.** Conflicts with the explicit "no multi-model adversarial
debate" non-goal and duplicates cost the existing verifier + escalation
already substantially cover.

---

## Method 10 (out of scope) — Full adversarial stage-gated refute/promote multi-agent pipeline

**What it is.** A 2026 paper ("Refute-or-Promote," arXiv:2604.19049) describes
a 4-stage pipeline: initial LLM detection → a dedicated *refutation* agent
that tries to disprove each finding → a *promotion* stage that further
validates survivors → confidence-threshold gates between stages. This is
architecturally a multi-agent adversarial debate over multiple rounds, not a
single verifier call.

**Why it's flagged out of scope for Loupe.** This is materially the pattern
the project's non-goals call "multi-model adversarial debate" (multiple
agents arguing/validating each other across several rounds) — even run with
one model family playing multiple roles, it's several sequential LLM calls
per finding with gating logic, which is a meaningfully bigger, more expensive
architecture than Loupe's current single reviewer → single verifier design.
The one genuinely valuable, cheap piece of this pattern — that a "keep" should
require positive confirming evidence, not just that a "drop" requires
refuting evidence — is already captured without adding a pipeline stage by
Method 1 above (requiring evidence on `keep` too, checked mechanically rather
than by a second full LLM agent).

**In scope: no.** Same non-goal conflict as Method 9; its one useful idea is
already folded into Method 1 at a fraction of the cost.

---

## Summary table

| # | Method | Effort | In scope |
|---|---|---|---|
| 1 | Grounding requirement on every verdict + mechanical quote check | S | yes |
| 2 | Self-consistency voting, scoped to critical/high findings | M | yes |
| 3 | Bounded second-round reflection on critical/high `keep`s | M | yes |
| 4 | Chain-of-verification questions in the verifier prompt | S | yes |
| 5 | Empirical calibration from existing JSONL run-log history | M | yes |
| 6 | Few-shot exemplars mined from historical false positives | M | yes |
| 7 | JSON field-ordering: quote + rationale before verdict (with caveat) | S | yes |
| 8 | Explicit "insufficient context" abstention category | S | yes |
| 9 | Heterogeneous cheap+strong model ensemble | — | **no** — non-goal conflict |
| 10 | Full adversarial stage-gated refute/promote pipeline | — | **no** — non-goal conflict |

Recommended build order if picking a subset: **1 → 7 → 8 → 4** (all S, all
prompt/schema-level, no new pipeline stages, directly closes the biggest
concrete gap found — the keep/drop evidence asymmetry) before attempting the M
items (2, 3, 5, 6), which add real pipeline stages or offline tooling and
should be validated against the eval harness (task 6.8) rather than shipped by
assumption — several of the papers above (CoT underperforming, over-correction
in reflection loops, ReASC's early-halting) show these techniques aren't free
wins and need measurement against Loupe's own eval set.

---

## Sources

- Self-consistency / majority voting:
  - [Self-Consistency Sampling in LLMs](https://www.emergentmind.com/topics/self-consistency-sampling)
  - [ICLR 2026 TTU Workshop — Majority Voting for Code Generation](https://openreview.net/pdf?id=hEnnYgRJdC)
  - [Towards Reliable LLM Grading Through Self-Consistency and Selective Human Review](https://www.mdpi.com/2504-4990/8/3/74)
  - [When Does Delegation Beat Majority? A Delegation-Based Aggregator for Multi-Sample LLM Inference](https://arxiv.org/pdf/2606.08098)
- Benchmarking LLM-based code review (Self-Agg / Multi-Agg numbers):
  - [Benchmarking and Studying the LLM-based Code Review](https://arxiv.org/html/2509.01494v1) (arXiv:2509.01494)
- Reducing false positives in static bug detection (few-shot vs CoT, hybrid static+LLM):
  - [Reducing False Positives in Static Bug Detection with LLMs: An Empirical Study in Industry](https://arxiv.org/html/2601.18844v1) (arXiv:2601.18844)
- Confirmation bias in LLM security code review:
  - [Measuring and Exploiting Confirmation Bias in LLM-Assisted Security Code Review](https://arxiv.org/html/2603.18740v1) (arXiv:2603.18740)
- Chain-of-Verification:
  - [Chain-of-Verification Reduces Hallucination in Large Language Models (arXiv:2309.11495)](https://arxiv.org/abs/2309.11495)
  - [ACL Anthology version](https://aclanthology.org/2024.findings-acl.212/)
- Confidence calibration:
  - [When Can We Trust LLM Graders? Calibrating Confidence for Automated Assessment](https://arxiv.org/html/2603.29559v1) (arXiv:2603.29559)
  - [Confidence Calibration in LLMs — overview](https://www.emergentmind.com/topics/confidence-calibration-in-llms)
  - [An Empirical Study of Security Calibration in Large Language Models for Code](https://arxiv.org/html/2606.31159v1) (arXiv:2606.31159)
- Uncertainty-aware abstention / selective prediction:
  - [Uncertainty-Aware Abstention in Large Language Models with Provable Alignment Guarantees](https://arxiv.org/pdf/2607.04430) (arXiv:2607.04430)
- Reflection / reflexion loops:
  - [MAR: Multi-Agent Reflexion Improves Reasoning Abilities in LLMs](https://arxiv.org/html/2512.20845) (arXiv:2512.20845)
  - [Evaluating LLM Self-Reflection Loops: The 3 Metrics That Matter (2026)](https://futureagi.com/blog/evaluating-llm-self-reflection-loops-2026/)
- Heterogeneous / cheap+strong ensembles:
  - [Towards Practical Defect-Focused Automated Code Review](https://arxiv.org/pdf/2505.17928) (arXiv:2505.17928)
  - [Ensemble Learning for Large Language Models in Text and Code Generation: A Survey](https://arxiv.org/html/2503.13505v3)
- Adversarial multi-agent / stage-gated pipelines (evaluated, then scoped out):
  - [Refute-or-Promote: An Adversarial Stage-Gated Multi-Agent Review Methodology for High-Precision LLM-Assisted Defect Discovery](https://arxiv.org/pdf/2604.19049) (arXiv:2604.19049)
  - [MultiVer: Zero-Shot Multi-Agent Vulnerability Detection](https://arxiv.org/pdf/2602.17875) (arXiv:2602.17875)
  - [The Six Sigma Agent: Achieving Enterprise-Grade Reliability in LLM Systems Through Consensus-Driven Decomposed Execution](https://arxiv.org/pdf/2601.22290) (arXiv:2601.22290)
- Citation/quote grounding for structured extraction:
  - [From Judgments to Issues: Structured Extraction of Legal Reasoning with Citation-Hallucination Control](https://arxiv.org/pdf/2607.03325) (arXiv:2607.03325)
- Competitor context (2026 commercial landscape, informs "trust/UX" framing, no new technique claimed):
  - [Best AI Code Review Tool 2026: CodeRabbit vs Greptile vs Qodo vs More](https://www.stork.ai/blog/best-ai-code-review-tools-2026)
  - [Best AI Code Review Tools 2026 Compared](https://levelop.dev/blog/best-ai-code-review-tools-2026-coderabbit-greptile-qodo-compared)
  - [Greptile vs CodeRabbit vs Qodo: AI Code Review 2026](https://particula.tech/blog/greptile-vs-coderabbit-vs-qodo-ai-code-review-2026)
