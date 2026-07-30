/**
 * Thin GitHub REST helpers the worker needs beyond what the engine already
 * does: collaborator permission checks (task 5.6), the 👀 reaction ack
 * (task 5.7), PR head lookup, and issue-comment posting (for /ask replies).
 * All take an injectable fetch.
 */
import type { AuthToken, FetchLike, PrIdentity } from "@code-review/engine";

const GITHUB_API = "https://api.github.com";

function headers(auth: AuthToken): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${auth}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "code-review-worker",
  };
}

/** Permission levels that may issue slash commands (spec: collaborator-gated). */
const COMMAND_PERMISSIONS = new Set(["admin", "write", "maintain"]);

/**
 * True when `username` has write-or-better access to the repo.
 * A 404 means "not a collaborator" — that (and any other failure) → false,
 * so unknown users are always treated as unauthorized.
 */
export async function isCollaboratorWithWrite(
  pr: Pick<PrIdentity, "owner" | "repo">,
  username: string,
  auth: AuthToken,
  fetchImpl: FetchLike,
): Promise<boolean> {
  const url = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/collaborators/${encodeURIComponent(username)}/permission`;
  try {
    const res = await fetchImpl(url, { headers: headers(auth) });
    if (!res.ok) return false;
    const json = JSON.parse(await res.text()) as { permission?: string };
    return typeof json.permission === "string" && COMMAND_PERMISSIONS.has(json.permission);
  } catch {
    return false;
  }
}

/** Acknowledge an accepted command with 👀 on the triggering comment (5.7). */
export async function addEyesReaction(
  pr: Pick<PrIdentity, "owner" | "repo">,
  commentId: number,
  auth: AuthToken,
  fetchImpl: FetchLike,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/issues/comments/${commentId}/reactions`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { ...headers(auth), "content-type": "application/json" },
    body: JSON.stringify({ content: "eyes" }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`adding 👀 reaction to comment ${commentId} failed: HTTP ${res.status} ${body}`);
  }
}

export interface PrHead {
  headSha: string;
  isDraft: boolean;
}

/** Fetch the PR's current head SHA + draft state (issue_comment payloads lack both). */
export async function fetchPrHead(pr: PrIdentity, auth: AuthToken, fetchImpl: FetchLike): Promise<PrHead> {
  const url = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/pulls/${pr.prNumber}`;
  const res = await fetchImpl(url, { headers: headers(auth) });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`fetching PR ${pr.owner}/${pr.repo}#${pr.prNumber} failed: HTTP ${res.status} ${body}`);
  }
  const json = JSON.parse(await res.text()) as { head?: { sha?: string }; draft?: boolean };
  if (typeof json.head?.sha !== "string") {
    throw new Error(`PR ${pr.owner}/${pr.repo}#${pr.prNumber} response has no head.sha`);
  }
  return { headSha: json.head.sha, isDraft: json.draft === true };
}

/** Post a plain issue comment on the PR (used for /ask answers). */
export async function postIssueComment(
  pr: PrIdentity,
  body: string,
  auth: AuthToken,
  fetchImpl: FetchLike,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/issues/${pr.prNumber}/comments`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { ...headers(auth), "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`posting comment on ${pr.owner}/${pr.repo}#${pr.prNumber} failed: HTTP ${res.status} ${text}`);
  }
}

/** A PR review comment's author + body + anchoring info (report item #32). */
export interface ReviewCommentInfo {
  author?: string;
  body: string;
  diffHunk?: string;
  path?: string;
}

/**
 * Fetch one PR review comment by id — used to confirm a reply's PARENT is one of
 * Loupe's own findings (author === bot) and to carry its finding text as context.
 */
export async function fetchReviewComment(
  pr: Pick<PrIdentity, "owner" | "repo">,
  commentId: number,
  auth: AuthToken,
  fetchImpl: FetchLike,
): Promise<ReviewCommentInfo> {
  const url = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/pulls/comments/${commentId}`;
  const res = await fetchImpl(url, { headers: headers(auth) });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`fetching review comment ${commentId} failed: HTTP ${res.status} ${text}`);
  }
  const json = JSON.parse(await res.text()) as {
    user?: { login?: string };
    body?: string;
    diff_hunk?: string;
    path?: string;
  };
  return { author: json.user?.login, body: json.body ?? "", diffHunk: json.diff_hunk, path: json.path };
}

/** Acknowledge an accepted reply with 👀 on the reply review-comment (report item #32). */
export async function addEyesReactionToReviewComment(
  pr: Pick<PrIdentity, "owner" | "repo">,
  commentId: number,
  auth: AuthToken,
  fetchImpl: FetchLike,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/pulls/comments/${commentId}/reactions`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { ...headers(auth), "content-type": "application/json" },
    body: JSON.stringify({ content: "eyes" }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`adding 👀 reaction to review comment ${commentId} failed: HTTP ${res.status} ${body}`);
  }
}

/** Post a threaded reply under an existing review-comment thread (report item #32). */
export async function postReviewCommentReply(
  pr: PrIdentity,
  inReplyToId: number,
  body: string,
  auth: AuthToken,
  fetchImpl: FetchLike,
): Promise<void> {
  const url = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/pulls/${pr.prNumber}/comments/${inReplyToId}/replies`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { ...headers(auth), "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(
      `posting threaded reply on ${pr.owner}/${pr.repo}#${pr.prNumber} failed: HTTP ${res.status} ${text}`,
    );
  }
}
