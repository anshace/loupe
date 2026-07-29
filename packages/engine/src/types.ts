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
  suggestion?: string;
}

/** Which PR to review, independent of how the run was triggered. */
export interface PrIdentity {
  owner: string;
  repo: string;
  prNumber: number;
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

/** Closed drop-reason enum for the verifier pass (design decision 9). */
export type DropReason =
  | "false-claim"
  | "pre-existing"
  | "repo-convention"
  | "out-of-scope"
  | "theoretically-impossible";

/** A finding the verifier dropped — always with a reason and cited evidence. */
export interface DroppedFinding {
  finding: Finding;
  reason: DropReason;
  evidence: string;
}

/** Outcome of the verifier pass, recorded on the run result. */
export interface VerificationRecord {
  /** True when the verifier output was unparseable → failed OPEN (originals published). */
  degraded: boolean;
  keptCount: number;
  rewrittenCount: number;
  dropped: DroppedFinding[];
}

/** Engine configuration. Grows with milestones (.aireview.toml keys land at M2). */
export interface EngineConfig {
  /** Findings below this severity are never published (overrides .aireview.toml). */
  minSeverity?: Severity;
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
  | "ignored-file";

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
