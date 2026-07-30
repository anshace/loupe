/**
 * Pure webhook → dispatch mapping (task 5.4).
 *
 * Decides what an incoming (already signature-verified) webhook means, with
 * no I/O: either a PR lifecycle review trigger, a slash command, or an
 * ignored event. The handler layer performs auth/permission checks and calls
 * the same `runReview` entry the Action adapter uses.
 */
import type { PrIdentity, RunEvent } from "@code-review/engine";

export type SlashCommand = "review" | "ask";

export type WebhookDispatch =
  | { kind: "ignore"; reason: string }
  | { kind: "review"; pr: PrIdentity; installationId: number; event: RunEvent }
  | {
      kind: "command";
      command: SlashCommand;
      pr: PrIdentity;
      installationId: number;
      /** Login of the commenter — permission-checked before anything runs. */
      commenter: string;
      /** The triggering comment, for the 👀 reaction acknowledgment. */
      commentId: number;
      /** Text after the command word (the /ask question). */
      argument: string;
    }
  | {
      /**
       * A reply UNDER an existing inline review-comment thread (report item #32).
       * The handler verifies the thread is one of Loupe's OWN findings and gates
       * on the replier being a collaborator before answering in-thread.
       */
      kind: "reply";
      pr: PrIdentity;
      installationId: number;
      /** Login of the replier — permission-checked before anything runs. */
      commenter: string;
      /** The reply comment's own id (for the 👀 reaction ack). */
      commentId: number;
      /** The thread-root comment id being replied to (Loupe's finding). */
      inReplyToId: number;
      /** The reply text (attacker-reachable → injection-guarded downstream). */
      body: string;
      /** The diff hunk the thread is anchored to (comment.diff_hunk). */
      diffHunk: string;
      /** File path the thread is on. */
      path?: string;
    };

/** PR lifecycle actions that trigger an automatic review (spec: pr-trigger). */
const PR_REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

const COMMAND_RE = /^\/(review|ask)\b\s*/;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | undefined {
  return typeof value === "object" && value !== null ? (value as Obj) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

interface CommonParts {
  pr: Omit<PrIdentity, "prNumber">;
  installationId: number;
}

function commonParts(payload: Obj): CommonParts | { reason: string } {
  const repository = obj(payload.repository);
  const owner = str(obj(repository?.owner)?.login);
  const repo = str(repository?.name);
  if (!owner || !repo) return { reason: "payload has no repository owner/name" };
  const installationId = num(obj(payload.installation)?.id);
  if (installationId === undefined) return { reason: "payload has no installation id" };
  return { pr: { owner, repo }, installationId };
}

function mapPullRequest(payload: Obj): WebhookDispatch {
  const action = str(payload.action) ?? "(none)";
  if (!PR_REVIEW_ACTIONS.has(action)) {
    return { kind: "ignore", reason: `pull_request action "${action}" does not trigger a review` };
  }
  const common = commonParts(payload);
  if ("reason" in common) return { kind: "ignore", reason: common.reason };

  const pullRequest = obj(payload.pull_request);
  const prNumber = num(pullRequest?.number);
  const headSha = str(obj(pullRequest?.head)?.sha);
  if (prNumber === undefined || headSha === undefined) {
    return { kind: "ignore", reason: "pull_request payload is missing number or head.sha" };
  }

  return {
    kind: "review",
    pr: { ...common.pr, prNumber },
    installationId: common.installationId,
    event: {
      isDraft: pullRequest?.draft === true,
      actor: str(obj(payload.sender)?.login),
      headSha,
      onDemand: false,
      // Present on synchronize only — the incremental compare base (7.2).
      before: str(payload.before),
    },
  };
}

function mapIssueComment(payload: Obj): WebhookDispatch {
  if (str(payload.action) !== "created") {
    return { kind: "ignore", reason: "only newly created comments are considered" };
  }
  const issue = obj(payload.issue);
  if (!obj(issue?.pull_request)) {
    return { kind: "ignore", reason: "comment is on an issue, not a pull request" };
  }
  const comment = obj(payload.comment);
  const body = str(comment?.body) ?? "";
  const match = COMMAND_RE.exec(body.trimStart());
  if (!match) return { kind: "ignore", reason: "comment is not a /review or /ask command" };

  const common = commonParts(payload);
  if ("reason" in common) return { kind: "ignore", reason: common.reason };

  const prNumber = num(issue?.number);
  const commentId = num(comment?.id);
  const commenter = str(obj(comment?.user)?.login);
  if (prNumber === undefined || commentId === undefined || commenter === undefined) {
    return { kind: "ignore", reason: "issue_comment payload is missing issue number, comment id, or commenter" };
  }

  return {
    kind: "command",
    command: match[1] as SlashCommand,
    pr: { ...common.pr, prNumber },
    installationId: common.installationId,
    commenter,
    commentId,
    argument: body.trimStart().slice(match[0].length).trim(),
  };
}

function mapReviewComment(payload: Obj): WebhookDispatch {
  if (str(payload.action) !== "created") {
    return { kind: "ignore", reason: "only newly created review comments are considered" };
  }
  const comment = obj(payload.comment);
  // Only REPLIES (a comment with in_reply_to_id) sit "under" an existing finding.
  // A fresh top-level review comment is not a reply to Loupe and is left alone.
  const inReplyToId = num(comment?.in_reply_to_id);
  if (inReplyToId === undefined) {
    return { kind: "ignore", reason: "review comment is not a reply to an existing thread" };
  }
  const common = commonParts(payload);
  if ("reason" in common) return { kind: "ignore", reason: common.reason };

  const prNumber = num(obj(payload.pull_request)?.number);
  const commentId = num(comment?.id);
  const commenter = str(obj(comment?.user)?.login);
  const body = str(comment?.body);
  if (prNumber === undefined || commentId === undefined || commenter === undefined || body === undefined) {
    return {
      kind: "ignore",
      reason: "review comment payload is missing pr number, comment id, commenter, or body",
    };
  }

  return {
    kind: "reply",
    pr: { ...common.pr, prNumber },
    installationId: common.installationId,
    commenter,
    commentId,
    inReplyToId,
    body,
    diffHunk: str(comment?.diff_hunk) ?? "",
    path: str(comment?.path),
  };
}

/** Map an X-GitHub-Event name + parsed payload to a dispatch decision. */
export function mapWebhook(eventName: string | undefined, payload: unknown): WebhookDispatch {
  const body = obj(payload);
  if (!body) return { kind: "ignore", reason: "payload is not a JSON object" };
  switch (eventName) {
    case "pull_request":
      return mapPullRequest(body);
    case "issue_comment":
      return mapIssueComment(body);
    case "pull_request_review_comment":
      return mapReviewComment(body);
    default:
      return { kind: "ignore", reason: `event "${eventName ?? "(none)"}" is not handled` };
  }
}
