/**
 * Stateless dedupe (task 4.3, design decision 6: no storage — the PR's own
 * comments are the state). Fetches the bot's existing review comments and
 * issue comments (injectable fetch) and skips candidate findings whose
 * (file, line-ish, normalized substance) already appears in one of them.
 * Matching is a pure function; skipped findings are recorded, never lost.
 */
import type { FetchLike } from "./diff";
import type { AuthToken, Finding, PrIdentity } from "./types";

/** A previously posted comment, flattened for matching. */
export interface ExistingComment {
  /** File path for inline review comments; undefined for issue comments. */
  path?: string;
  /** Line for inline review comments. */
  line?: number;
  body: string;
}

export interface ExistingIssueComment {
  id: number;
  body: string;
  user?: string;
}

export interface ExistingComments {
  reviewComments: ExistingComment[];
  issueComments: ExistingIssueComment[];
}

export const EMPTY_EXISTING: ExistingComments = { reviewComments: [], issueComments: [] };

/** Lowercase, strip markdown/punctuation, collapse whitespace. */
export function normalizeSubstance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~#>[\](){}"'.,:;!?|\\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const DEFAULT_LINE_TOLERANCE = 2;

/**
 * True when the finding duplicates an existing comment: same file, a line
 * within `lineTolerance` (when both have one), and the finding's normalized
 * title contained in the comment's normalized body.
 */
export function isDuplicate(
  finding: Finding,
  existing: readonly ExistingComment[],
  lineTolerance: number = DEFAULT_LINE_TOLERANCE,
): boolean {
  const title = normalizeSubstance(finding.title);
  if (title.length === 0) return false;
  for (const comment of existing) {
    const body = normalizeSubstance(comment.body);
    if (!body.includes(title)) continue;
    if (comment.path !== undefined) {
      if (comment.path !== finding.file) continue;
      if (
        comment.line !== undefined &&
        finding.line !== undefined &&
        Math.abs(comment.line - finding.line) > lineTolerance
      ) {
        continue;
      }
      return true;
    }
    // Issue-comment body (e.g. an old summary): require the file path too.
    if (comment.body.includes(finding.file)) return true;
  }
  return false;
}

export interface DedupeResult<T> {
  kept: T[];
  deduped: Finding[];
}

/** Partition candidates into new findings and already-reported duplicates. */
export function dedupeFindings<T extends { finding: Finding }>(
  candidates: readonly T[],
  existing: readonly ExistingComment[],
  lineTolerance: number = DEFAULT_LINE_TOLERANCE,
): DedupeResult<T> {
  const kept: T[] = [];
  const deduped: Finding[] = [];
  for (const candidate of candidates) {
    if (isDuplicate(candidate.finding, existing, lineTolerance)) deduped.push(candidate.finding);
    else kept.push(candidate);
  }
  return { kept, deduped };
}

const GITHUB_API = "https://api.github.com";
const GH_HEADERS = (auth: AuthToken): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${auth}`,
  "x-github-api-version": "2022-11-28",
  "user-agent": "code-review-engine",
});

interface RawReviewComment {
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string;
  user?: { login?: string };
}

interface RawIssueComment {
  id?: number;
  body?: string;
  user?: { login?: string };
}

async function fetchJsonArray(url: string, auth: AuthToken, fetchImpl: FetchLike): Promise<unknown[]> {
  try {
    const res = await fetchImpl(url, { headers: GH_HEADERS(auth) });
    if (!res.ok) return [];
    const parsed: unknown = JSON.parse(await res.text());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // dedupe/state recovery must never crash a run
  }
}

/**
 * Fetch the PR's existing review comments + issue comments. When botIdentity
 * is given, only that login's comments are returned (the spec dedupes against
 * the system's own comments); otherwise all comments are considered.
 */
export async function fetchExistingComments(
  pr: PrIdentity,
  auth: AuthToken,
  fetchImpl: FetchLike,
  botIdentity?: string,
): Promise<ExistingComments> {
  const base = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}`;
  const [rawReview, rawIssue] = await Promise.all([
    fetchJsonArray(`${base}/pulls/${pr.prNumber}/comments?per_page=100`, auth, fetchImpl),
    fetchJsonArray(`${base}/issues/${pr.prNumber}/comments?per_page=100`, auth, fetchImpl),
  ]);

  const mine = (login: string | undefined): boolean =>
    botIdentity === undefined || (login !== undefined && login.toLowerCase() === botIdentity.toLowerCase());

  const reviewComments: ExistingComment[] = [];
  for (const entry of rawReview as RawReviewComment[]) {
    if (typeof entry?.body !== "string" || !mine(entry.user?.login)) continue;
    const line = entry.line ?? entry.original_line;
    reviewComments.push({
      path: entry.path,
      line: typeof line === "number" ? line : undefined,
      body: entry.body,
    });
  }

  const issueComments: ExistingIssueComment[] = [];
  for (const entry of rawIssue as RawIssueComment[]) {
    if (typeof entry?.body !== "string" || typeof entry?.id !== "number") continue;
    if (!mine(entry.user?.login)) continue;
    issueComments.push({ id: entry.id, body: entry.body, user: entry.user?.login });
  }

  return { reviewComments, issueComments };
}
