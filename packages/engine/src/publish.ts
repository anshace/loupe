/**
 * Batched review publishing: the engine builds ONE review payload per run
 * (pure, tested); `postReview` performs the single POST. Findings without a
 * line (file-level) go into the review body so nothing is silently lost.
 */
import type { FetchLike } from "./diff";
import type { AuthToken, Finding, PrIdentity, ReviewPayload } from "./types";

export function formatFindingComment(finding: Finding): string {
  let body = `**[${finding.severity}] ${finding.title}**\n\n${finding.body}`;
  if (finding.suggestion) body += `\n\n**Suggested fix:**\n${finding.suggestion}`;
  return body;
}

/** Build the single POST /pulls/{n}/reviews payload for a run. Pure. */
export function buildReviewPayload(summary: string, findings: Finding[]): ReviewPayload {
  const comments = findings
    .filter((f): f is Finding & { line: number } => typeof f.line === "number")
    .map((f) => ({
      path: f.file,
      line: f.line,
      side: "RIGHT" as const,
      body: formatFindingComment(f),
    }));
  return { body: summary, event: "COMMENT", comments };
}

/** Submit the batched review — exactly one POST per run. */
export async function postReview(
  pr: PrIdentity,
  auth: AuthToken,
  payload: ReviewPayload,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const url = `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.prNumber}/reviews`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${auth}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "code-review-engine",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`posting review on ${pr.owner}/${pr.repo}#${pr.prNumber} failed: HTTP ${res.status} ${body}`);
  }
}
