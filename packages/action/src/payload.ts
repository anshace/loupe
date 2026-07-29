/**
 * Pure extraction from a pull_request event payload: the M0 stats fields plus
 * the RunEvent fields the engine gate needs (isDraft, actor, headSha) — task
 * 5.8: both adapters drive the same runReview signature.
 */
import type { RunEvent } from "@code-review/engine";

export interface PrEventInfo {
  prNumber: number;
  headSha: string;
  fileCount: number;
  additions: number;
  deletions: number;
  isDraft: boolean;
  /** Login of the user that caused the event (sender), when present. */
  actor?: string;
}

export function extractPrEventInfo(payload: unknown): PrEventInfo {
  const root = payload as { pull_request?: unknown; sender?: unknown } | null;
  const pr = root?.pull_request as Record<string, unknown> | undefined;
  if (!pr) throw new Error("event payload has no pull_request — is this a pull_request event?");

  const num = (key: string): number => {
    const v = pr[key];
    if (typeof v !== "number") throw new Error(`pull_request.${key} is missing or not a number`);
    return v;
  };
  const headSha = (pr.head as Record<string, unknown> | undefined)?.sha;
  if (typeof headSha !== "string") throw new Error("pull_request.head.sha is missing");

  const senderLogin = (root?.sender as Record<string, unknown> | undefined)?.login;

  return {
    prNumber: num("number"),
    headSha,
    fileCount: num("changed_files"),
    additions: num("additions"),
    deletions: num("deletions"),
    isDraft: pr.draft === true,
    actor: typeof senderLogin === "string" ? senderLogin : undefined,
  };
}

/**
 * The engine RunEvent for an automatic pull_request trigger. `onDemand` is
 * always false on this path — the Action has no slash-command surface; the
 * App/Worker adapter builds the onDemand variant for /review.
 */
export function toRunEvent(info: PrEventInfo): RunEvent {
  return {
    isDraft: info.isDraft,
    actor: info.actor,
    headSha: info.headSha,
    onDemand: false,
  };
}
