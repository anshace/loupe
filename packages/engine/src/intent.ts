/**
 * PR-intent context (feature #3). One REST call — GET /repos/{o}/{r}/pulls/{n}
 * with the JSON accept header — yields the PR title + body; the body is
 * regex-scanned for GitHub's closing keywords ("fixes #12") to list linked
 * issues. Rendered as the {{PR_INTENT}} reviewer prompt block so the model can
 * judge the diff against what the author says it does.
 *
 * Everything here is fail-soft: any fetch/parse error returns undefined and the
 * pipeline omits the block — PR intent is helpful context, never a hard input.
 * The parsers are pure and tested; only `fetchPrIntent` touches the network.
 */
import type { FetchLike } from "./diff";
import type { AuthToken, PrIdentity, PrIntent } from "./types";

/**
 * GitHub's own closing keywords, per its docs: close/closes/closed,
 * fix/fixes/fixed, resolve/resolves/resolved, followed by `#<number>`.
 */
const CLOSING_KEYWORDS = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;

/** Extract closing-keyword-linked issue numbers from a PR body. Pure. */
export function parseLinkedIssues(body: string | undefined): number[] {
  if (!body) return [];
  const out = new Set<number>();
  for (const match of body.matchAll(CLOSING_KEYWORDS)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

/**
 * Render the {{PR_INTENT}} block, or undefined when there is nothing to show
 * (so run.ts can substitute "(none)" and omit the block per fail-soft). Pure.
 */
export function renderPrIntent(intent: PrIntent | undefined): string | undefined {
  if (!intent) return undefined;
  const parts: string[] = [];
  if (intent.title?.trim()) parts.push(`Title: ${intent.title.trim()}`);
  if (intent.body?.trim()) parts.push(`Description:\n${intent.body.trim()}`);
  if (intent.linkedIssues.length > 0) {
    parts.push(`Linked issues (closed by this PR): ${intent.linkedIssues.map((n) => `#${n}`).join(", ")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Fetch the PR's title + body and derive its linked issues. Returns undefined
 * on any error or when the response is unusable — the caller then omits the
 * block. Never throws.
 */
export async function fetchPrIntent(
  pr: PrIdentity,
  auth: AuthToken,
  fetchImpl: FetchLike,
): Promise<PrIntent | undefined> {
  const url = `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.prNumber}`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${auth}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "code-review-engine",
      },
    });
    if (!res.ok) return undefined;
    const parsed: unknown = JSON.parse(await res.text());
    if (parsed === null || typeof parsed !== "object") return undefined;
    const obj = parsed as Record<string, unknown>;
    const title = typeof obj.title === "string" ? obj.title : undefined;
    const body = typeof obj.body === "string" ? obj.body : undefined;
    if (title === undefined && body === undefined) return undefined;
    return { title, body, linkedIssues: parseLinkedIssues(body) };
  } catch {
    return undefined;
  }
}
