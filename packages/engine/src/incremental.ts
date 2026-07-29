/**
 * Incremental re-review scoping (task 7.2).
 *
 * On `synchronize`, when the event carries a `before` SHA AND a prior review
 * is known (state store, or the summary-marker fallback), only the
 * `base...head` comparison diff is reviewed instead of the whole PR. The
 * compare BASE is the last REVIEWED sha when known (so pushes that were
 * gate-skipped are still covered), falling back to the event's `before`.
 *
 * First review of a PR, reopen without prior state, and on-demand /review all
 * use the full PR diff. Additionally, hunks whose content hash was already
 * reviewed are dropped (`dropReviewedHunks`) so unchanged hunks are skipped
 * even within the new range.
 */
import type { FetchLike } from "./diff";
import type { DiffFile, DiffHunk } from "./diff";
import { hashHunk } from "./state";
import type { AuthToken, PrIdentity } from "./types";

export type ScopeDecision =
  | { incremental: false; reason: string }
  | { incremental: true; base: string; head: string };

export interface ScopeInputs {
  /** Previous head SHA from the synchronize event payload. */
  before?: string;
  /** Current head SHA. */
  headSha?: string;
  /** Explicit /review request → always a full review. */
  onDemand?: boolean;
  /** Last reviewed SHA from the state store or the summary marker. */
  lastReviewedSha?: string;
}

/** Decide full-PR vs before..after scope. Pure. */
export function decideScope(input: ScopeInputs): ScopeDecision {
  if (input.onDemand) return { incremental: false, reason: "on-demand review" };
  if (input.lastReviewedSha === undefined) return { incremental: false, reason: "no prior review known" };
  if (input.before === undefined) return { incremental: false, reason: "event carries no before SHA" };
  if (input.headSha === undefined) return { incremental: false, reason: "event carries no head SHA" };
  return { incremental: true, base: input.lastReviewedSha, head: input.headSha };
}

const GITHUB_API = "https://api.github.com";

/** GET /repos/{o}/{r}/compare/{base}...{head} with the diff media type. */
export async function fetchCompareDiff(
  pr: PrIdentity,
  auth: AuthToken,
  base: string,
  head: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const url =
    `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/compare/` +
    `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const res = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github.diff",
      authorization: `Bearer ${auth}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "code-review-engine",
    },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(
      `comparing ${base}...${head} on ${pr.owner}/${pr.repo} failed: HTTP ${res.status} ${body}`,
    );
  }
  return res.text();
}

function renderHunk(hunk: DiffHunk): string {
  const marker: Record<string, string> = { add: "+", del: "-", context: " " };
  const header =
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` +
    (hunk.header ? ` ${hunk.header}` : "");
  return [header, ...hunk.lines.map((l) => marker[l.type] + l.content)].join("\n");
}

/** Rebuild a DiffFile around a subset of its hunks (rawText + commentable lines). */
function rebuildFile(file: DiffFile, hunks: DiffHunk[]): DiffFile {
  const commentable = hunks.flatMap((h) =>
    h.lines.filter((l) => l.type !== "del" && l.newLine !== undefined).map((l) => l.newLine as number),
  );
  const rawText = [
    `diff --git a/${file.oldPath} b/${file.path}`,
    `--- a/${file.oldPath}`,
    `+++ b/${file.path}`,
    ...hunks.map(renderHunk),
  ].join("\n");
  return {
    ...file,
    hunks,
    commentableLines: [...new Set(commentable)].sort((a, b) => a - b),
    rawText,
  };
}

export interface DropReviewedResult {
  files: DiffFile[];
  /** Hunks removed because their content hash was already reviewed. */
  skippedHunks: number;
  /** Files removed entirely (every hunk already reviewed). */
  fullySkippedFiles: string[];
}

/**
 * Drop hunks whose content hash appears in `reviewedHashes` (task 7.2). Files
 * left with zero hunks are removed and reported so the summary can disclose
 * the skip. Binary/hunkless files pass through untouched.
 */
export function dropReviewedHunks(files: readonly DiffFile[], reviewedHashes: ReadonlySet<string>): DropReviewedResult {
  const out: DiffFile[] = [];
  let skippedHunks = 0;
  const fullySkippedFiles: string[] = [];

  for (const file of files) {
    if (file.hunks.length === 0) {
      out.push(file);
      continue;
    }
    const kept = file.hunks.filter((h) => !reviewedHashes.has(hashHunk(file.path, h)));
    skippedHunks += file.hunks.length - kept.length;
    if (kept.length === file.hunks.length) {
      out.push(file);
    } else if (kept.length === 0) {
      fullySkippedFiles.push(file.path);
    } else {
      out.push(rebuildFile(file, kept));
    }
  }
  return { files: out, skippedHunks, fullySkippedFiles };
}
