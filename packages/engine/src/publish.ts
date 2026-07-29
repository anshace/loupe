/**
 * Batched review publishing: the engine builds ONE review payload per run
 * (pure, tested); `postReview` performs the single POST. Findings without a
 * line (file-level) go into the review body so nothing is silently lost.
 */
import type { AnchoredFinding } from "./clamp";
import type { FetchLike } from "./diff";
import type { AuthToken, Finding, PrIdentity, ReviewPayload } from "./types";

/**
 * The GitHub suggestion fence (feature #7). GitHub renders a one-click
 * "Commit suggestion" button for a fenced block whose info string is exactly
 * `suggestion`. If the replacement code itself contains a run of backticks the
 * outer fence MUST be longer than the longest inner run, or the block truncates
 * early / corrupts (documented GitHub markdown collision). We therefore escalate
 * the fence to (longest inner backtick run + 1), never fewer than three.
 */
function suggestionFence(code: string): string {
  let longest = 0;
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** Render a committable single-line replacement as a GitHub ```suggestion block. */
export function renderSuggestionBlock(code: string): string {
  const fence = suggestionFence(code);
  return `${fence}suggestion\n${code}\n${fence}`;
}

/**
 * Format one finding's comment body. When `committable` is true and the finding
 * carries a validated single-line `suggestedLine`, the fix is rendered as a
 * GitHub ```suggestion block (one-click apply); otherwise the free-text
 * `suggestion` prose is used. `committable` must be set ONLY for a finding
 * anchored to an EXACT commentable line — a clamped/nearest anchor points at a
 * different line, so applying a same-line swap there would be wrong.
 */
export function formatFindingComment(finding: Finding, committable = false): string {
  let body = `**[${finding.severity}] ${finding.title}**\n\n${finding.body}`;
  if (committable && finding.suggestedLine) {
    body += `\n\n**Suggested fix:**\n${renderSuggestionBlock(finding.suggestedLine)}`;
  } else if (finding.suggestion) {
    body += `\n\n**Suggested fix:**\n${finding.suggestion}`;
  }
  return body;
}

/**
 * Render file-level findings (anchoring fell back to "file") as per-file
 * sections for the review body — part of the no-finding-lost chain (4.2).
 */
export function formatFileLevelSections(findings: Finding[]): string {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  const sections: string[] = [];
  for (const [file, list] of byFile) {
    sections.push(
      `**\`${file}\`** (file-level — could not be anchored to a diff line):\n` +
        list.map((f) => `- **[${f.severity}]** ${f.title}: ${f.body}`).join("\n"),
    );
  }
  return sections.join("\n\n");
}

/**
 * Build the single POST /pulls/{n}/reviews payload for a run. Pure.
 *
 * Takes ANCHORED findings so it knows each one's placement: only an EXACT
 * ("line") anchor is eligible for a committable ```suggestion block (feature
 * #7); a "nearest" anchor was clamped to a different line and gets prose only.
 * Comments are emitted in the given order — the caller sorts severity-first
 * (feature #9d). File-level ("file") and summary anchors carry no inline line
 * and are rendered elsewhere (review body / summary comment).
 */
export function buildReviewPayload(summary: string, findings: readonly AnchoredFinding[]): ReviewPayload {
  const comments = findings
    .filter(
      (a): a is AnchoredFinding & { finding: Finding & { line: number } } =>
        (a.placement === "line" || a.placement === "nearest") && typeof a.finding.line === "number",
    )
    .map((a) => ({
      path: a.finding.file,
      line: a.finding.line,
      side: "RIGHT" as const,
      body: formatFindingComment(a.finding, a.placement === "line"),
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
