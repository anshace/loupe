/**
 * Git blame / history context (report item #20).
 *
 * For each changed file+span the engine fetches GitHub's GraphQL Blame once per
 * file and summarizes how old / how churny the changed region is — a compact
 * "last touched N days ago by M author(s)" line. Its purpose is to give the
 * REVIEWER, and especially the VERIFIER, real evidence for the `pre-existing`
 * drop reason instead of a guess: old/stable surrounding code makes a
 * `pre-existing` verdict defensible, freshly-churned code makes a fresh finding
 * more credible.
 *
 * HARD RULES honored:
 *  - Zero runtime deps: plain injectable `fetch`, no new npm dep.
 *  - Fail-soft: any network/parse error or absent field → undefined / skipped;
 *    this module NEVER throws. History is pure context — losing it is harmless.
 *  - Determinism: the pure summarizer takes `now` as a parameter. The engine
 *    core never reads the clock (mirrors the cost ledger / run log), so tests
 *    inject a fixed clock and the pipeline stays reproducible.
 *
 * Off by default (EngineConfig.historyContext): it costs one GraphQL call per
 * changed file, so — like crossFileCallers and rag — it stays opt-in until the
 * eval set measures its precision win, keeping free-tier runs cheap.
 */
import type { FetchLike } from "./diff";
import type { AuthToken, PrIdentity } from "./types";
import { isChurnMessage } from "./escalate";

const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const GITHUB_API = "https://api.github.com";

/** One blame range (the fields we use) from the GraphQL Blame API. */
export interface BlameRange {
  /** 1-based inclusive start line (new side of the ref queried). */
  startLine: number;
  /** 1-based inclusive end line. */
  endLine: number;
  /** ISO-8601 date the range's commit was committed. */
  committedDate: string;
  /** Commit author display name, when present. */
  author?: string;
  /** Full commit oid, when present (rendered short in summaries). */
  oid?: string;
}

// `object(expression:)` accepts a commit oid, a branch name, or "ref:path", so
// the same query works whether the caller has a head SHA or only "HEAD".
const BLAME_QUERY =
  "query($owner:String!,$repo:String!,$ref:String!,$path:String!){" +
  "repository(owner:$owner,name:$repo){object(expression:$ref){... on Commit{" +
  "blame(path:$path){ranges{startingLine endingLine " +
  "commit{oid committedDate author{name}}}}}}}}";

interface GraphqlBlameShape {
  data?: {
    repository?: {
      object?: {
        blame?: {
          ranges?: Array<{
            startingLine?: unknown;
            endingLine?: unknown;
            commit?: { oid?: unknown; committedDate?: unknown; author?: { name?: unknown } };
          }>;
        };
      };
    };
  };
}

/**
 * Fetch blame ranges for one file at a ref via the GraphQL API. ONE network
 * call. Returns undefined on ANY failure (fail-soft) — never throws.
 */
export async function fetchBlameRanges(
  pr: PrIdentity,
  auth: AuthToken,
  path: string,
  ref: string,
  fetchImpl: FetchLike,
): Promise<BlameRange[] | undefined> {
  try {
    const res = await fetchImpl(GITHUB_GRAPHQL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth}`,
        "content-type": "application/json",
        "user-agent": "code-review-engine",
      },
      body: JSON.stringify({
        query: BLAME_QUERY,
        variables: { owner: pr.owner, repo: pr.repo, ref, path },
      }),
    });
    if (!res.ok) return undefined;
    const json = JSON.parse(await res.text()) as GraphqlBlameShape;
    const ranges = json?.data?.repository?.object?.blame?.ranges;
    if (!Array.isArray(ranges)) return undefined;
    const out: BlameRange[] = [];
    for (const r of ranges) {
      const startLine = Number(r?.startingLine);
      const endLine = Number(r?.endingLine);
      const committedDate = r?.commit?.committedDate;
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) continue;
      if (typeof committedDate !== "string") continue;
      out.push({
        startLine,
        endLine,
        committedDate,
        author: typeof r?.commit?.author?.name === "string" ? (r.commit.author.name as string) : undefined,
        oid: typeof r?.commit?.oid === "string" ? (r.commit.oid as string) : undefined,
      });
    }
    return out;
  } catch {
    return undefined;
  }
}

/** 1-based inclusive line span (new side). */
export interface LineSpan {
  startLine: number;
  endLine: number;
}

/** Compact history summary for one file's changed region. */
export interface FileHistory {
  path: string;
  /** Distinct commit authors touching the changed spans. */
  authorCount: number;
  /** Distinct commits touching the changed spans. */
  commitCount: number;
  /** Whole days since the MOST RECENT touch of the changed spans (from injected now). */
  mostRecentDaysAgo: number;
  /** Whole days since the OLDEST touch of the changed spans. */
  oldestDaysAgo: number;
  /** Short oid of the most-recent touching commit, when known. */
  mostRecentOid?: string;
}

const MS_PER_DAY = 86_400_000;

function overlaps(a: LineSpan, b: LineSpan): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/**
 * Summarize the blame ranges that intersect the changed spans into one
 * FileHistory. Pure; `now` is injected (no clock read here). Returns undefined
 * when no range intersects the spans or no range carries a usable date.
 */
export function summarizeFileHistory(
  path: string,
  ranges: readonly BlameRange[],
  spans: readonly LineSpan[],
  now: Date,
): FileHistory | undefined {
  if (spans.length === 0) return undefined;
  const relevant = ranges.filter((r) =>
    spans.some((s) => overlaps({ startLine: r.startLine, endLine: r.endLine }, s)),
  );
  if (relevant.length === 0) return undefined;

  const authors = new Set<string>();
  const commits = new Set<string>();
  let newest = Number.NEGATIVE_INFINITY;
  let oldest = Number.POSITIVE_INFINITY;
  let newestOid: string | undefined;
  for (const r of relevant) {
    if (r.author) authors.add(r.author);
    if (r.oid) commits.add(r.oid);
    const t = Date.parse(r.committedDate);
    if (Number.isNaN(t)) continue;
    if (t > newest) {
      newest = t;
      newestOid = r.oid;
    }
    if (t < oldest) oldest = t;
  }
  if (newest === Number.NEGATIVE_INFINITY) return undefined; // no parseable dates

  const nowMs = now.getTime();
  return {
    path,
    authorCount: authors.size,
    commitCount: commits.size > 0 ? commits.size : relevant.length,
    mostRecentDaysAgo: Math.max(0, Math.floor((nowMs - newest) / MS_PER_DAY)),
    oldestDaysAgo: Math.max(0, Math.floor((nowMs - oldest) / MS_PER_DAY)),
    mostRecentOid: newestOid ? newestOid.slice(0, 7) : undefined,
  };
}

function daysPhrase(days: number): string {
  if (days <= 0) return "today";
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Render the {{CODE_HISTORY}} block from per-file summaries. Pure. */
export function renderHistoryContext(histories: readonly FileHistory[]): string {
  if (histories.length === 0) return "(none)";
  return histories
    .map((h) => {
      const authors = `${h.authorCount} author${h.authorCount === 1 ? "" : "s"}`;
      const oid = h.mostRecentOid ? ` (${h.mostRecentOid})` : "";
      const churn = h.commitCount > 1 ? `, ${h.commitCount} commits` : "";
      const stable = h.oldestDaysAgo >= 365 ? "; oldest touch 365+ days ago (stable)" : "";
      return `- ${h.path}: changed lines last touched ${daysPhrase(h.mostRecentDaysAgo)}${oid} by ${authors}${churn}${stable}`;
    })
    .join("\n");
}

/** One file's changed spans to look up history for. */
export interface HistoryInput {
  path: string;
  spans: LineSpan[];
}

/**
 * Fetch + summarize blame history for a set of files at `ref`. One GraphQL
 * call per file; each failure is swallowed per-file so one bad file never sinks
 * the rest. Pure inputs + injected `fetchImpl`/`now`.
 */
export async function collectFileHistories(
  pr: PrIdentity,
  auth: AuthToken,
  ref: string,
  inputs: readonly HistoryInput[],
  fetchImpl: FetchLike,
  now: Date,
): Promise<FileHistory[]> {
  const out: FileHistory[] = [];
  for (const input of inputs) {
    if (input.spans.length === 0) continue;
    const ranges = await fetchBlameRanges(pr, auth, input.path, ref, fetchImpl);
    if (!ranges) continue;
    const summary = summarizeFileHistory(input.path, ranges, input.spans, now);
    if (summary) out.push(summary);
  }
  return out;
}

// ── Churn history (report item #19) ─────────────────────────────────────────
//
// The churn escalation signal: a changed file whose RECENT commit history shows
// revert / hotfix / rollback commits is empirically bug-prone, so a fresh change
// to it escalates to the stronger model. Uses the commits REST endpoint scoped
// to each path (`?path=…`) — plain injectable fetch, fail-soft, never throws.
// The churn CLASSIFICATION (which subjects count) lives in escalate.ts so it is
// single-sourced with the escalation decision.

/** How many recent commits per file to inspect for churn markers. */
export const DEFAULT_CHURN_LOOKBACK_COMMITS = 15;

/**
 * Recent commit subjects touching `path` at `ref`, newest first. ONE REST call.
 * Returns undefined on ANY failure (fail-soft) — never throws.
 */
export async function fetchRecentCommitMessages(
  pr: PrIdentity,
  auth: AuthToken,
  path: string,
  ref: string,
  fetchImpl: FetchLike,
  perPage: number = DEFAULT_CHURN_LOOKBACK_COMMITS,
): Promise<string[] | undefined> {
  try {
    const url =
      `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/commits` +
      `?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=${perPage}`;
    const res = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${auth}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "code-review-engine",
      },
    });
    if (!res.ok) return undefined;
    const json = JSON.parse(await res.text()) as Array<{ commit?: { message?: unknown } }>;
    if (!Array.isArray(json)) return undefined;
    return json
      .map((c) => c?.commit?.message)
      .filter((m): m is string => typeof m === "string");
  } catch {
    return undefined;
  }
}

/**
 * The subset of `paths` whose recent history contains a revert/hotfix/rollback
 * commit — the churn escalation signal (report item #19). One commits call per
 * path; each failure is swallowed per-path. Pure inputs + injected fetch.
 */
export async function collectChurnyPaths(
  pr: PrIdentity,
  auth: AuthToken,
  ref: string,
  paths: readonly string[],
  fetchImpl: FetchLike,
  perPage: number = DEFAULT_CHURN_LOOKBACK_COMMITS,
): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    const messages = await fetchRecentCommitMessages(pr, auth, path, ref, fetchImpl, perPage);
    if (messages && messages.some(isChurnMessage)) out.push(path);
  }
  return out;
}
