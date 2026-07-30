/**
 * Feedback-observability capture (feature #12). When Loupe reads its OWN prior
 * comments (the dedupe fetch), it ALSO reads two developer-feedback signals on
 * them and classifies each prior finding:
 *
 *   - reaction tallies (👍/👎/👀) — already present in the REST comment payload
 *     (parsed in dedupe.ts, no extra call);
 *   - review-thread resolution state (`isResolved`) — REST does not expose this,
 *     so it comes from ONE GraphQL query, joined by comment databaseId.
 *
 * The result is recorded to the run log (runlog.ts) and surfaced on the run
 * result. This is PURE OBSERVABILITY: it never changes what gets posted, and
 * every step fails soft (a failed GraphQL call → resolution unknown, not a
 * crashed run). The learned-rule suggestion queue (feature #31) mines this log.
 *
 * Why behavioral, not just emojis: CodeRabbit's own postmortem argues a
 * thumbs-up is a weak/ambiguous signal; the reliable signal is behavioral (did
 * the developer resolve/dismiss the thread). We therefore weigh resolution and
 * a clear 👎 more than a lone 👍 — see `classifyFeedback`.
 */
import type { ExistingComment, ReactionCounts } from "./dedupe";
import type { FetchLike } from "./diff";
import type { AuthToken, PrIdentity } from "./types";

/** How a prior finding fared with the developer (feature #12). */
export type FeedbackClass = "accepted" | "disputed" | "unresolved";

/**
 * Classify one prior comment from its reactions + thread resolution. Pure.
 *
 * Rules (dispute beats accept — an explicit 👎/😕 is a stronger signal than a
 * resolved thread, which is ambiguous between "fixed" and "dismissed as wrong"):
 *   - `disputed`   when 👎 outweigh 👍, or someone reacted 😕 with no 👍;
 *   - `accepted`   otherwise, when the thread is resolved or it drew any 👍;
 *   - `unresolved` when there is no signal at all (fresh / untouched comment).
 */
export function classifyFeedback(
  reactions: ReactionCounts | undefined,
  resolved: boolean | undefined,
): FeedbackClass {
  const up = reactions?.up ?? 0;
  const down = reactions?.down ?? 0;
  const confused = reactions?.confused ?? 0;
  if (down > up || (confused > 0 && up === 0)) return "disputed";
  if (resolved === true || up > 0) return "accepted";
  return "unresolved";
}

/**
 * Extract `[severity] Title` from one of Loupe's own rendered inline-comment
 * bodies (publish.ts formats them as `**[severity] Title**\n\n...`). Best-effort
 * — used only to give the learned-rule queue (#31) a substance label; undefined
 * when the body isn't in the expected shape. Pure.
 */
export function parseFindingTitle(body: string): string | undefined {
  const m = /\*\*\[(?:critical|high|medium|low|nit)\]\s+([^\n*][^\n]*?)\*\*/i.exec(body);
  return m ? m[1].trim() : undefined;
}

/** One classified prior finding (feature #12). */
export interface FeedbackItem {
  /** File path of the inline comment; undefined for file-level/summary comments. */
  path?: string;
  line?: number;
  /** Best-effort finding title parsed from the comment body. */
  title?: string;
  classification: FeedbackClass;
  reactions: ReactionCounts;
  /** Thread resolution state, when known. */
  resolved?: boolean;
}

/** Roll-up of the classified prior comments for one run (feature #12). */
export interface FeedbackReport {
  items: FeedbackItem[];
  accepted: number;
  disputed: number;
  unresolved: number;
  total: number;
}

const NO_REACTIONS: ReactionCounts = { up: 0, down: 0, eyes: 0, confused: 0 };

/**
 * Classify the bot's prior INLINE review comments (the ones that map to
 * findings) using their captured reactions + the resolution map. Pure. Issue
 * comments (the single summary) are not findings and are excluded. `resolution`
 * maps a review comment's databaseId → its thread's isResolved.
 */
export function buildFeedbackReport(
  reviewComments: readonly ExistingComment[],
  resolution: ReadonlyMap<number, boolean>,
): FeedbackReport {
  const items: FeedbackItem[] = [];
  for (const c of reviewComments) {
    const resolved = c.id !== undefined ? resolution.get(c.id) : undefined;
    const classification = classifyFeedback(c.reactions, resolved);
    items.push({
      path: c.path,
      line: c.line,
      title: parseFindingTitle(c.body),
      classification,
      reactions: c.reactions ?? NO_REACTIONS,
      resolved,
    });
  }
  const count = (k: FeedbackClass): number => items.filter((i) => i.classification === k).length;
  return {
    items,
    accepted: count("accepted"),
    disputed: count("disputed"),
    unresolved: count("unresolved"),
    total: items.length,
  };
}

const GITHUB_GRAPHQL = "https://api.github.com/graphql";

const RESOLUTION_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{ isResolved comments(first:100){ nodes{ databaseId } } }
      }
    }
  }
}`;

interface RawThread {
  isResolved?: boolean;
  comments?: { nodes?: Array<{ databaseId?: number } | null> | null };
}

/**
 * Fetch each review comment's thread-resolution state via ONE GraphQL query,
 * returning databaseId → isResolved. Fail-soft: any error (network, GraphQL
 * errors, unexpected shape) yields an empty map — feedback capture is pure
 * observability and must never crash or alter a run. Injectable fetch.
 */
export async function fetchReviewThreadResolution(
  pr: PrIdentity,
  auth: AuthToken,
  fetchImpl: FetchLike,
): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>();
  try {
    const res = await fetchImpl(GITHUB_GRAPHQL, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${auth}`,
        "content-type": "application/json",
        "user-agent": "code-review-engine",
      },
      body: JSON.stringify({
        query: RESOLUTION_QUERY,
        variables: { owner: pr.owner, repo: pr.repo, number: pr.prNumber },
      }),
    });
    if (!res.ok) return out;
    const parsed: unknown = JSON.parse(await res.text());
    const threads =
      (parsed as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: RawThread[] } } } } })?.data
        ?.repository?.pullRequest?.reviewThreads?.nodes;
    if (!Array.isArray(threads)) return out;
    for (const t of threads) {
      if (typeof t?.isResolved !== "boolean") continue;
      for (const c of t.comments?.nodes ?? []) {
        if (c && typeof c.databaseId === "number") out.set(c.databaseId, t.isResolved);
      }
    }
  } catch {
    // Feedback capture is best-effort — swallow and return what we have.
  }
  return out;
}

/** The compact per-run feedback shape written into the run log (feature #12). */
export interface RunLogFeedbackItem {
  path?: string;
  title?: string;
  class: "disputed" | "unresolved";
}

export interface RunLogFeedback {
  accepted: number;
  disputed: number;
  unresolved: number;
  total: number;
  /**
   * Detail for the ACTIONABLE (disputed / unresolved) items only — the input
   * the learned-rule suggestion queue (#31) mines. Accepted items need no
   * detail. Capped to keep the run-log line small.
   */
  items?: RunLogFeedbackItem[];
}

const DEFAULT_FEEDBACK_ITEM_CAP = 50;

/**
 * Project a FeedbackReport into the compact, capped shape stored in the run
 * log (feature #12). Keeps only disputed/unresolved items (the ones #31 acts
 * on) and drops the verbose reaction detail. Pure.
 */
export function toRunLogFeedback(report: FeedbackReport, cap: number = DEFAULT_FEEDBACK_ITEM_CAP): RunLogFeedback {
  const items: RunLogFeedbackItem[] = [];
  for (const i of report.items) {
    if (i.classification !== "disputed" && i.classification !== "unresolved") continue;
    items.push({ path: i.path, title: i.title, class: i.classification });
    if (items.length >= cap) break;
  }
  return {
    accepted: report.accepted,
    disputed: report.disputed,
    unresolved: report.unresolved,
    total: report.total,
    items: items.length > 0 ? items : undefined,
  };
}
