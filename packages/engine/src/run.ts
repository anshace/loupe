/**
 * The full M1 review pipeline: fetch diff → parse → noise filter → size cap →
 * prompt → model → JSON guardrail → line clamp → build ONE review payload →
 * post (injectable/skippable for dry runs and tests).
 */
import type { CommentableMap } from "./clamp";
import { clampFindings } from "./clamp";
import type { FetchLike } from "./diff";
import { fetchPrDiff, parseUnifiedDiff } from "./diff";
import { parseModelFindings } from "./guardrail";
import type { ReviewModel } from "./model";
import { GeminiFlashProvider } from "./model";
import { filterNoise } from "./noise";
import { formatCommentableLines, loadPromptTemplate, renderPrompt } from "./prompt";
import { buildReviewPayload, postReview } from "./publish";
import { applySizeCap } from "./sizeCap";
import type {
  AuthToken,
  EngineConfig,
  Exclusion,
  Finding,
  PrIdentity,
  ReviewPayload,
  ReviewResult,
  SkippedFile,
} from "./types";
import { atLeastSeverity } from "./types";

/** Injectable collaborators, all defaulted for production use. */
export interface RunDeps {
  fetchImpl?: FetchLike;
  model?: ReviewModel;
  /** Bypass file loading entirely (tests). */
  promptTemplate?: string;
  /** Replace the posting step (tests / alternate transports). */
  post?: (pr: PrIdentity, auth: AuthToken, payload: ReviewPayload) => Promise<void>;
}

export interface SummaryParts {
  findings: Finding[];
  skippedFiles: SkippedFile[];
  exclusions: Exclusion[];
  degraded: boolean;
  nothingReviewable: boolean;
}

/** Build the review body. Skips and truncation are always disclosed — never silent. */
export function buildSummary(parts: SummaryParts): string {
  const sections: string[] = [];

  if (parts.degraded) {
    sections.push(
      "⚠️ The review model returned output that could not be parsed as findings; no inline comments this run.",
    );
  } else if (parts.nothingReviewable) {
    sections.push("ℹ️ No reviewable changes after filtering — nothing was sent to the model.");
  } else if (parts.findings.length === 0) {
    sections.push("✅ no issues found");
  } else {
    const inline = parts.findings.filter((f) => f.line !== undefined).length;
    sections.push(`🤖 AI review found ${parts.findings.length} issue(s) (${inline} inline).`);
  }

  const fileLevel = parts.findings.filter((f) => f.line === undefined);
  if (fileLevel.length > 0) {
    sections.push(
      "**File-level findings** (could not be anchored to a diff line):\n" +
        fileLevel
          .map((f) => `- \`${f.file}\` — **[${f.severity}]** ${f.title}: ${f.body}`)
          .join("\n"),
    );
  }

  if (parts.skippedFiles.length > 0) {
    sections.push(
      `Skipped ${parts.skippedFiles.length} noise file(s): ` +
        parts.skippedFiles.map((s) => `\`${s.file}\` (${s.reason})`).join(", "),
    );
  }

  if (parts.exclusions.length > 0) {
    sections.push(
      "⚠️ **Not reviewed** (size cap):\n" +
        parts.exclusions.map((e) => `- \`${e.file}\` — ${e.whatWasExcluded}`).join("\n"),
    );
  }

  return sections.join("\n\n");
}

/** Run the full single-pass review pipeline for one PR. */
export async function runReview(
  pr: PrIdentity,
  auth: AuthToken,
  config: EngineConfig = {},
  deps: RunDeps = {},
): Promise<ReviewResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const diffText = await fetchPrDiff(pr, auth, fetchImpl);
  const files = parseUnifiedDiff(diffText);
  const { kept: afterNoise, skipped } = filterNoise(files);
  const { kept, exclusions } = applySizeCap(afterNoise, config.sizeCap);

  let findings: Finding[] = [];
  let degraded = false;
  let usage: ReviewResult["usage"];
  const nothingReviewable = kept.length === 0;

  if (!nothingReviewable) {
    const template = deps.promptTemplate ?? loadPromptTemplate(config.promptPath);
    const rendered = renderPrompt(template, {
      DIFF: kept.map((f) => f.rawText).join("\n"),
      COMMENTABLE_LINES: formatCommentableLines(kept),
    });

    const model = deps.model ?? new GeminiFlashProvider({ fetchImpl });
    const response = await model.complete(rendered);
    usage = {
      model: model.name,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };

    const guard = parseModelFindings(response.text);
    degraded = guard.degraded;

    const commentable: CommentableMap = Object.fromEntries(
      kept.map((f) => [f.path, f.commentableLines]),
    );
    findings = clampFindings(guard.findings, commentable);
    if (config.minSeverity) {
      const min = config.minSeverity;
      findings = findings.filter((f) => atLeastSeverity(f.severity, min));
    }
  }

  const summary = buildSummary({ findings, skippedFiles: skipped, exclusions, degraded, nothingReviewable });
  const payload = buildReviewPayload(summary, findings);

  let posted = false;
  if (!config.dryRun) {
    const post = deps.post ?? ((p, a, pl) => postReview(p, a, pl, fetchImpl));
    await post(pr, auth, payload);
    posted = true;
  }

  return { findings, summary, skippedFiles: skipped, exclusions, degraded, payload, posted, usage };
}
