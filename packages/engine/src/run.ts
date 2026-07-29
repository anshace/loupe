/**
 * The full M2 review pipeline:
 *   gate (draft/bot-actor/same-SHA) → repo config (.aireview.toml at head) →
 *   diff fetch/parse → ignore-globs + noise filter + size cap →
 *   prompt (reviewer-v2 + HOUSE_RULES) → model (selected provider, cost caps) →
 *   JSON guardrail → suppression filter → anchoring chain → stateless dedupe →
 *   ONE batched review + ONE upserted summary comment (marker + state SHA).
 *
 * Invariant (task 4.2): no finding is ever silently dropped — every guardrail
 * finding ends up in payload comments, the review body (file-level), the
 * summary comment, the suppression record, or the dedupe record.
 */
import type { AnchoredFinding, CommentableMap } from "./clamp";
import { anchorFindings } from "./clamp";
import type { RepoConfig } from "./config";
import {
  AIREVIEW_CONFIG_PATH,
  DEFAULT_REPO_CONFIG,
  HOUSE_RULES_PATH,
  fetchRepoFile,
  globMatch,
  parseAireviewToml,
} from "./config";
import type { LedgerIo } from "./cost";
import { CostTracker, isOverMonthlyBudget, monthKey, recordSpend } from "./cost";
import type { ExistingComments } from "./dedupe";
import { dedupeFindings, fetchExistingComments } from "./dedupe";
import type { FetchLike } from "./diff";
import { fetchPrDiff, parseUnifiedDiff } from "./diff";
import { shouldRun } from "./gate";
import { parseModelFindings } from "./guardrail";
import type { ReviewModel } from "./model";
import { FREE_TIER_PROVIDER, resolveProviderChoice, selectProvider } from "./model";
import { filterNoise } from "./noise";
import { formatCommentableLines, loadPromptTemplate, renderPrompt } from "./prompt";
import { buildReviewPayload, formatFileLevelSections, postReview } from "./publish";
import { composeSummaryComment, findSummaryComment, upsertSummaryComment } from "./summary";
import { applySuppressions } from "./suppress";
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
  SuppressedFinding,
} from "./types";

/**
 * Repo-committed files the pipeline reads from the PR head. Tests (and
 * alternate transports) inject them; production fetches via the contents API.
 * An explicitly provided object with an undefined field means "file absent".
 */
export interface RepoFiles {
  /** Raw .aireview.toml content, or undefined when absent. */
  config?: string;
  /** Raw HOUSE_RULES.md content, or undefined when absent. */
  houseRules?: string;
}

/** Injectable collaborators, all defaulted for production use. */
export interface RunDeps {
  fetchImpl?: FetchLike;
  model?: ReviewModel;
  /** Bypass file loading entirely (tests). */
  promptTemplate?: string;
  /** Replace the review posting step (tests / alternate transports). */
  post?: (pr: PrIdentity, auth: AuthToken, payload: ReviewPayload) => Promise<void>;
  /** Replace the summary upsert step (tests / alternate transports). */
  upsertSummary?: (pr: PrIdentity, auth: AuthToken, body: string, existingCommentId?: number) => Promise<void>;
  /** Bypass fetching the repo's committed config/house-rules files (tests). */
  repoFiles?: RepoFiles;
  /** Bypass fetching the PR's existing bot comments (tests). */
  existingComments?: ExistingComments;
  /** Environment for provider selection + monthly budget (default process.env). */
  env?: Record<string, string | undefined>;
  /** Ledger file IO overrides (tests). */
  ledgerIo?: LedgerIo;
  /** Clock (tests). */
  now?: () => Date;
}

export interface SummaryParts {
  findings: Finding[];
  skippedFiles: SkippedFile[];
  exclusions: Exclusion[];
  degraded: boolean;
  nothingReviewable: boolean;
}

/** Build the review body headline. Skips and truncation are always disclosed. */
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
  if (fileLevel.length > 0) sections.push(formatFileLevelSections(fileLevel));

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

function emptyResult(reason: string): ReviewResult {
  return {
    findings: [],
    summary: "",
    skippedFiles: [],
    exclusions: [],
    degraded: false,
    payload: { body: "", event: "COMMENT", comments: [] },
    posted: false,
    skipped: { reason },
    suppressed: [],
    deduped: [],
    summaryFindings: [],
    notices: [],
    earlyStop: false,
  };
}

interface LoadedRepoConfig {
  repoConfig: RepoConfig;
  houseRules?: string;
  notices: string[];
}

async function loadRepoConfig(
  pr: PrIdentity,
  auth: AuthToken,
  headSha: string | undefined,
  fetchImpl: FetchLike,
  injected?: RepoFiles,
): Promise<LoadedRepoConfig> {
  const files: RepoFiles =
    injected ?? {
      config: await fetchRepoFile(pr, auth, AIREVIEW_CONFIG_PATH, headSha, fetchImpl),
      houseRules: await fetchRepoFile(pr, auth, HOUSE_RULES_PATH, headSha, fetchImpl),
    };

  if (files.config === undefined) {
    // Missing file → documented safe defaults, no notice (4.8).
    return { repoConfig: { ...DEFAULT_REPO_CONFIG }, houseRules: files.houseRules, notices: [] };
  }
  const parsed = parseAireviewToml(files.config);
  const notices = parsed.invalid
    ? [`invalid .aireview.toml — running on safe defaults (${parsed.problems.join("; ")})`]
    : [];
  return { repoConfig: parsed.config, houseRules: files.houseRules, notices };
}

/** Run the full review pipeline for one PR. */
export async function runReview(
  pr: PrIdentity,
  auth: AuthToken,
  config: EngineConfig = {},
  deps: RunDeps = {},
): Promise<ReviewResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());

  // ── Existing bot comments: gate state + dedupe corpus (stateless, decision 6).
  const existing =
    deps.existingComments ?? (await fetchExistingComments(pr, auth, fetchImpl, config.botIdentity));
  const existingSummary = findSummaryComment(existing.issueComments);

  // ── Gate (4.5): draft PRs, self-generated events, already-reviewed SHA.
  const gate = shouldRun({
    isDraft: config.event?.isDraft,
    actor: config.event?.actor,
    botIdentity: config.botIdentity,
    headSha: config.event?.headSha,
    lastReviewedSha: existingSummary?.state.sha,
    onDemand: config.event?.onDemand,
  });
  if (!gate.run) return emptyResult(gate.reason);

  // ── Repo config from the reviewed revision (4.6–4.8) + house rules (4.9).
  const { repoConfig, houseRules, notices } = await loadRepoConfig(
    pr,
    auth,
    config.event?.headSha,
    fetchImpl,
    deps.repoFiles,
  );
  if (!repoConfig.enabled) {
    // Disabled → the run ends before any model call; no comments at all (4.7).
    return emptyResult("reviews disabled by .aireview.toml");
  }
  const minSeverity = config.minSeverity ?? repoConfig.minSeverity;

  // ── Diff → ignore globs → noise filter → size caps.
  const diffText = await fetchPrDiff(pr, auth, fetchImpl);
  const files = parseUnifiedDiff(diffText);

  const skipped: SkippedFile[] = [];
  const afterIgnore = files.filter((file) => {
    if (repoConfig.ignore.some((glob) => globMatch(glob, file.path))) {
      skipped.push({ file: file.path, reason: "ignored" });
      return false;
    }
    return true;
  });
  const { kept: afterNoise, skipped: noiseSkipped } = filterNoise(afterIgnore);
  skipped.push(...noiseSkipped);
  const { kept, exclusions } = applySizeCap(afterNoise, config.sizeCap);

  // ── Provider selection (4.10) + monthly budget degrade (4.11).
  let model = deps.model;
  if (!model) {
    let choice = resolveProviderChoice(env);
    if (isOverMonthlyBudget(env, config.ledgerPath, now(), deps.ledgerIo)) {
      if (choice !== FREE_TIER_PROVIDER) {
        notices.push("monthly budget exceeded — degraded to the free-tier model for this run");
      }
      choice = FREE_TIER_PROVIDER;
    }
    model = selectProvider(choice, fetchImpl);
  }
  const tracker = new CostTracker(config.tokenCaps);

  let rawFindings: Finding[] = [];
  let degraded = false;
  let earlyStop = false;
  let usage: ReviewResult["usage"];
  const nothingReviewable = kept.length === 0;

  if (!nothingReviewable) {
    if (!tracker.canProceed()) {
      earlyStop = true;
    } else {
      const template = deps.promptTemplate ?? loadPromptTemplate(config.promptPath);
      const rendered = renderPrompt(template, {
        DIFF: kept.map((f) => f.rawText).join("\n"),
        COMMENTABLE_LINES: formatCommentableLines(kept),
        HOUSE_RULES: houseRules?.trim() ? houseRules.trim() : "(none)",
      });

      const response = await model.complete(rendered);
      usage = { model: model.name, inputTokens: response.inputTokens, outputTokens: response.outputTokens };
      earlyStop = tracker.record(model.name, response.inputTokens, response.outputTokens);

      const guard = parseModelFindings(response.text);
      degraded = guard.degraded;
      rawFindings = guard.findings;
    }
  }

  // ── Suppression (4.1, 4.7, 4.9): do-not-report + house rules + min severity.
  const addedLines: Record<string, readonly number[]> = Object.fromEntries(
    kept.map((f) => [
      f.path,
      f.hunks.flatMap((h) => h.lines.filter((l) => l.type === "add").map((l) => l.newLine as number)),
    ]),
  );
  // Findings must never be reported against ignored-glob files (4.7), even if
  // the model hallucinates one — recorded explicitly, never silently dropped.
  const notIgnored: Finding[] = [];
  const ignoredFindings: SuppressedFinding[] = [];
  for (const f of rawFindings) {
    if (repoConfig.ignore.some((glob) => globMatch(glob, f.file))) {
      ignoredFindings.push({ finding: f, reason: "ignored-file" });
    } else {
      notIgnored.push(f);
    }
  }

  const { kept: unsuppressed, suppressed } = applySuppressions(notIgnored, {
    minSeverity,
    houseRules,
    addedLines,
  });
  suppressed.push(...ignoredFindings);

  // ── Anchoring chain (4.2): line → nearest → file-level → summary mention.
  const commentable: CommentableMap = Object.fromEntries(kept.map((f) => [f.path, f.commentableLines]));
  const anchored = anchorFindings(unsuppressed, commentable);

  // ── Stateless dedupe (4.3): skip findings already reported by the bot.
  const dedupeCorpus = [
    ...existing.reviewComments,
    ...existing.issueComments.map((c) => ({ body: c.body })),
  ];
  const { kept: fresh, deduped } = dedupeFindings(anchored, dedupeCorpus);

  const publishable = fresh.filter((a: AnchoredFinding) => a.placement !== "summary").map((a) => a.finding);
  const summaryFindings = fresh.filter((a) => a.placement === "summary").map((a) => a.finding);
  const findings = fresh.map((a) => a.finding);

  // ── One batched review (body headline + file-level sections + inline comments).
  const reviewBody = buildSummary({
    findings: publishable,
    skippedFiles: skipped,
    exclusions,
    degraded,
    nothingReviewable,
  });
  const payload = buildReviewPayload(reviewBody, publishable);

  // ── One upserted summary comment with hidden marker + state SHA (4.4/4.5).
  const summaryComment = composeSummaryComment({
    headSha: config.event?.headSha,
    findingsPublished: publishable.length + summaryFindings.length,
    degraded,
    nothingReviewable,
    summaryFindings,
    stillOpen: deduped,
    suppressed,
    skippedFiles: skipped,
    exclusions,
    notices,
    earlyStop,
  });

  let posted = false;
  if (!config.dryRun) {
    const post = deps.post ?? ((p, a, pl) => postReview(p, a, pl, fetchImpl));
    await post(pr, auth, payload);
    const upsert =
      deps.upsertSummary ??
      ((p: PrIdentity, a: AuthToken, body: string, id?: number) => upsertSummaryComment(p, a, body, id, fetchImpl));
    await upsert(pr, auth, summaryComment, existingSummary?.commentId);
    posted = true;
  }

  // ── Monthly spend ledger (best-effort; absent path → per-run caps only).
  if (config.ledgerPath && tracker.spentUsd > 0) {
    recordSpend(config.ledgerPath, monthKey(now()), tracker.spentUsd, deps.ledgerIo);
  }

  return {
    findings,
    summary: reviewBody,
    skippedFiles: skipped,
    exclusions,
    degraded,
    payload,
    posted,
    usage,
    suppressed,
    deduped,
    summaryFindings,
    notices,
    earlyStop,
    summaryComment,
  };
}
