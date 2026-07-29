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
}

/** A file excluded before review, with the reason, for summary disclosure. */
export interface SkippedFile {
  file: string;
  reason: "lockfile" | "generated" | "vendored" | "binary" | "ignored";
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
  /** Findings that could only be mentioned in the summary comment. */
  summaryFindings: Finding[];
  /** Config problems / degraded-mode / early-stop notices shown in the summary. */
  notices: string[];
  /** True when the token cap stopped model calls early. */
  earlyStop: boolean;
  /** The upserted summary comment body (with hidden marker + state). */
  summaryComment?: string;
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
