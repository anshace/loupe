/**
 * Batched review publishing: the engine builds ONE review payload per run
 * (pure, tested); `postReview` performs the single POST. Findings without a
 * line (file-level) go into the review body so nothing is silently lost.
 */
import type { AnchoredFinding, CommentableMap } from "./clamp";
import type { FetchLike } from "./diff";
import type { AuthToken, Finding, PrIdentity, ReviewComment, ReviewPayload } from "./types";

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

/** Render a committable single- or multi-line replacement as a GitHub ```suggestion block. */
export function renderSuggestionBlock(code: string): string {
  const fence = suggestionFence(code);
  return `${fence}suggestion\n${code}\n${fence}`;
}

/**
 * How a finding's fix is rendered in its comment body:
 *   "range"  — a validated CONTIGUOUS multi-line committable ```suggestion from
 *              `suggestedRange` (feature #18); the comment must carry
 *              start_line/start_side anchoring the whole range.
 *   "line"   — a validated single-line committable ```suggestion from
 *              `suggestedLine` (feature #7).
 *   "prose"  — the free-text `suggestion`, or nothing.
 * The boolean form is kept for back-compat: `true` → "line", `false` → "prose".
 */
export type SuggestionMode = "range" | "line" | "prose";

/**
 * Format one finding's comment body. The suggestion is rendered as a committable
 * GitHub ```suggestion block only in "range"/"line" mode (and only when the
 * matching field is present); otherwise the free-text `suggestion` prose is used.
 * A committable mode must be chosen ONLY for a finding whose anchor is EXACT — a
 * clamped/nearest anchor points at a different line, so applying a swap there
 * would be wrong (buildReviewPayload enforces this).
 */
export function formatFindingComment(finding: Finding, mode: SuggestionMode | boolean = "prose"): string {
  const resolved: SuggestionMode = mode === true ? "line" : mode === false ? "prose" : mode;
  let body = `**[${finding.severity}] ${finding.title}**\n\n${finding.body}`;
  if (resolved === "range" && finding.suggestedRange) {
    body += `\n\n**Suggested fix:**\n${renderSuggestionBlock(finding.suggestedRange)}`;
  } else if (resolved === "line" && finding.suggestedLine) {
    body += `\n\n**Suggested fix:**\n${renderSuggestionBlock(finding.suggestedLine)}`;
  } else if (finding.suggestion) {
    body += `\n\n**Suggested fix:**\n${finding.suggestion}`;
  }
  return body;
}

/**
 * Validate a contiguous multi-line committable range (feature #18). Returns the
 * `{ start, end }` anchor line pair when the finding is eligible for a range
 * ```suggestion, else undefined (caller then tries single-line, then prose).
 *
 * Eligible requires ALL of:
 *   - a `suggestedRange` (the multi-line replacement text),
 *   - a `startLine` and a numeric `line` (the END), with startLine < line
 *     (a real ≥2-line range — a single line is the `suggestedLine` case),
 *   - EVERY integer line in `[startLine..line]` is an exact commentable
 *     RIGHT-side line for the file (no gaps — GitHub rejects a range whose
 *     interior isn't part of the diff, and a partial range would apply wrong).
 * The END line is assumed already validated as exact by anchoring ("line"
 * placement); this re-checks it against the map anyway for safety.
 */
export function committableRange(
  finding: Finding,
  commentable: CommentableMap,
): { start: number; end: number } | undefined {
  const end = finding.line;
  const start = finding.startLine;
  if (typeof end !== "number" || typeof start !== "number") return undefined;
  if (!finding.suggestedRange) return undefined;
  if (start >= end) return undefined; // must be a real multi-line range
  const lines = commentable[finding.file];
  if (!lines || lines.length === 0) return undefined;
  const set = new Set(lines);
  for (let ln = start; ln <= end; ln++) {
    if (!set.has(ln)) return undefined; // a gap → not a clean contiguous RIGHT-side range
  }
  return { start, end };
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
 * ("line") anchor is eligible for a committable ```suggestion block (features
 * #7/#18); a "nearest" anchor was clamped to a different line and gets prose
 * only. When `commentable` is supplied, an exact-anchored finding carrying a
 * validated contiguous `suggestedRange` (feature #18) becomes a MULTI-LINE range
 * suggestion (start_line/start_side + line/side); it falls back to a single-line
 * suggestion, then prose, the moment the range isn't a clean commentable swap.
 * Comments are emitted in the given order — the caller sorts severity-first
 * (feature #9d). File-level ("file") and summary anchors carry no inline line
 * and are rendered elsewhere (review body / summary comment).
 */
export function buildReviewPayload(
  summary: string,
  findings: readonly AnchoredFinding[],
  commentable: CommentableMap = {},
): ReviewPayload {
  const comments: ReviewComment[] = [];
  for (const a of findings) {
    const line = a.finding.line;
    if ((a.placement !== "line" && a.placement !== "nearest") || typeof line !== "number") continue;
    // Multi-line committable range (#18) — ONLY for an exact ("line") anchor,
    // and only when the whole range validates as contiguous commentable lines.
    const range = a.placement === "line" ? committableRange(a.finding, commentable) : undefined;
    if (range) {
      comments.push({
        path: a.finding.file,
        startLine: range.start,
        startSide: "RIGHT",
        line: range.end,
        side: "RIGHT",
        body: formatFindingComment(a.finding, "range"),
      });
    } else {
      comments.push({
        path: a.finding.file,
        line,
        side: "RIGHT",
        body: formatFindingComment(a.finding, a.placement === "line"),
      });
    }
  }
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
