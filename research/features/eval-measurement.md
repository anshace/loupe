# Research: Measuring & Continuously Improving Review Quality

**Date:** 2026-07-30
**Question:** beyond Loupe's small offline eval (`evals/run.mjs` + `evals/cases/*.mjs`), what free/local methods exist in 2026 to (a) benchmark against public data, (b) track precision/recall/FP-rate over time, (c) A/B-test and regression-test prompts, (d) learn from accepted/rejected/resolved human feedback, and (e) calibrate confidence?
**Constraint:** everything stays on Ansh's machine — no paid services, no data leaving the box except LLM-provider API calls Loupe already makes.

---

## 0. What Loupe's eval already does, and its real gap

`evals/run.mjs` runs the full `runReview` pipeline over ~22 hand-authored fixture cases in `evals/cases/*.mjs`, each supplying a **fixed, hard-coded `mockResponses` JSON string** that a `ReplayProvider` deterministically replays regardless of the actual prompt content. Matching against `expectedFindings` uses exact `file` + `lineRange` + a regex (`mustMatch`) over `title + body`.

This is a genuinely useful **pipeline regression test** (dedupe, anchoring, verifier wiring, escalation, truncation all get exercised deterministically in CI). But because the LLM's response is a canned string, **it cannot detect prompt regressions** — if `prompt.ts` changes in a way that makes a real model worse at finding SQL injection, this suite is 100% blind to it unless `REVIEW_MODEL` is pointed at a live provider, which "nothing in this repo triggers... automatically" (per the file's own comment). So today Loupe has zero *automated, over-time* signal on: whether the reviewer prompt still catches real bugs, whether verifier drop-reasons are sane, whether severity is calibrated, or whether real developers on Ansh's own repos actually agree with what gets posted.

Everything below is organized to close that gap while staying inside Loupe's existing shape (TypeScript, zero runtime deps in `packages/engine`, JSONL logs, per-repo config, multi-provider).

---

## A. Public benchmarks/datasets to test against

### A.1 Backtracked-fix-commit benchmarks (the 2026 state of the art for *this exact product category*)

The code-review-agent benchmarking field only became credible in the last ~18 months, and the dominant technique across every serious attempt (Greptile, Qodo, the independent `withmartian/code-review-benchmark`, and the academic `CR-Bench`) is **not** static vulnerability datasets — it's "take a real, already-fixed PR, and check whether the tool would have caught the bug when reviewing the pre-fix diff":

- **Qodo's real-world benchmark** (blog: "How we built a real-world benchmark for AI code review"): pulls merged PRs (3+ files, 50–15,000 lines changed, no subsequent revert/follow-up fix) across TypeScript/Python/JS/C/C#/Rust/Swift, extracts each repo's own best-practice rules, then uses an LLM to inject 1–3 functional bugs plus best-practice violations into the diff, double-verifies the injected ground truth by hand, and scores tools with an LLM-judge on precision (posted comment ↔ real injected issue) and recall (injected issue ↔ found), normalized **per 1K added LOC** so PR-size doesn't skew the number. 100 PRs / 580 issues across 8 repos in their published set.
- **`withmartian/code-review-benchmark`** (GitHub, MIT license, fully local/offline-runnable via `uv sync` + `uv run python -m code_review_benchmark.step1_download_prs`): an *offline* track with 50 human-verified-golden-comment PRs across 5 languages (Sentry/Grafana/Cal.com/Discourse/Keycloak) scored by an LLM-judge for precision/recall, and a separate *online* track that mines fresh real PRs where bots already commented and uses the developer's subsequent commit as ground truth (did the dev act on it?). Adding a new tool is "about an afternoon" of forking the 50 PRs and pointing your bot at them.
- **CR-Bench** (arXiv 2603.11078): builds on SWE-bench's real GitHub issue→fix-PR pairs, adds a Category/Impact/Severity taxonomy, evaluates review-comment *utility* rather than just "was a bug mentioned."
- Independent commentary (DeepSource's "every AI code review vendor benchmarks itself, and wins") is a useful caution: vendor-run benchmarks are not neutral; the injected-bug approach is also criticized because "there's no evidence synthetic bugs match the distribution or subtlety of real defects."

**What this means for Loupe:** the backtracked-fix-commit technique needs **no LLM-based bug injection at all** if you mine *real* bug-fixing commits instead — which is free, higher-fidelity than synthetic injection, and directly buildable with `git log` + the SZZ algorithm (see A.2). This is the highest-leverage benchmark technique for Loupe specifically because it's $0 and stays local.

### A.2 SZZ-style mining of real bug-fixing commits (grow the eval corpus from real history, for free)

The **SZZ algorithm** (Śliwerski/Zimmermann/Zeller, 2005; 200+ follow-on studies; reference open implementation `wogscpar/SZZUnleashed`, MIT) identifies **bug-introducing commits** from a repo's own history: find fix commits (via commit message keywords or linked issue trackers), diff the fix, then `git blame` the lines the fix touched to find which earlier commit introduced them.

Applied to Loupe: write a local script (`evals/mine-corpus.mjs` or similar) that, for any git repo you can clone locally (your own repos, or small popular OSS repos cloned once), (1) finds fix commits (`git log --grep`, conventional-commit `fix:` prefixes, or "Fixes #NNN"), (2) reconstructs the **pre-fix** state of the touched files as a synthetic single-file/small-diff "PR" (same shape as `newFileDiff`/`hunkDiff` in `evals/cases/_util.mjs`), (3) auto-derives the golden finding's file+line+category from the fix commit's own diff and message. This turns 22 hand-written cases into hundreds, drawn from **real bugs**, at zero marginal cost beyond disk space and CPU — directly extending the existing `evals/cases/*.mjs` format rather than replacing it.

### A.3 Vulnerability datasets, with caveats — DiverseVul / BigVul / CVEFixes / PrimeVul / SecVulEval

Since Loupe already treats security as a first-class category (TS-10 in the feature catalog), these are worth sampling from for the security lane specifically, but the 2026 literature is blunt about their noise:
- **DiverseVul** dedupes across prior corpora spanning 150 CWEs but its own authors report only ~60% label accuracy.
- **BigVul / CVEFixes** have up to 18.9% exact-duplicate contamination.
- **PrimeVul** (arXiv 2403.18624, "Vulnerability Detection with Code Language Models: How Far Are We?") specifically re-labeled and chronologically split to fix this — and the same paper shows *why this matters*: StarCoder2 scores 68.3% F1 on the noisy BigVul but only 3.1% F1 on PrimeVul, i.e., older benchmarks wildly overstate real detector quality.
- **SecVulEval** (arXiv 2505.19828, 2025) adds statement-level granularity + context, addressing PrimeVul's remaining function-level coarseness.

Recommendation: sample a small (e.g., 100–200), **deduplicated, PrimeVul-labeled** slice, convert to Loupe's diff-case format, and use it *only* to track the security-category recall/precision line over time — not as the primary corpus (mostly C/C++, single-function, not diff-shaped, so it needs adaptation and will never be as representative as A.2's real-repo mining).

### A.4 Review-comment-style datasets (Tufano / CodeReviewer) for recall against realistic review tone

The **CodeReviewer** dataset (Microsoft, multilingual, diff-grained, preserves inline context) and the older **Tufano** dataset (Java, function-grained) are the two standard corpora for review-*comment-generation* research. A recent quality audit (**DeepCRCEval**, arXiv 2412.18291) found CodeReviewer comments are 39% genuine defects/improvements (vs. 64% in Tufano) and 46–54% require out-of-hunk context to even understand — i.e., these datasets are noisier and more "real-world messy" than hand-curated benchmarks. Useful as a **calibration check on false-positive rate and comment realism**, not as ground truth to hit 100% recall against (a lot of "expected" comments in these sets are interrogative/discussion, not actionable bugs, which is explicitly *not* what Loupe wants to emit).

---

## B. Precision/recall/FP-rate tracking over time (local, no service)

Loupe already writes a per-run JSONL log (model, tokens, cost, findings kept/dropped, drop reasons) and has the eval harness producing found/missed/unexpected counts. Neither currently accumulates into a **trend**. The fix is small: append one line per eval run (and, if desired, per live run where later feedback exists — see D) to a local `evals/history.jsonl` with `{date, gitSha, promptVersion, model, precision, recall, fpRate, verifierDropRate}`, then a tiny local script renders it — either an ASCII sparkline in the terminal, or a static HTML file written to disk and opened directly in the browser (not published anywhere — this repo's rule is "no Artifacts, no cloud" for a shared-account, and Loupe's own CLAUDE.md says "everything stays local," so this must be a file you `open` locally, never uploaded). This is exactly the `LT-09` catalog item ("review analytics dashboard") but scoped down to a local file instead of a service, and it's the natural place to plot the A/B and calibration numbers from sections C–E together (e.g., a cost-vs-quality Pareto view across model choices, since token/cost accounting already exists).

---

## C. A/B prompt testing + regression testing of prompts

### C.1 Paired statistical testing, not raw counts

The 2026 "A/B testing LLM prompts" consensus (FutureAGI's playbook, PromptMetrics' CTO guide) is specific: run an **A/A test first** (same prompt twice — if you see a "significant" difference, your harness is broken, not the prompt); prefer **paired** comparisons (same case, two prompt versions) over independent groups, since paired tests have much more statistical power at small N; don't stop early ("peeking"); and treat <100 paired examples as below the resolution of a credible call for anything but catastrophic regressions (10–20 samples catch only catastrophic breaks; 50–100 for a ~5–10% effect; 200–500 for a ~1–3% effect). Loupe's eval corpus (22 cases today, hundreds after A.2) is realistically in the "catches catastrophic regressions, and once you extend it via A.2, catches moderate ones" band — worth knowing so results aren't over-trusted.

Concretely for Loupe: extend `evals/run.mjs` to accept two model/prompt configurations, run every case through both, and report **McNemar's test** on the paired found/missed outcome per case (a standard test for exactly this "same subjects, two conditions, binary outcome" shape — used in several recent LLM-judge-reliability papers) rather than just "35 found vs 33 found."

### C.2 Golden-dataset regression / drift detection (catch *unintended* changes, not just known ones)

Today's `expectedFindings` + `mustMatch` regex only checks the specific things you thought to assert — it says nothing about a prompt change that silently starts flagging 5 new things on a *clean* case, or subtly rephrases every finding. The standard 2026 pattern (Langfuse's "golden dataset evaluation," several LLM regression-testing writeups) is: **freeze a versioned golden dataset with full expected outputs (not just assertions)**, re-run the *whole* frozen suite on every prompt/model change, and **diff full output against the last committed snapshot** — a human reviews the diff (like a snapshot/golden-file test) before accepting it as the new baseline. This is complementary to the existing pass/fail cases: add a `--snapshot` mode to `evals/run.mjs` that writes each case's full finding-set JSON to `evals/snapshots/<case>.json`, and a CI/local check that fails (with a readable diff) if a case's output changed versus the committed snapshot, forcing a deliberate "yes, I intend this to change" commit.

### C.3 LLM-judge scoring to replace brittle regex matching at scale

Once the corpus grows via A.2 into the hundreds, hand-writing a `mustMatch` regex per case doesn't scale, and every public benchmark reviewed above (Qodo, `withmartian`, CR-Bench) solves exactly this the same way: **an LLM-as-judge decides "does this posted finding describe the same underlying issue as the golden one," given file/line/category, rather than a string match.** This is a natural extension of Loupe's own verifier machinery (same multi-provider `complete()` interface, run offline/batch, cheap on a free-tier model) — it doesn't need a new subsystem, just a new judge prompt and a scoring pass over eval output.

### C.4 Off-the-shelf option: promptfoo

**promptfoo** (MIT-licensed, CLI-first, YAML-driven; acquired by OpenAI in March 2026 but remains open-source/self-hostable) does most of C.1–C.3 out of the box: side-by-side prompt/model comparison, CI-friendly non-zero exit codes on regression, and it runs fully locally except for the actual provider calls Loupe already makes. Worth a look as a `devDependency`-only alternative to hand-rolling the harness above — it doesn't touch `packages/engine`'s zero-dep runtime, only the eval tooling. Flagging honestly: for a solo learning-first project, a ~150-line hand-rolled extension to the existing `evals/run.mjs` may be the better "simplest thing that works" call; promptfoo is the "if this eval harness starts eating real time, stop rebuilding it yourself" escape hatch.

### C.5 Shadow-mode comparison on real incoming PRs (pre-switch confidence)

Before flipping a repo from prompt/model version A to B, the 2026 LLMOps pattern ("shadow mode," used across several production write-ups) is to run **both** versions on the same real, live PR diff, but only ever **post** the currently-live version's comments — logging the shadow version's output to the JSONL run log for later offline diffing. This catches real-world drift (tone, new false-positive classes, cost/latency changes) that a static eval corpus can miss, without ever showing a repo double comments. For Loupe this must be **strictly opt-in and off by default**, since it doubles LLM calls against the existing per-run token cap / monthly budget — a `shadowModel` config field that only activates when explicitly set, never on by default.

---

## D. Learning from accepted/rejected/resolved feedback ("learned rules")

CodeRabbit's shipped version of this (`docs.coderabbit.ai/knowledge-base/learnings`) is the clearest reference: when a human replies to a bot comment agreeing/disagreeing/explaining a deliberate decision, that reply is folded into future reviews as a stored "learning," visible in a dashboard. Loupe's equivalent building blocks already exist (dedupe against existing bot comments, `.aireview.toml` ignore-globs, `HOUSE_RULES.md`) — what's missing is the **outcome-tracking loop** that would let those config surfaces update themselves from real usage instead of only by hand:

- **GitHub's own resolution signal**: the GraphQL `PullRequestReviewThread.isResolved` field (queryable per-thread, with `resolveReviewThread`/`unresolveReviewThread` mutations) tells you whether a human closed the conversation the bot started — a strong accept/no-longer-relevant signal Loupe isn't reading today.
- **Reactions as an under-used feedback channel**: an empirical GitHub study (ACM TOSEM, "An Empirical Study on GitHub Pull Requests' Reactions") found a majority of people who react to a PR comment leave **no accompanying text comment** — meaning 👍/🚀/❤️ (positive) vs 👎/😕 (negative) reactions on Loupe's own posted comments are a real, currently-untapped, zero-extra-API-call-shape signal (Loupe already fetches `existingComments` for dedupe; reactions are one more field on the same objects).
- **Concrete staged build:** (1) *(S, no new subsystem)* when the next review run reads `existingComments` for dedupe, also read reaction counts + thread `isResolved` for the bot's *own* prior comments, and log each as accepted/disputed/unresolved in the JSONL run log — pure observability, no behavior change. (2) *(L, follow-on)* aggregate that log across runs/repos to detect a rule/category repeatedly disputed on the same path, and **surface a suggested `.aireview.toml` ignore-glob or `HOUSE_RULES.md` line** for Ansh to accept by hand (never auto-applied — this is a suggestion queue, not autofix, keeping inside the no-autofix non-goal).

This is the concrete implementation path for the catalog's `LT-06` ("learned rules") item, sequenced so the cheap observability half ships long before the harder rule-mining half.

---

## E. Calibration metrics

"Calibration" for an LLM-judging pipeline means: when the system says "critical" or expresses confidence X, does that track real-world outcome frequency?

- **Metrics used across the 2026 literature**: Expected Calibration Error (ECE), Maximum Calibration Error (MCE), and **Brier score** (a strictly-proper scoring rule, no binning needed) are the standard trio; recent work (arXiv 2508.06225, "Overconfidence in LLM-as-a-Judge") finds LLM judges are routinely miscalibrated (ECE 0.108–0.427 depending on setup) — i.e., don't assume Loupe's verifier or severity labels are well-calibrated by default; measure it.
- **Cheap first step (no new fields needed):** treat severity as an ordinal confidence proxy and check **monotonicity** against the acceptance signal from D — critical/high findings should be resolved-and-accepted more often than low/nit ones; if they aren't, severity is miscalibrated and the rubric needs work. This needs zero pipeline changes, only the D.1 observability log.
- **Fuller step (M, after D exists):** add an explicit numeric self-reported confidence (0–1) to the verifier's keep/rewrite/drop decision (it already reasons over each finding with cited evidence — a confidence number is a one-field prompt addition), then score it against the D accept/reject outcomes with Brier score / ECE over time, tracked alongside precision/recall in the B dashboard.
- **Model-swap health check — Cohen's kappa (S, cheap):** whenever the underlying model or a prompt version changes, run the full eval corpus through old and new and compute **Cohen's kappa** (not raw agreement — corrects for chance agreement, standard in inter-rater-reliability literature per PMC3643869 and recent LLM-judge papers) on categorical outputs (kept/dropped, severity bucket). This is a distinct, much cheaper signal than precision/recall: it tells you *how much the model's judgment pattern shifted*, catching "quietly became a different reviewer" drift even when aggregate precision/recall look unchanged. Pure post-processing of two eval runs' JSON — no pipeline change.

---

## F. One item flagged but not recommended: DSPy-style automated prompt optimization

**DSPy** (compiles a measurable-quality-metric + ≥50 labeled examples into an automatically-tuned prompt via optimizers like MIPRO/OPRO; can run against a local model, no GPU required) is the leading 2026 "stop hand-tuning prompts" framework, and it's a legitimate answer to "continuously improve" once A.2's mined corpus is large enough (DSPy's own guidance: 50+ labeled examples minimum). Flagging honestly rather than dropping it silently: it's a **Python** framework, which is a second-language dependency in an otherwise all-TypeScript, zero-runtime-dep project, and it would only ever be **offline dev tooling** (mining better few-shot examples/phrasing to hand-copy into `prompts/reviewer-v3.md`), never a runtime dependency of `packages/engine` or the Action/Worker. Given the project's explicit "don't gold-plate" instruction, this is a plausible *later* experiment once A.2's corpus exists and C's harness shows where the prompt is actually weak — not a now-priority.

---

## Sources

- [How Qodo Built a Real-World Benchmark for AI Code Review](https://www.qodo.ai/blog/how-we-built-a-real-world-benchmark-for-ai-code-review/)
- [withmartian/code-review-benchmark (GitHub)](https://github.com/withmartian/code-review-benchmark)
- [CR-Bench: Evaluating the Real-World Utility of AI Code Review Agents (arXiv 2603.11078)](https://arxiv.org/pdf/2603.11078)
- [A Survey of Code Review Benchmarks and Evaluation Practices (arXiv 2602.13377)](https://arxiv.org/html/2602.13377v1)
- [Every AI code review vendor benchmarks itself, and wins — DeepSource](https://deepsource.com/blog/ai-code-review-benchmarks)
- [DeepCRCEval: Revisiting the Evaluation of Code Review Comment Generation (arXiv 2412.18291)](https://arxiv.org/html/2412.18291)
- [Vulnerability Detection with Code Language Models: How Far Are We? — PrimeVul (arXiv 2403.18624)](https://arxiv.org/pdf/2403.18624)
- [SecVulEval: Benchmarking LLMs for Real-World C/C++ Vulnerability Detection (arXiv 2505.19828)](https://arxiv.org/pdf/2505.19828)
- [SZZUnleashed: An Open Implementation of the SZZ Algorithm (GitHub / arXiv 1903.01742)](https://github.com/wogscpar/SZZUnleashed)
- [CodeRabbit Learnings docs](https://docs.coderabbit.ai/knowledge-base/learnings)
- [An Empirical Study on GitHub Pull Requests' Reactions (ACM TOSEM)](https://dl.acm.org/doi/full/10.1145/3597208)
- [GitHub Community: GraphQL resolved conversations / PullRequestReviewThread.isResolved](https://github.com/orgs/community/discussions/24854)
- [Golden dataset evaluation: build and maintain LLM test sets — Langfuse](https://langfuse.com/resources/engineering/golden-dataset-evaluation)
- [LLM Regression Testing — FutureAGI glossary](https://futureagi.com/glossary/llm-regression-testing/)
- [A/B Testing LLM Prompts: The Statistical Playbook (2026) — FutureAGI](https://futureagi.com/blog/ab-testing-llm-prompts-best-practices-2026/)
- [A/B Testing LLM Prompts: The CTO's Guide — PromptMetrics](https://www.promptmetrics.dev/blog/ab-testing-llm-prompts-cto-guide)
- [How to Roll Out New LLMs Safely Using Shadow Testing — CodeAnt](https://www.codeant.ai/blogs/llm-shadow-traffic-ab-testing)
- [Releasing AI Features Without Breaking Production: Shadow Mode, Canary, A/B (2026)](https://tianpan.co/blog/2026-04-09-llm-gradual-rollout-shadow-canary-ab-testing)
- [Overconfidence in LLM-as-a-Judge: Diagnosis and Confidence-Driven Solution (arXiv 2508.06225)](https://arxiv.org/pdf/2508.06225)
- [Calibrating LLM Judges: Linear Probes for Uncertainty Estimation (arXiv 2512.22245)](https://arxiv.org/html/2512.22245)
- [Calibration and Correctness of Language Models for Code (ICSE 2025)](https://www.software-lab.org/publications/icse2025_calibration.pdf)
- [A comparison of Cohen's Kappa and Gwet's AC1 for inter-rater reliability (PMC3643869)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3643869/)
- [Your LLM Evaluator Is Lying to You: Kappa Metrics for Prompt Calibration](https://medium.com/@Micheal-Lanham/your-llm-evaluator-is-lying-to-you-how-to-fix-it-with-prompt-calibration-and-kappa-metrics-29d4a7ae397c)
- [Promptfoo Review 2026: Free LLM Testing Framework](https://appsecsanta.com/promptfoo)
- [Testing LLM prompts like code: regression evals in CI/CD with promptfoo](https://medium.com/@alexrodriguesj/testing-llm-prompts-like-code-regression-evals-in-ci-cd-with-promptfoo-5242b4dcb9be)
- [DSPy Framework — Programmatic Prompt Optimization (2026)](https://myengineeringpath.dev/tools/dspy-guide/)
- [How to Implement Automatic Prompt Optimization with DSPy](https://reintech.io/blog/implement-automatic-prompt-optimization-dspy)
