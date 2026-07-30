/** Core engine types, shared across modules. */

export type Severity = "critical" | "high" | "medium" | "low" | "nit";

export interface Finding {
  severity: Severity;
  category: string;
  file: string;
  /** New-side diff line; absent means a file-level finding. */
  line?: number;
  title: string;
  body: string;
  /** Free-text prose fix. Rendered as "Suggested fix:" markdown. */
  suggestion?: string;
  /**
   * A committable single-line replacement (feature #7): the EXACT new text for
   * the one line at `line`, emitted by the reviewer ONLY when the fix is a
   * clean same-line swap. When the finding anchors to an EXACT commentable line
   * (not a clamped/nearest one), publish.ts renders this as a GitHub
   * ```suggestion block so the human gets a one-click "Commit suggestion"
   * button; otherwise it falls back to the prose `suggestion`. Preserves the
   * line's own leading indentation; always a single line.
   */
  suggestedLine?: string;
  /**
   * The FIRST line of a contiguous multi-line committable replacement (feature
   * #18): `line` is the LAST line of the range. Emitted by the reviewer ONLY
   * together with `suggestedRange` when the fix cleanly swaps the whole block
   * `[startLine..line]`. publish.ts renders a GitHub range ```suggestion block
   * (start_line/start_side + line/side) ONLY when every line in that inclusive
   * range is an EXACT commentable RIGHT-side line; otherwise it falls back to
   * the single-line `suggestedLine` or the prose `suggestion`. Must be strictly
   * less than `line` (a real ≥2-line range).
   */
  startLine?: number;
  /**
   * The EXACT replacement text for the whole `[startLine..line]` range (feature
   * #18): one or more lines, each keeping its own leading indentation (GitHub
   * replaces the entire anchored range). Distinct from the single-line
   * `suggestedLine`; used only when a validated contiguous range exists.
   */
  suggestedRange?: string;
}

/** Which PR to review, independent of how the run was triggered. */
export interface PrIdentity {
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * The PR's stated intent (feature #3): title, body, and the issue numbers its
 * body closes (GitHub closing-keyword regex, e.g. "fixes #12"). Fetched with
 * one REST call and injected as the {{PR_INTENT}} reviewer prompt block so the
 * model can judge whether the diff does what the author says — and flag
 * described-but-unimplemented / unrelated out-of-scope changes. Fail-soft:
 * absent when the PR has no body or the fetch failed → the block is omitted.
 */
export interface PrIntent {
  title?: string;
  body?: string;
  /** Issue numbers referenced by closing keywords in the PR body. */
  linkedIssues: number[];
}

/** An installation or workflow token; the engine never mints or stores one. */
export type AuthToken = string;

/** Caps on how much diff is sent to the model. All optional; defaults apply. */
export interface SizeCapConfig {
  maxTotalChars?: number;
  maxTotalLines?: number;
  maxFileChars?: number;
  maxFileLines?: number;
}

/** Per-run token caps (real provider token counts, never estimates). */
export interface TokenCapConfig {
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

/** Hard caps on the agentic tool loop (task 6.3). All optional; defaults apply. */
export interface AgenticCaps {
  /** Max tool-execution rounds per run. */
  maxHops?: number;
  /** Max file contents fetched per run (read_file + grep reads combined). */
  maxFileReads?: number;
  /** Max total bytes of file content fetched per run. */
  maxTotalBytes?: number;
}

/** Live counters for the agentic tool loop, shared across reviewer + verifier. */
export interface AgenticUsage {
  hops: number;
  fileReads: number;
  bytesRead: number;
  /** True once any cap was hit — further tool calls are refused. */
  cappedOut: boolean;
}

/**
 * Closed drop-reason enum for the verifier pass (design decision 9).
 * `insufficient-context` is the abstention value (feature #6): the verifier
 * noticed a claim it genuinely could not ground in the supplied diff/context —
 * logged DISTINCTLY from "no issue found", never a confident false-positive drop.
 */
export type DropReason =
  | "false-claim"
  | "pre-existing"
  | "repo-convention"
  | "out-of-scope"
  | "theoretically-impossible"
  | "insufficient-context";

/** A finding the verifier dropped — always with a reason and cited evidence. */
export interface DroppedFinding {
  finding: Finding;
  reason: DropReason;
  evidence: string;
}

/** The three verifier verdict kinds (mirrors verify.ts `VerifierVerdict`). */
export type VerifierVerdictKind = "keep" | "rewrite" | "drop";

/**
 * A verifier verdict whose cited evidence failed the deterministic grounding
 * check (feature #1): the finding is NOT silently dropped — it is kept (fail
 * open) and flagged here so the summary/run log can disclose that the
 * verifier's rubber stamp was not trustworthy for this finding.
 */
export interface UngroundedVerdict {
  finding: Finding;
  verdict: VerifierVerdictKind;
  /** Why grounding failed: the verdict carried no evidence, or the quote was not in the payload. */
  reason: "missing-evidence" | "quote-not-found";
}

/** Outcome of the verifier pass, recorded on the run result. */
export interface VerificationRecord {
  /** True when the verifier output was unparseable → failed OPEN (originals published). */
  degraded: boolean;
  keptCount: number;
  rewrittenCount: number;
  dropped: DroppedFinding[];
  /** Verdicts whose evidence could not be grounded (feature #1) — kept, but flagged. */
  ungrounded: UngroundedVerdict[];
  /**
   * Self-reported verifier confidences (report item #30) for KEPT findings that
   * supplied one, in kept order. Captured for offline calibration scoring
   * (Brier/ECE) against real accept/reject outcomes; never acted on at run time.
   */
  confidences: number[];
  /**
   * Bounded reflection outcome (report item #27): critical/high `keep` verdicts
   * whose cited evidence a second, differently-framed critique pass judged does
   * NOT establish the claim. Such findings are DEMOTED one severity (never
   * dropped) and disclosed here. Present only when the `reflection` flag ran.
   */
  reflection?: ReflectionRecord;
}

/** One finding demoted by the bounded reflection pass (report item #27). */
export interface ReflectionDemotion {
  finding: Finding;
  from: Severity;
  to: Severity;
  /** The meta-reviewer's short reason the evidence did not establish the claim. */
  note?: string;
}

/** Outcome of the bounded reflection pass (report item #27). */
export interface ReflectionRecord {
  /** Critical/high `keep` findings the reflection pass reviewed. */
  reviewed: number;
  /** Findings demoted one severity because the evidence did not establish the claim. */
  demotions: ReflectionDemotion[];
  /** True when the reflection pass was skipped for cost (cap reached). */
  skippedForCost: boolean;
}

/** Engine configuration. Grows with milestones (.aireview.toml keys land at M2). */
export interface EngineConfig {
  /**
   * LLM API PROTOCOL: "openai" = any OpenAI-compatible /chat/completions
   * endpoint, "anthropic" = any Anthropic /v1/messages endpoint, "gemini" =
   * Google AI Studio. When set, drives provider construction via buildProvider;
   * when absent, the REVIEW_MODEL shortcut (resolveProviderChoice) is used.
   */
  provider?: "openai" | "anthropic" | "gemini";
  /** Model id for the selected provider. Required (no default) for provider "openai". */
  model?: string;
  /** Base URL or preset keyword for "openai"; endpoint override for anthropic/gemini. */
  baseUrl?: string;
  /** Explicit API key; otherwise resolved from env (LLM_API_KEY → provider-specific). */
  apiKey?: string;
  /**
   * Stronger model for risk escalation: rebuilds the SAME provider/baseUrl/apiKey
   * with this model. When unset, only the anthropic protocol (or the haiku
   * shortcut) escalates, to its Sonnet default; other endpoints don't escalate.
   */
  escalationModel?: string;
  /** Findings below this severity are never published (overrides .aireview.toml). */
  minSeverity?: Severity;
  /** Path to the repo config file, read at the PR head. Default ".aireview.toml". */
  configPath?: string;
  /** Diff size caps; see DEFAULT_SIZE_CAPS. */
  sizeCap?: SizeCapConfig;
  /** Override path to the reviewer prompt markdown file. */
  promptPath?: string;
  /** When true, the review payload is built but never posted to GitHub. */
  dryRun?: boolean;
  /** The bot's own login, used to skip self-generated events and find its comments. */
  botIdentity?: string;
  /** Event-shaped inputs for the run gate (draft/actor/SHA/on-demand). */
  event?: RunEvent;
  /** Per-run token caps; see DEFAULT_TOKEN_CAPS. */
  tokenCaps?: TokenCapConfig;
  /** Path to the flat-JSON monthly spend ledger. Absent → per-run caps only. */
  ledgerPath?: string;
  /**
   * Give the reviewer/verifier capped grep + read-file tool access (task 6.3).
   * Default OFF.
   */
  agentic?: boolean;
  /** Overrides for the agentic hard caps; see DEFAULT_AGENTIC_CAPS. */
  agenticCaps?: AgenticCaps;
  /**
   * TS language-service symbol tools (report item #33): expose real
   * find_definition / find_references / hover queries — backed by an in-memory
   * `ts.LanguageService` over the PR-head files — as agentic tools the reviewer
   * can call. Requires the `typescript`-backed service injected via
   * `deps.symbolService` (packages/ts-symbols) AND `agentic` on (the tools are
   * executed by the agentic loop). Default OFF, opt-in — the engine stays
   * zero-dep; the service is only present on the Action path where `typescript`
   * and a filesystem are available. Absent service → the tools are simply not
   * offered (clean no-op).
   */
  tsSymbols?: boolean;
  /**
   * TS semantic diagnostics as findings (report item #33): a `tsc --noEmit`-
   * style pass over the PR-head files whose compiler-verified errors — filtered
   * to the PR's ADDED lines and stripped of no-node_modules artifacts — become
   * deterministic, zero-hallucination findings (category `type-error`). Requires
   * `deps.symbolService`; independent of `agentic`. Default OFF — it needs the
   * injected `typescript` service and, like the tools, is only meaningful on the
   * Action path; pending live-eval measurement of its precision on real PRs.
   */
  tsDiagnostics?: boolean;
  /**
   * Run the verifier pass (task 6.4). Default OFF — stays off until the eval
   * set proves it kills ≥30% of raw findings correctly (task 6.8).
   */
  verify?: boolean;
  /**
   * Risk-based model escalation (task 6.5): risky changed paths route the
   * review to Sonnet. Default ON; ignored when a model is injected via deps.
   */
  escalation?: boolean;
  /** Cap on total enclosing-scope context characters; see DEFAULT_CONTEXT_CAP_CHARS. */
  contextCapChars?: number;
  /** Path to the flat-JSONL run log (task 7.5). Absent → no run log written. */
  runLogPath?: string;
  /**
   * Inject retrieved supplementary context via `deps.retriever` (task 7.6).
   * Default OFF — this is the M5 RAG experiment, not core architecture.
   */
  rag?: boolean;
  /**
   * Fetch the PR's title/body + linked issues and inject them as the
   * {{PR_INTENT}} reviewer block (feature #3). Default ON; fail-soft — a PR
   * with no body simply omits the block.
   */
  prIntent?: boolean;
  /**
   * Cross-file recall (report item #8): deterministically detect exported
   * signature changes and FORCE-inject their call sites from other files into
   * the reviewer prompt ({{CROSS_FILE_CALLERS}}). Default OFF — it runs a
   * whole-repo import scan (many read calls), so it stays opt-in until the eval
   * set proves its recall win, mirroring the verifier/agentic defaults.
   */
  crossFileCallers?: boolean;
  /** Overrides for the cross-file import-scan budget; see DEFAULT_IMPORT_SCAN_CAPS. */
  crossFileCaps?: AgenticCaps;
  /**
   * Chain-of-verification (report item #13): the verifier states + answers 1–2
   * falsifiable questions (within its capped grep/read budget) before each
   * verdict, using the verifier-v3 prompt. Default OFF — an uncertain precision
   * lever pending live-eval measurement (task 6.8-style); only takes effect when
   * `verify` is also on.
   */
  chainOfVerification?: boolean;
  /**
   * Bounded reflection — "verifier-of-verifier" (report item #27): after the
   * verifier pass, one extra critique pass over ONLY critical/high `keep`
   * verdicts, asking whether the cited evidence actually establishes the claim.
   * A failing finding is DEMOTED one severity (never silently dropped) and
   * disclosed. Uses the verifier-meta prompt. Bounded to the per-run cost cap
   * (skipped with a notice if exceeded). Only takes effect when `verify` is also
   * on. Default OFF — an uncertain precision lever pending live-eval measurement
   * (task 6.8-style).
   */
  reflection?: boolean;
  /**
   * JSON field-ordering experiment (report item #28): a reviewer prompt variant
   * (reviewer-v12) that forces the grounding fields (`quote` + `why`) BEFORE the
   * verdict/severity fields, as a lightweight forcing function to ground before
   * committing to a severity. Default OFF — the research flags this as an
   * UNCERTAIN win (explicit-CoT sometimes underperforms a bare prompt for this
   * task class), so it is validate-first: measure on the eval harness before
   * defaulting on. Mutually exclusive with the flagged reviewer variant
   * (few-shot/walkthrough/sink) — it is a clean-schema experiment.
   */
  groundingFirst?: boolean;
  /**
   * Empirical calibration from run-log history (report item #29): mine the
   * run-log JSONL into a per-(category, severity) verifier keep-rate table and
   * pre-suppress finding shapes with a persistently low keep-rate BEFORE the
   * verifier. Pre-suppressed findings are recorded (reason `low-keep-rate`),
   * never silently dropped. Default OFF — an uncertain precision lever that also
   * needs enough dogfooded history to be meaningful; pending live-eval
   * measurement (task 6.8-style).
   */
  empiricalCalibration?: boolean;
  /**
   * Path to the run-log JSONL mined for the empirical calibration table (report
   * item #29). Absent → falls back to `runLogPath`. Read-only; fail-soft.
   */
  calibrationHistoryPath?: string;
  /** Keep-rate at/under which a shape is pre-suppressed (report item #29). Default 0.2. */
  calibrationKeepRateThreshold?: number;
  /** Minimum historical samples of a shape before its keep-rate is trusted (report item #29). Default 5. */
  calibrationMinSamples?: number;
  /**
   * Few-shot exemplars (report item #14): inject 2–4 curated true/false-positive
   * examples into the reviewer prompt (reviewer-v8). Default OFF — unproven and
   * costs tokens; pending live-eval measurement (task 6.8-style).
   */
  fewShotExemplars?: boolean;
  /**
   * Self-consistency voting (report item #15): re-run the reviewer 1–2× at
   * temperature > 0 on critical/high findings; a high-stakes finding not
   * reproduced by a majority of samples is DEMOTED one severity (never silently
   * dropped). Bounded to the per-run cost cap. Default OFF — an uncertain
   * precision lever pending live-eval measurement (task 6.8-style).
   */
  selfConsistency?: boolean;
  /**
   * Walkthrough narrative (report item #26): the reviewer emits an optional
   * sibling `walkthrough`/`effort` field on its JSON, rendered in the summary.
   * Fails open (absent field → nothing). Default OFF — a trust/UX polish lever
   * pending live-eval measurement (task 6.8-style).
   */
  walkthrough?: boolean;
  /**
   * Related-tests context (report item #17): discover each changed source
   * file's sibling test(s) via the repo tree and inject a {{RELATED_TESTS}}
   * reviewer block, enabling a FACTUAL coverage-gap observation. Default ON —
   * deterministic and "(none)"-safe (no matches → no prompt noise); one cached
   * tree listing + a few bounded test reads. Fail-soft.
   */
  relatedTests?: boolean;
  /**
   * Git blame / history context (report item #20): fetch a per-file blame
   * summary of how old / how churny each changed region is and inject it as the
   * {{CODE_HISTORY}} reviewer block + verifier ground truth (evidence for the
   * `pre-existing` drop reason). Default OFF — it costs one GraphQL call per
   * changed file, so (like crossFileCallers/rag) it stays opt-in until the eval
   * set measures the precision win. Fail-soft; determinism via `deps.now`.
   */
  historyContext?: boolean;
  /**
   * Ranked repo-map priming (rounding-out item; research context-retrieval.md
   * §10): inject a concise {{REPO_MAP}} reviewer block — top directories by file
   * count + the key exported symbols declared in the changed files — as ambient
   * structural orientation. Selects the flagged reviewer variant (v13). Default
   * OFF — it lists the repo tree (one cached call) and is an uncertain-value
   * ambient-priming lever (the model can already grep/read on demand), pending
   * live-eval measurement. Fail-soft; "(none)"-safe. Capped by `repoMapMaxChars`.
   */
  repoMap?: boolean;
  /** Char cap on the rendered {{REPO_MAP}} block; see DEFAULT_REPO_MAP_MAX_CHARS. */
  repoMapMaxChars?: number;
  /**
   * ctags-lite symbol index (rounding-out item; research context-retrieval.md
   * §7): a lightweight regex/heuristic definition index (TS/JS/Python) built once
   * from the RepoReader, injected as the {{SYMBOL_INDEX}} reviewer block — for the
   * symbols this PR touches, where each is DECLARED across the repo. A cheap,
   * zero-dep ALTERNATIVE context source to the `typescript`-backed symbol service
   * (`tsSymbols`). Selects the flagged reviewer variant (v13). Default OFF — it
   * runs a whole-repo scan (many reads), so it stays opt-in like
   * crossFileCallers/historyContext; pending live-eval measurement. Fail-soft.
   */
  ctagsIndex?: boolean;
  /** Overrides for the ctags-lite whole-repo scan budget; see DEFAULT_CTAGS_CAPS. */
  ctagsCaps?: AgenticCaps;
  /**
   * Local path to the repo's EXISTING CI/lint/type-checker output — SARIF,
   * ESLint JSON, or raw `tsc` text (report item #16). When set, the engine
   * parses it, filters to the touched files, and injects it as CITED,
   * deterministic ground truth for the verifier to cross-reference. Set by the
   * TRUSTED operator/Action, NEVER from the attacker-controllable .aireview.toml.
   * Consumed only by the verifier, so it is ingested only when `verify` is on.
   * Absent → skipped (fail-soft); read via `deps.ciIo`.
   */
  ciOutputPath?: string;
  /** CI output format; "auto" (default) sniffs SARIF / ESLint-JSON / tsc text. */
  ciOutputFormat?: "sarif" | "eslint" | "tsc" | "auto";
  /**
   * Blast-radius + churn model escalation (report item #19): OR two extra
   * deterministic signals into the escalation decision — a changed file imported
   * by many OTHER files (import-graph blast radius) OR a changed file with recent
   * revert/hotfix churn in its git history. Default OFF: although the signals are
   * deterministic, gathering them costs a whole-repo import scan plus one
   * commit-history call per changed file, so (free-tier-first) it stays opt-in —
   * like `crossFileCallers`/`historyContext`. The risky-PATH escalation signal
   * (`escalation`) remains default ON regardless.
   */
  blastRadiusEscalation?: boolean;
  /** Importer-count threshold for the blast-radius signal; see DEFAULT_BLAST_RADIUS_THRESHOLD. */
  blastRadiusThreshold?: number;
  /**
   * Deterministic dependency review (report item #22): flag NEW dependencies
   * added to a package.json manifest as a heads-up and, from the lockfile,
   * new deps declaring an INSTALL SCRIPT (arbitrary code on `npm install`).
   * Zero network. Default ON — deterministic, scoped to manifest/lockfile diffs,
   * and low-noise (skips runs with no dependency changes).
   */
  dependencyReview?: boolean;
  /**
   * Optional network dependency audit (report item #22): OSV.dev `querybatch`
   * for known CVEs on the new deps + npm-registry license lookup (copyleft
   * heads-up). Default OFF — it makes network calls, so it stays opt-in; only
   * takes effect when `dependencyReview` produced new deps to audit.
   */
  dependencyAudit?: boolean;
  /**
   * Dangerous-sink rule pack + taint prompting (report item #21): a hand-rolled
   * per-language pattern pack (eval/exec, innerHTML, raw SQL concat,
   * child_process, ReDoS, Python shell=True, …) whose matches are injected into
   * the reviewer prompt as PRE-FLAGGED evidence the model must reason about —
   * requiring source→sink reachability before a high/critical. Selects
   * reviewer-v11. Default OFF — an uncertain precision lever pending live-eval
   * measurement (task 6.8-style).
   */
  sinkPack?: boolean;
  /**
   * Prompt-injection self-defense (report item #23): strip zero-width/bidi
   * Unicode and neutralize injection-marker phrases in the attacker-reachable
   * text templated into prompts (the diff, HOUSE_RULES.md, .aireview.toml custom
   * rules, PR intent), surfacing a notice. Default ON — deterministic and it
   * protects Loupe itself; set false only to disable for debugging.
   */
  injectionDefense?: boolean;
  /**
   * Feedback-observability capture (report item #12): when reading Loupe's own
   * prior comments (the dedupe fetch), ALSO read reaction counts (👍/👎/👀 —
   * free, already in the REST payload) and each comment's review-thread
   * resolution state (one extra GraphQL call), classify accepted/disputed/
   * unresolved, and record it to the run log. PURE OBSERVABILITY — never changes
   * what is posted; fail-soft. Requires `botIdentity` (only Loupe's OWN comments
   * are classified). Default OFF — it costs one GraphQL call per run (free-tier-
   * first, like historyContext/crossFileCallers). Feeds the learned-rule
   * suggestion queue (report item #31).
   */
  feedbackCapture?: boolean;
  /**
   * Learned-rule suggestion queue (report item #31): when set, after the run the
   * engine mines the run-log feedback (report item #12) across runs and writes
   * SUGGESTED `.aireview.toml` ignore globs / `HOUSE_RULES.md` suppress lines to
   * this LOCAL path. NEVER auto-applied — a human hand-copies the ones they
   * agree with. Absent → not generated. Requires `runLogPath` (the source log).
   */
  suggestionsPath?: string;
  /** Distinct disputed/ignored findings before a rule is suggested (report item #31). Default 2. */
  suggestionMinSupport?: number;
}

/** A file excluded before review, with the reason, for summary disclosure. */
export interface SkippedFile {
  file: string;
  reason: "lockfile" | "generated" | "vendored" | "binary" | "ignored" | "already-reviewed";
}

/** Why a finding was suppressed before publishing (explicit — never silent). */
export type SuppressReason =
  | "style-nit"
  | "speculative"
  | "praise"
  | "todo-suggestion"
  | "unchanged-code"
  | "house-rule"
  | "below-min-severity"
  | "ignored-file"
  /**
   * Empirical calibration pre-suppression (report item #29): a finding whose
   * (category, severity) shape has a persistently low historical verifier
   * keep-rate in the run-log history. Removed BEFORE the verifier as a cheap
   * zero-inference prior; recorded here, never silently dropped. Flag-gated
   * (`empiricalCalibration`), default off, pending live-eval measurement.
   */
  | "low-keep-rate";

export interface SuppressedFinding {
  finding: Finding;
  reason: SuppressReason;
}

/** Event-shaped inputs for the run gate, supplied by the trigger adapter. */
export interface RunEvent {
  isDraft?: boolean;
  /** Login of the user/app that caused the event. */
  actor?: string;
  /** PR head commit SHA at event time. */
  headSha?: string;
  /** Explicit on-demand request (e.g. /review) — overrides the same-SHA skip. */
  onDemand?: boolean;
  /**
   * Previous head SHA on a `synchronize` event — the compare base for
   * incremental re-review scoping (task 7.2). Absent on opened/reopened.
   */
  before?: string;
}

/** A size-cap exclusion record — truncation is never silent. */
export interface Exclusion {
  file: string;
  whatWasExcluded: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  /**
   * Multi-line committable range (feature #18): the FIRST line of a contiguous
   * RIGHT-side range whose LAST line is `line`. Present ONLY when the whole
   * inclusive range was validated as exact commentable lines, so GitHub renders
   * the ```suggestion as a range replacement. Absent → an ordinary single-line
   * comment. Always paired with `startSide` and always strictly less than `line`.
   */
  startLine?: number;
  startSide?: "RIGHT";
  body: string;
}

/** The single batched review submitted per run (POST /pulls/{n}/reviews). */
export interface ReviewPayload {
  body: string;
  event: "COMMENT";
  comments: ReviewComment[];
}

export interface ReviewResult {
  findings: Finding[];
  /** Body of the single batched review. */
  summary: string;
  /** Noise/ignored files excluded before the model call. */
  skippedFiles: SkippedFile[];
  /** Size-cap exclusions disclosed in the summary. */
  exclusions: Exclusion[];
  /** True when model output was fully unparseable → summary-only run. */
  degraded: boolean;
  /** The exact payload submitted (or that would be submitted on dryRun). */
  payload: ReviewPayload;
  /** Whether the review was actually posted (false on dryRun or a gated skip). */
  posted: boolean;
  /** Real token counts from the provider, when a model call was made. */
  usage?: { model: string; inputTokens: number; outputTokens: number };
  /** Set when the run gate (or repo config) stopped the run before any model call. */
  skipped?: { reason: string };
  /** Findings dropped by the do-not-report / house-rule / severity filters. */
  suppressed: SuppressedFinding[];
  /** Findings skipped because an identical bot comment already exists. */
  deduped: Finding[];
  /**
   * Previously reported findings still open after this run (carry-forward
   * from state ∪ deduped re-emissions, task 7.3). Summary-only, never inline.
   */
  stillOpen: Finding[];
  /** Present when the run reviewed an incremental before..after range (7.2). */
  incremental?: { base: string; skippedHunks: number };
  /** Findings that could only be mentioned in the summary comment. */
  summaryFindings: Finding[];
  /** Config problems / degraded-mode / early-stop notices shown in the summary. */
  notices: string[];
  /** True when the token cap stopped model calls early. */
  earlyStop: boolean;
  /** The upserted summary comment body (with hidden marker + state). */
  summaryComment?: string;
  /** Verifier outcome, present only when the verifier pass produced a result. */
  verification?: VerificationRecord;
  /** Agentic tool-loop counters, present only when agentic mode was on. */
  agenticUsage?: AgenticUsage;
  /**
   * Reviewer-authored walkthrough narrative (report item #26), present only when
   * the `walkthrough` flag is on and the model emitted a non-empty field.
   */
  walkthrough?: string;
  /**
   * Feedback observability (report item #12): how the developer reacted to
   * Loupe's OWN prior comments on this PR, classified accepted/disputed/
   * unresolved. Present only when `feedbackCapture` is on. Pure observability.
   */
  feedback?: import("./feedback").FeedbackReport;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  nit: 0,
};

/** True when `a` is at least as severe as `b`. */
export function atLeastSeverity(a: Severity, b: Severity): boolean {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b];
}

/** Numeric rank of a severity (critical highest). Exposed for ordering. */
export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

/**
 * Comparator: most-severe first (critical → nit). Stable when fed to
 * Array.prototype.sort (ES2019+), so equal-severity findings keep their
 * original relative order — used for severity-first comment/table ordering
 * (feature #9d).
 */
export function bySeverityDesc(a: { severity: Severity }, b: { severity: Severity }): number {
  return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
}
