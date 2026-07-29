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
  Severity,
  SkippedFile,
  SuppressedFinding,
} from "./types";
import { bySeverityDesc } from "./types";

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

/**
 * Deterministic risk signals for the at-a-glance risk verdict (feature #9b).
 * All reused from work the pipeline already did: `riskyPaths` from escalate.ts
 * (the routing signal, previously discarded), plus diff-size stats. Zero extra
 * LLM cost — it cannot regress precision.
 */
export interface RiskSignals {
  /** Changed paths flagged risky by escalate.ts (auth/payment/…); [] when none. */
  riskyPaths: string[];
  /** Files reviewed this run. */
  filesChanged: number;
  /** Added+removed lines reviewed this run. */
  linesChanged: number;
}

export interface SummaryCommentParts {
  headSha?: string;
  /** Repo owner — with `repo` + `headSha`, enables clickable blob permalinks (#9c). */
  owner?: string;
  repo?: string;
  findingsPublished: number;
  /**
   * The findings actually reported this run (inline + file-level), for the
   * severity-grouped table (#9a). Expected severity-first (#9d); rendered in the
   * given order. Absent → no table (back-compat).
   */
  publishedFindings?: Finding[];
  /** Deterministic risk verdict inputs (#9b). Absent → no risk line. */
  risk?: RiskSignals;
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
  /** Count of verifier verdicts whose evidence failed the grounding check (feature #1). */
  verifierUngrounded?: number;
}

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "🔵",
  nit: "⚪",
};

interface LinkParts {
  owner?: string;
  repo?: string;
  headSha?: string;
}

/** A static GitHub blob permalink at the reviewed SHA (no fetch needed). Pure. */
function blobUrl(link: LinkParts, file: string, line?: number): string | undefined {
  if (!link.owner || !link.repo || !link.headSha) return undefined;
  const anchor = line !== undefined ? `#L${line}` : "";
  return `https://github.com/${link.owner}/${link.repo}/blob/${link.headSha}/${file}${anchor}`;
}

/** `` `file`:line `` as a markdown link to the blob when identity is known (#9c). */
function locationMd(link: LinkParts, file: string, line?: number): string {
  const label = `\`${file}\`${line !== undefined ? `:${line}` : ""}`;
  const url = blobUrl(link, file, line);
  return url ? `[${label}](${url})` : label;
}

const bulletLine = (link: LinkParts) => (f: Finding): string =>
  `- ${locationMd(link, f.file, f.line)} — **[${f.severity}]** ${f.title}: ${f.body}`;

/** Deterministic 1–5 review-effort estimate from diff size (#9b). Pure. */
function reviewEffort(filesChanged: number, linesChanged: number): number {
  let score = 1;
  if (linesChanged > 20) score += 1;
  if (linesChanged > 75) score += 1;
  if (linesChanged > 200) score += 1;
  if (linesChanged > 500) score += 1;
  if (filesChanged > 10) score += 1;
  return Math.min(5, score);
}

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/**
 * The at-a-glance risk verdict + review-effort line (#9b). Deterministic: level
 * is driven by critical findings and risky paths; effort by diff size. Pure.
 */
function composeRiskLine(risk: RiskSignals, findings: readonly Finding[]): string {
  const criticals = findings.filter((f) => f.severity === "critical").length;
  const highs = findings.filter((f) => f.severity === "high").length;

  let emoji: string;
  let level: string;
  if (criticals > 0) {
    emoji = "🔴";
    level = "high";
  } else if (risk.riskyPaths.length > 0 || highs > 0) {
    emoji = "🟠";
    level = "elevated";
  } else {
    emoji = "🟢";
    level = "low";
  }

  const reasons: string[] = [];
  if (risk.riskyPaths.length > 0) {
    const names = [...new Set(risk.riskyPaths.map(baseName))];
    const shown = names.slice(0, 3).join(", ");
    reasons.push(`touches sensitive paths (${shown}${names.length > 3 ? ", …" : ""})`);
  }
  const findingBits: string[] = [];
  if (criticals > 0) findingBits.push(`${criticals} critical`);
  if (highs > 0) findingBits.push(`${highs} high`);
  if (findingBits.length > 0) reasons.push(`${findingBits.join(", ")} finding(s)`);

  const effort = reviewEffort(risk.filesChanged, risk.linesChanged);
  const reasonText = reasons.length > 0 ? ` (${reasons.join("; ")})` : "";
  return `**Risk:** ${emoji} ${level}${reasonText} · **Est. review effort:** ${effort}/5`;
}

/**
 * Severity-grouped findings table (#9a): one scannable table sorted
 * critical→nit, each row severity-badged with a clickable location. Collapsed
 * behind a `<details>` block once the list is long, so large PRs stay readable.
 * Pure.
 */
function composeFindingsTable(link: LinkParts, findings: readonly Finding[]): string {
  const sorted = [...findings].sort(bySeverityDesc);
  const rows = sorted
    .map(
      (f) =>
        `| ${SEVERITY_EMOJI[f.severity]} ${f.severity} | ${locationMd(link, f.file, f.line)} | ${f.category} | ${f.title} |`,
    )
    .join("\n");
  const table = `| Severity | Location | Category | Finding |\n| --- | --- | --- | --- |\n${rows}`;
  if (sorted.length > 10) {
    return `<details>\n<summary><strong>${sorted.length} findings</strong> (click to expand)</summary>\n\n${table}\n\n</details>`;
  }
  return table;
}

/** Compose the single upserted summary comment. Pure. */
export function composeSummaryComment(parts: SummaryCommentParts): string {
  const link: LinkParts = { owner: parts.owner, repo: parts.repo, headSha: parts.headSha };
  const renderBullet = bulletLine(link);
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

  // Deterministic at-a-glance risk verdict (#9b) — reuses signals already computed.
  if (parts.risk && !parts.degraded && !parts.nothingReviewable) {
    sections.push(composeRiskLine(parts.risk, parts.publishedFindings ?? []));
  }

  // Severity-grouped, severity-first findings table (#9a/#9d).
  if (parts.publishedFindings && parts.publishedFindings.length > 0) {
    sections.push(composeFindingsTable(link, parts.publishedFindings));
  }

  for (const notice of parts.notices) sections.push(`⚠️ ${notice}`);
  if (parts.earlyStop) {
    sections.push("⚠️ The review stopped early: the per-run token cap was reached. Findings below may be incomplete.");
  }

  if (parts.summaryFindings.length > 0) {
    sections.push(
      "**Findings that could not be attached to the diff** (file not in the diff view):\n" +
        parts.summaryFindings.map(renderBullet).join("\n"),
    );
  }

  if (parts.stillOpen.length > 0) {
    sections.push(
      "**Still open from previous runs** (already reported, not re-posted inline):\n" +
        parts.stillOpen.map(renderBullet).join("\n"),
    );
  }

  if (parts.verifierDropped && parts.verifierDropped.length > 0) {
    // Abstentions (feature #6) are disclosed distinctly from genuine drops:
    // "noticed but could not confirm" is not the same as "this was a false positive".
    const abstained = parts.verifierDropped.filter((d) => d.reason === "insufficient-context");
    const rejected = parts.verifierDropped.filter((d) => d.reason !== "insufficient-context");
    if (rejected.length > 0) {
      sections.push(
        `**Dropped by verification** (${rejected.length}):\n` +
          rejected
            .map((d) => `- \`${d.finding.file}\` — **[${d.reason}]** ${d.finding.title} (evidence: ${d.evidence})`)
            .join("\n"),
      );
    }
    if (abstained.length > 0) {
      sections.push(
        `**Could not confirm — insufficient context** (${abstained.length}):\n` +
          abstained.map((d) => `- \`${d.finding.file}\` — ${d.finding.title}`).join("\n"),
      );
    }
  }

  if (parts.verifierUngrounded && parts.verifierUngrounded > 0) {
    sections.push(
      `⚠️ The verifier could not ground its cited evidence for ${parts.verifierUngrounded} verdict(s); ` +
        "those findings were kept but treat them as lower-confidence.",
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
