/**
 * Summary upsert (task 4.4): exactly ONE summary issue comment per PR,
 * identified by a hidden HTML marker, edited in place on every run. The
 * comment also carries machine-readable state (last-reviewed SHA) that the
 * run gate reads back on the next event (task 4.5) — stateless idempotency.
 * Composition is pure; only `upsertSummaryComment` performs I/O.
 */
import type { FetchLike } from "./diff";
import type { ExistingIssueComment } from "./dedupe";
import type {
  AuthToken,
  DroppedFinding,
  Exclusion,
  Finding,
  PrIdentity,
  SkippedFile,
  SuppressedFinding,
} from "./types";

export const SUMMARY_MARKER = "<!-- ai-review-bot:summary -->";
const STATE_MARKER = /<!--\s*ai-review-bot:state\s+(\{[\s\S]*?\})\s*-->/;

export interface SummaryState {
  sha?: string;
}

export function renderStateMarker(state: SummaryState): string {
  return `<!-- ai-review-bot:state ${JSON.stringify(state)} -->`;
}

export interface FoundSummary {
  commentId: number;
  state: SummaryState;
}

/** Find the bot's summary comment (by marker) and parse its embedded state. */
export function findSummaryComment(issueComments: readonly ExistingIssueComment[]): FoundSummary | undefined {
  for (const comment of issueComments) {
    if (!comment.body.includes(SUMMARY_MARKER)) continue;
    let state: SummaryState = {};
    const match = STATE_MARKER.exec(comment.body);
    if (match) {
      try {
        const parsed: unknown = JSON.parse(match[1]);
        if (parsed !== null && typeof parsed === "object") {
          const sha = (parsed as Record<string, unknown>).sha;
          if (typeof sha === "string") state = { sha };
        }
      } catch {
        // Corrupt state → treat as no state; never crash.
      }
    }
    return { commentId: comment.id, state };
  }
  return undefined;
}

export interface SummaryCommentParts {
  headSha?: string;
  findingsPublished: number;
  degraded: boolean;
  nothingReviewable: boolean;
  /** Findings that could only be mentioned here (not inline / file-level). */
  summaryFindings: Finding[];
  /** Previously reported findings that are still present (deduped this run). */
  stillOpen: Finding[];
  suppressed: SuppressedFinding[];
  skippedFiles: SkippedFile[];
  exclusions: Exclusion[];
  /** Config problems, degraded-mode, budget and early-stop notices. */
  notices: string[];
  earlyStop: boolean;
  /** Findings the verifier dropped (task 6.4) — disclosed, never silent. */
  verifierDropped?: DroppedFinding[];
}

const severityLine = (f: Finding): string =>
  `- \`${f.file}\`${f.line !== undefined ? `:${f.line}` : ""} — **[${f.severity}]** ${f.title}: ${f.body}`;

/** Compose the single upserted summary comment. Pure. */
export function composeSummaryComment(parts: SummaryCommentParts): string {
  const sections: string[] = [SUMMARY_MARKER];

  if (parts.degraded) {
    sections.push(
      "## 🤖 AI review summary\n\n⚠️ The review model returned output that could not be parsed as findings; no inline comments this run.",
    );
  } else if (parts.nothingReviewable) {
    sections.push(
      "## 🤖 AI review summary\n\nℹ️ No reviewable changes after filtering — nothing was sent to the model.",
    );
  } else if (parts.findingsPublished === 0 && parts.summaryFindings.length === 0 && parts.stillOpen.length === 0) {
    sections.push("## 🤖 AI review summary\n\n✅ no issues found");
  } else {
    sections.push(`## 🤖 AI review summary\n\nFound ${parts.findingsPublished} new issue(s) this run.`);
  }

  for (const notice of parts.notices) sections.push(`⚠️ ${notice}`);
  if (parts.earlyStop) {
    sections.push("⚠️ The review stopped early: the per-run token cap was reached. Findings below may be incomplete.");
  }

  if (parts.summaryFindings.length > 0) {
    sections.push(
      "**Findings that could not be attached to the diff** (file not in the diff view):\n" +
        parts.summaryFindings.map(severityLine).join("\n"),
    );
  }

  if (parts.stillOpen.length > 0) {
    sections.push(
      "**Still open from previous runs** (already reported, not re-posted inline):\n" +
        parts.stillOpen.map(severityLine).join("\n"),
    );
  }

  if (parts.verifierDropped && parts.verifierDropped.length > 0) {
    sections.push(
      `**Dropped by verification** (${parts.verifierDropped.length}):\n` +
        parts.verifierDropped
          .map((d) => `- \`${d.finding.file}\` — **[${d.reason}]** ${d.finding.title} (evidence: ${d.evidence})`)
          .join("\n"),
    );
  }

  if (parts.suppressed.length > 0) {
    const byReason = new Map<string, number>();
    for (const s of parts.suppressed) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    sections.push(
      `Suppressed ${parts.suppressed.length} finding(s) before publishing: ` +
        [...byReason].map(([reason, n]) => `${n} ${reason}`).join(", ") +
        ".",
    );
  }

  if (parts.skippedFiles.length > 0) {
    sections.push(
      `Skipped ${parts.skippedFiles.length} file(s): ` +
        parts.skippedFiles.map((s) => `\`${s.file}\` (${s.reason})`).join(", "),
    );
  }

  if (parts.exclusions.length > 0) {
    sections.push(
      "⚠️ **Not reviewed** (size cap):\n" +
        parts.exclusions.map((e) => `- \`${e.file}\` — ${e.whatWasExcluded}`).join("\n"),
    );
  }

  sections.push(renderStateMarker({ sha: parts.headSha }));
  return sections.join("\n\n");
}

const GH_HEADERS = (auth: AuthToken): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${auth}`,
  "content-type": "application/json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "code-review-engine",
});

/**
 * Upsert the summary comment: PATCH the existing marker comment in place, or
 * POST a new one when absent. Exactly one summary comment per PR.
 */
export async function upsertSummaryComment(
  pr: PrIdentity,
  auth: AuthToken,
  body: string,
  existingCommentId: number | undefined,
  fetchImpl: FetchLike,
): Promise<void> {
  const base = `https://api.github.com/repos/${pr.owner}/${pr.repo}`;
  const url =
    existingCommentId !== undefined
      ? `${base}/issues/comments/${existingCommentId}`
      : `${base}/issues/${pr.prNumber}/comments`;
  const res = await fetchImpl(url, {
    method: existingCommentId !== undefined ? "PATCH" : "POST",
    headers: GH_HEADERS(auth),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(
      `upserting summary comment on ${pr.owner}/${pr.repo}#${pr.prNumber} failed: HTTP ${res.status} ${text}`,
    );
  }
}
