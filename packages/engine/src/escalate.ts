/**
 * Risk-based model escalation (task 6.5, design decision 4): diffs touching
 * auth / payment / billing / migration / crypto / secret paths get reviewed
 * by Sonnet instead of the default model. Pure path heuristic; overridable
 * via `EngineConfig.escalation: false`. Escalation never applies when the
 * monthly budget has already degraded the run to the free tier — a budget
 * breach outranks a risk bump.
 */

/** The escalation target, via AnthropicProvider with this model id. */
export const ESCALATION_MODEL = "claude-sonnet-5";

// `auth` must not match "author"; `migrat` covers migration/migrations/migrate;
// `crypt` covers crypto/encrypt/decrypt/scrypt; `secret` covers secrets.
const RISKY_PATH = /(auth(?!or)|payment|billing|migrat|crypt|secret)/i;

/** True when a single changed path looks security/money-critical. */
export function isRiskyPath(path: string): boolean {
  return RISKY_PATH.test(path);
}

/** True when any changed path in the diff is risky. */
export function shouldEscalate(paths: readonly string[]): boolean {
  return paths.some(isRiskyPath);
}

/**
 * The subset of changed paths that look risky. The same signal `shouldEscalate`
 * uses for model routing, exposed so the summary comment can disclose WHY a PR
 * is flagged risky (feature #9 risk verdict) instead of discarding it.
 */
export function riskyPaths(paths: readonly string[]): string[] {
  return paths.filter(isRiskyPath);
}

// ── Blast-radius + churn escalation (report item #19) ───────────────────────
//
// Two extra deterministic signals, OR-ed with the risky-path heuristic above so
// a change escalates to the stronger model when it is either widely depended on
// or historically bug-prone:
//   • blast radius — a changed file imported by many OTHER files (from the same
//     import-graph substrate as report item #8), so a subtle break ripples far;
//   • churn — a changed file whose recent git history shows revert/hotfix/
//     rollback commits, empirically the code most likely to regress.
// The signal DATA (an import scan / commit-history calls) is gathered by the
// caller (run.ts) and passed in; the aggregation here is pure and testable.

/** A changed file imported by at least this many OTHER files is high blast-radius. */
export const DEFAULT_BLAST_RADIUS_THRESHOLD = 5;

// `revert`/`reverts`/`reverted`, `hotfix`/`hot-fix`, `rollback`/`roll back`,
// `regression`, `emergency|urgent fix` — the standard churn vocabulary. Anchored
// on word boundaries so `covert`, `overtime`, etc. never match.
const CHURN_MARKER =
  /\b(?:reverts?|reverted|hot[-\s]?fix(?:e[ds])?|roll[-\s]?back(?:ed)?|rolled\s+back|regression|(?:emergency|urgent)\s+fix)\b/i;

/** True when a commit subject/body reads like a revert / hotfix / rollback. */
export function isChurnMessage(message: string): boolean {
  return typeof message === "string" && CHURN_MARKER.test(message);
}

/**
 * Changed paths whose importer count meets the blast-radius threshold, most
 * depended-on first. `importerCounts` maps a changed path to the number of
 * OTHER files importing it (see importgraph.countImporters). Pure.
 */
export function highBlastRadiusPaths(
  importerCounts: ReadonlyMap<string, number>,
  threshold: number = DEFAULT_BLAST_RADIUS_THRESHOLD,
): string[] {
  return [...importerCounts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([path]) => path);
}

/** Signals feeding the escalation decision. Only `paths` is always available. */
export interface EscalationInput {
  paths: readonly string[];
  /** changed path → count of OTHER files importing it (blast radius, opt-in). */
  importerCounts?: ReadonlyMap<string, number>;
  /** Override the blast-radius importer-count threshold. */
  blastRadiusThreshold?: number;
  /** changed paths whose recent history shows revert/hotfix churn (opt-in). */
  churnyPaths?: readonly string[];
}

/** The aggregated escalation decision, with the reasons disclosed. */
export interface EscalationDecision {
  escalate: boolean;
  riskyPaths: string[];
  highBlastRadiusPaths: string[];
  churnyPaths: string[];
  /** Human-readable phrases (one per firing signal) for the escalation notice. */
  reasons: string[];
}

/**
 * OR the risky-path, blast-radius, and churn signals into one escalation
 * decision. Pure: the caller gathers the (async) blast-radius / churn data and
 * passes it in, so this stays deterministic and fully offline-testable.
 */
export function computeEscalation(input: EscalationInput): EscalationDecision {
  const changed = new Set(input.paths);
  const risky = riskyPaths(input.paths);
  const blast = input.importerCounts
    ? highBlastRadiusPaths(input.importerCounts, input.blastRadiusThreshold)
    : [];
  // Only churn on paths actually changed in this diff.
  const churn = (input.churnyPaths ?? []).filter((p) => changed.has(p));

  const reasons: string[] = [];
  if (risky.length > 0) reasons.push(`risky paths (auth/payment/crypto/…): ${risky.join(", ")}`);
  if (blast.length > 0) {
    const threshold = input.blastRadiusThreshold ?? DEFAULT_BLAST_RADIUS_THRESHOLD;
    reasons.push(`high blast radius (≥${threshold} importers): ${blast.join(", ")}`);
  }
  if (churn.length > 0) reasons.push(`recent revert/hotfix churn: ${churn.join(", ")}`);

  return {
    escalate: risky.length > 0 || blast.length > 0 || churn.length > 0,
    riskyPaths: risky,
    highBlastRadiusPaths: blast,
    churnyPaths: churn,
    reasons,
  };
}
