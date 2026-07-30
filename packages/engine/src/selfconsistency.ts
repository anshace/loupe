/**
 * Self-consistency voting (report item #15). On the small set of critical/high
 * findings — where a false alarm most damages a maintainer's trust — the engine
 * re-runs the SAME reviewer 1–2 extra times at temperature > 0 and checks
 * whether each high-stakes finding reappears. A finding a majority of samples
 * reproduce keeps its severity; one that does NOT is DEMOTED a single level
 * (critical→high, high→medium) — never silently dropped, consistent with the
 * pipeline's fail-open bias (a demoted finding is still published).
 *
 * This module is the pure reconciliation core: the re-invocation + cost gating
 * lives in run.ts, which passes the already-parsed sample finding-sets here.
 */
import type { Finding, Severity } from "./types";

/** Sampling temperature for the extra self-consistency reviewer runs. */
export const SELF_CONSISTENCY_TEMPERATURE = 0.6;

/** Max extra reviewer samples drawn (on top of the original pass). Bounds cost. */
export const SELF_CONSISTENCY_MAX_SAMPLES = 2;

/** Fuzzy same-finding line proximity (report item #15's matching heuristic). */
const LINE_WINDOW = 3;

/** One-level severity demotion for a high-stakes finding not reproduced. */
const DEMOTE: Partial<Record<Severity, Severity>> = {
  critical: "high",
  high: "medium",
};

export interface Demotion {
  /** The finding AFTER demotion (its severity is already the demoted value). */
  finding: Finding;
  from: Severity;
  to: Severity;
}

export interface SelfConsistencyResult {
  /** The reconciled findings, in the original order, with demotions applied. */
  findings: Finding[];
  demoted: Demotion[];
}

/** Severities self-consistency voting scrutinizes (the high-stakes subset). */
export function isHighStakes(severity: Severity): boolean {
  return severity === "critical" || severity === "high";
}

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Fuzzy "same finding" match across independent samples: same file, same
 * category, and line numbers within a small window. When one side is file-level
 * (no line) and the other is line-anchored, fall back to a normalized-title
 * match so a coincidental file+category pairing does not count as agreement.
 * Pure.
 */
export function findingsMatch(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;
  if (a.category.toLowerCase() !== b.category.toLowerCase()) return false;
  if (a.line !== undefined && b.line !== undefined) {
    return Math.abs(a.line - b.line) <= LINE_WINDOW;
  }
  if (a.line === undefined && b.line === undefined) return true;
  // Mixed anchoring: require the titles to agree.
  return normalizeTitle(a.title) === normalizeTitle(b.title);
}

/**
 * Reconcile the original findings against `samples` (additional independent
 * reviewer passes). Only critical/high findings are voted on; every other
 * finding passes through untouched. A high-stakes finding is kept at its
 * severity when a MAJORITY of all passes (original + samples) contain a matching
 * finding, and demoted one level otherwise. Never drops. Pure.
 */
export function reconcileSelfConsistency(
  original: readonly Finding[],
  samples: readonly (readonly Finding[])[],
): SelfConsistencyResult {
  const totalVotes = 1 + samples.length; // the original pass always votes
  const findings: Finding[] = [];
  const demoted: Demotion[] = [];

  for (const f of original) {
    const demoteTo = DEMOTE[f.severity];
    if (!demoteTo || samples.length === 0) {
      // Not high-stakes, or nothing to vote with → unchanged.
      findings.push(f);
      continue;
    }
    let votes = 1; // the original pass produced this finding
    for (const sample of samples) {
      if (sample.some((s) => findingsMatch(f, s))) votes += 1;
    }
    if (votes * 2 > totalVotes) {
      findings.push(f);
    } else {
      const demotedFinding: Finding = { ...f, severity: demoteTo };
      findings.push(demotedFinding);
      demoted.push({ finding: demotedFinding, from: f.severity, to: demoteTo });
    }
  }

  return { findings, demoted };
}
