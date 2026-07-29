/**
 * Code-side suppression filter (tasks 4.1, 4.7, 4.9). Pure.
 *
 * Drops findings matching the do-not-report list before publishing:
 *   - pure style/formatting nits
 *   - speculative "might in the future" concerns
 *   - issues on unchanged (context) lines below high severity
 *   - TODO-comment suggestions
 *   - praise
 * plus findings below the configured minimum severity, and findings matching
 * a house-rule suppression.
 *
 * HOUSE RULES: suppression by "contradicts a house rule" cannot be detected
 * deterministically in code — that judgment is prompt-level (reviewer-v2.md
 * instructs the model not to report anything an explicit house rule permits;
 * a verifier-stage hook lands at M4). What IS deterministic and testable is
 * the `suppress: <substring>` convention: any HOUSE_RULES.md line of the form
 * `suppress: <text>` is applied as a case-insensitive substring filter against
 * finding titles/bodies. Documented in docs/house-rules-suppression.md.
 *
 * Nothing is silently dropped: every suppressed finding is returned with an
 * explicit reason for the run's suppression record.
 */
import type { Finding, SuppressReason, SuppressedFinding } from "./types";
import { atLeastSeverity } from "./types";

export interface SuppressOptions {
  /** Findings below this severity never appear inline or in the summary. */
  minSeverity?: Finding["severity"];
  /** Raw HOUSE_RULES.md content; absent → no house-rule suppression. */
  houseRules?: string;
  /**
   * Per-file added (new, non-context) line numbers. When provided, findings
   * anchored on unchanged lines below high severity are suppressed.
   */
  addedLines?: Record<string, readonly number[]>;
}

export interface SuppressResult {
  kept: Finding[];
  suppressed: SuppressedFinding[];
}

/** Extract `suppress: <substring>` filters from HOUSE_RULES.md content. */
export function parseHouseRuleSuppressions(houseRules: string): string[] {
  const out: string[] = [];
  for (const line of houseRules.split(/\r?\n/)) {
    const match = /^\s*(?:[-*]\s*)?suppress:\s*(.+?)\s*$/i.exec(line);
    if (match && match[1].length > 0) out.push(match[1]);
  }
  return out;
}

const STYLE_CATEGORY = /^(style|styling|format|formatting|lint|linting|whitespace|naming)$/i;
const SPECULATIVE =
  /\b(in the future|future-proof|might (?:later|eventually|one day|in the future)|could (?:later|eventually|one day)|speculative|hypothetical(?:ly)?|down the (?:road|line))\b/i;
const PRAISE_TITLE = /^(good|great|nice|well done|excellent|kudos|looks good)\b/i;
const TODO_SUGGESTION = /\badd(?:ing)? (?:a )?todo\b/i;

function classifyDoNotReport(finding: Finding): SuppressReason | undefined {
  if (STYLE_CATEGORY.test(finding.category)) return "style-nit";
  if (finding.category.toLowerCase() === "praise" || PRAISE_TITLE.test(finding.title)) {
    return "praise";
  }
  const text = `${finding.title}\n${finding.body}`;
  if (TODO_SUGGESTION.test(text) || (finding.suggestion && TODO_SUGGESTION.test(finding.suggestion))) {
    return "todo-suggestion";
  }
  if (SPECULATIVE.test(text)) return "speculative";
  return undefined;
}

function classify(finding: Finding, opts: SuppressOptions, houseFilters: string[]): SuppressReason | undefined {
  const haystack = `${finding.title}\n${finding.body}`.toLowerCase();
  for (const filter of houseFilters) {
    if (haystack.includes(filter.toLowerCase())) return "house-rule";
  }

  const doNotReport = classifyDoNotReport(finding);
  if (doNotReport) return doNotReport;

  if (
    opts.addedLines &&
    finding.line !== undefined &&
    !atLeastSeverity(finding.severity, "high")
  ) {
    const added = opts.addedLines[finding.file];
    if (added !== undefined && !added.includes(finding.line)) return "unchanged-code";
  }

  if (opts.minSeverity && !atLeastSeverity(finding.severity, opts.minSeverity)) {
    return "below-min-severity";
  }
  return undefined;
}

/** Apply all suppression rules. Every drop is recorded with its reason. */
export function applySuppressions(findings: Finding[], opts: SuppressOptions = {}): SuppressResult {
  const houseFilters = opts.houseRules ? parseHouseRuleSuppressions(opts.houseRules) : [];
  const kept: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const finding of findings) {
    const reason = classify(finding, opts, houseFilters);
    if (reason) suppressed.push({ finding, reason });
    else kept.push(finding);
  }
  return { kept, suppressed };
}
