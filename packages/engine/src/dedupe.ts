/**
 * Stateless dedupe (task 4.3, design decision 6: no storage — the PR's own
 * comments are the state). Fetches the bot's existing review comments and
 * issue comments (injectable fetch) and skips candidate findings whose
 * (file, line-ish, normalized substance) already appears in one of them.
 * Matching is a pure function; skipped findings are recorded, never lost.
 */
import type { FetchLike } from "./diff";
import type { AuthToken, Finding, PrIdentity } from "./types";

/**
 * Reaction tallies on one of the bot's own prior comments (feature #12).
 * Captured from the `reactions` summary object GitHub already returns in the
 * comment-list responses (no extra call). Undefined on an ExistingComment when
 * the comment carried no reactions at all.
 */
export interface ReactionCounts {
  /** 👍 (`+1`) — a weak "I agree" signal. */
  up: number;
  /** 👎 (`-1`) — the dispute signal. */
  down: number;
  /** 👀 (`eyes`) — acknowledgment / "seen", classified as neither. */
  eyes: number;
  /** 😕 (`confused`) — a soft dispute signal. */
  confused: number;
}

/**
 * Parse the GitHub reaction summary object into tallies (feature #12). Returns
 * undefined when the object is absent or every relevant count is zero, so an
 * ExistingComment stays clean (and toEqual-stable) when there is no feedback.
 */
export function parseReactions(raw: unknown): ReactionCounts | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const num = (k: string): number => (typeof r[k] === "number" && r[k] >= 0 ? (r[k] as number) : 0);
  const counts: ReactionCounts = { up: num("+1"), down: num("-1"), eyes: num("eyes"), confused: num("confused") };
  if (counts.up === 0 && counts.down === 0 && counts.eyes === 0 && counts.confused === 0) return undefined;
  return counts;
}

/** A previously posted comment, flattened for matching. */
export interface ExistingComment {
  /** File path for inline review comments; undefined for issue comments. */
  path?: string;
  /** Line for inline review comments. */
  line?: number;
  body: string;
  /**
   * The review comment's REST `id` (== GraphQL databaseId), used to join a
   * comment to its review thread's resolution state (feature #12). Undefined
   * for issue comments and when the raw payload omitted it.
   */
  id?: number;
  /** Reaction tallies captured for feedback observability (feature #12). */
  reactions?: ReactionCounts;
}

export interface ExistingIssueComment {
  id: number;
  body: string;
  user?: string;
  /** Reaction tallies captured for feedback observability (feature #12). */
  reactions?: ReactionCounts;
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

/**
 * Conservative near-duplicate key (feature #10): category + normalized title.
 * Two findings share a key only when they are, by title and category, the SAME
 * issue — so distinct issues (different title OR different category) never
 * cluster together.
 */
export function nearDuplicateKey(finding: Finding): string {
  return `${finding.category.toLowerCase().trim()}::${normalizeSubstance(finding.title)}`;
}

function locationLabel(finding: Finding): string {
  return finding.line !== undefined ? `\`${finding.file}\`:${finding.line}` : `\`${finding.file}\``;
}

export interface GroupResult<T> {
  /** One representative per cluster, in the original first-seen order. */
  kept: T[];
  /** Non-representative members folded into a representative — disclosed, not lost. */
  folded: Finding[];
}

/**
 * Intra-run near-duplicate grouping (feature #10): cluster findings that are the
 * SAME issue repeated across files/lines into ONE representative comment, with an
 * "Also found in:" list of the other locations appended to its body — instead of
 * posting N near-identical comments. Pure post-processing, runs just before
 * publishing. Matching is deliberately conservative (identical category +
 * normalized title), so genuinely different findings are never merged. A cluster
 * of size one is returned unchanged. Folded members are returned in `folded`
 * (never silently dropped — they are disclosed in the representative's body).
 */
export function groupNearDuplicates<T extends { finding: Finding }>(candidates: readonly T[]): GroupResult<T> {
  const clusters = new Map<string, T[]>();
  const order: string[] = [];
  for (const candidate of candidates) {
    const key = nearDuplicateKey(candidate.finding);
    const bucket = clusters.get(key);
    if (bucket) {
      bucket.push(candidate);
    } else {
      clusters.set(key, [candidate]);
      order.push(key);
    }
  }

  const kept: T[] = [];
  const folded: Finding[] = [];
  for (const key of order) {
    const members = clusters.get(key) as T[];
    if (members.length === 1) {
      kept.push(members[0]);
      continue;
    }
    const [representative, ...rest] = members;
    const repLabel = locationLabel(representative.finding);
    const alsoIn: string[] = [];
    for (const member of rest) {
      folded.push(member.finding);
      const label = locationLabel(member.finding);
      if (label !== repLabel && !alsoIn.includes(label)) alsoIn.push(label);
    }
    const body =
      alsoIn.length > 0
        ? `${representative.finding.body}\n\n_Also found in:_ ${alsoIn.join(", ")}`
        : representative.finding.body;
    kept.push({ ...representative, finding: { ...representative.finding, body } });
  }
  return { kept, folded };
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
  id?: number;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string;
  user?: { login?: string };
  reactions?: unknown;
}

interface RawIssueComment {
  id?: number;
  body?: string;
  user?: { login?: string };
  reactions?: unknown;
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
      id: typeof entry.id === "number" ? entry.id : undefined,
      reactions: parseReactions(entry.reactions),
    });
  }

  const issueComments: ExistingIssueComment[] = [];
  for (const entry of rawIssue as RawIssueComment[]) {
    if (typeof entry?.body !== "string" || typeof entry?.id !== "number") continue;
    if (!mine(entry.user?.login)) continue;
    issueComments.push({
      id: entry.id,
      body: entry.body,
      user: entry.user?.login,
      reactions: parseReactions(entry.reactions),
    });
  }

  return { reviewComments, issueComments };
}
