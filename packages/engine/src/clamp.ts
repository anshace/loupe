/**
 * Line clamping: a finding anchored outside the commentable diff lines is
 * clamped to the nearest commentable line in that file when it is within
 * `maxDistance` lines; otherwise it is reclassified as file-level
 * (`line: undefined`). Never errors the run.
 */
import type { Finding } from "./types";

export const DEFAULT_CLAMP_DISTANCE = 50;

/** Map of file path → sorted commentable new-side line numbers. */
export type CommentableMap = Record<string, readonly number[]>;

function nearest(sorted: readonly number[], target: number): number | undefined {
  let best: number | undefined;
  let bestDist = Infinity;
  for (const n of sorted) {
    const d = Math.abs(n - target);
    if (d < bestDist) {
      best = n;
      bestDist = d;
    }
  }
  return best;
}

export function clampFinding(
  finding: Finding,
  commentable: CommentableMap,
  maxDistance: number = DEFAULT_CLAMP_DISTANCE,
): Finding {
  const lines = commentable[finding.file];
  if (finding.line === undefined) return finding;
  if (!lines || lines.length === 0) return { ...finding, line: undefined };
  if (lines.includes(finding.line)) return finding;
  const candidate = nearest(lines, finding.line);
  if (candidate !== undefined && Math.abs(candidate - finding.line) <= maxDistance) {
    return { ...finding, line: candidate };
  }
  return { ...finding, line: undefined };
}

export function clampFindings(
  findings: Finding[],
  commentable: CommentableMap,
  maxDistance: number = DEFAULT_CLAMP_DISTANCE,
): Finding[] {
  return findings.map((f) => clampFinding(f, commentable, maxDistance));
}
