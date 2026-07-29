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

/** Engine configuration. Grows with milestones (.aireview.toml keys land at M2). */
export interface EngineConfig {
  /** Findings below this severity are never published. */
  minSeverity?: Severity;
  /** Diff size caps; see DEFAULT_SIZE_CAPS. */
  sizeCap?: SizeCapConfig;
  /** Override path to the reviewer prompt markdown file. */
  promptPath?: string;
  /** When true, the review payload is built but never posted to GitHub. */
  dryRun?: boolean;
}

/** A file excluded before review, with the reason, for summary disclosure. */
export interface SkippedFile {
  file: string;
  reason: "lockfile" | "generated" | "vendored" | "binary";
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
  /** Body for the single summary (the review body). */
  summary: string;
  /** Noise files excluded before the model call. */
  skippedFiles: SkippedFile[];
  /** Size-cap exclusions disclosed in the summary. */
  exclusions: Exclusion[];
  /** True when model output was fully unparseable → summary-only run. */
  degraded: boolean;
  /** The exact payload submitted (or that would be submitted on dryRun). */
  payload: ReviewPayload;
  /** Whether the review was actually posted (false on dryRun). */
  posted: boolean;
  /** Real token counts from the provider, when a model call was made. */
  usage?: { model: string; inputTokens: number; outputTokens: number };
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
