/**
 * Run gate (task 4.5): decides whether a review run should start at all.
 * Pure — the trigger adapter supplies event-shaped inputs, the engine supplies
 * the last-reviewed SHA it recovered from the summary marker comment.
 */

export interface GateInput {
  isDraft?: boolean;
  /** Login of the user/app that caused the event. */
  actor?: string;
  /** The bot's own login. */
  botIdentity?: string;
  /** PR head commit SHA at event time. */
  headSha?: string;
  /** SHA recorded in the summary marker from the last completed review. */
  lastReviewedSha?: string;
  /** Explicit on-demand request — overrides the same-SHA skip. */
  onDemand?: boolean;
}

export type GateDecision = { run: true } | { run: false; reason: string };

export function shouldRun(input: GateInput): GateDecision {
  if (input.isDraft) {
    return { run: false, reason: "pull request is a draft" };
  }
  if (
    input.actor !== undefined &&
    input.botIdentity !== undefined &&
    input.actor.toLowerCase() === input.botIdentity.toLowerCase()
  ) {
    return { run: false, reason: "event actor is the bot itself" };
  }
  if (
    !input.onDemand &&
    input.headSha !== undefined &&
    input.lastReviewedSha !== undefined &&
    input.headSha === input.lastReviewedSha
  ) {
    return { run: false, reason: `head SHA ${input.headSha} was already reviewed` };
  }
  return { run: true };
}
