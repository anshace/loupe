/**
 * The full M5 review pipeline:
 *   prior state (StateStore → summary-marker fallback, 7.1) →
 *   gate (draft/bot-actor/same-SHA) → repo config (.aireview.toml at head,
 *   incl. custom rules 7.4) → incremental scope decision (before..after
 *   compare, 7.2) → diff fetch/parse → already-reviewed hunk-hash skip (7.2)
 *   → ignore-globs + noise filter + size cap → enclosing-scope context (6.1)
 *   + optional retrieved context (7.6) → provider selection + risk escalation
 *   (6.5) → reviewer (reviewer-v4, optional capped agentic tool loop, 6.3) →
 *   JSON guardrail → verifier pass (6.4, fail-open, optional) →
 *   suppression filter → anchoring chain → stateless dedupe →
 *   still-open carry-forward (7.3) →
 *   ONE batched review + ONE upserted summary comment (marker + state SHA) →
 *   persist new PR state (7.1) + append run-log record (7.5).
 * Reviewer, verifier, and agentic hops share ONE per-run cost cap (6.6):
 * when it would be exceeded, verifier/agentic work is skipped with a summary
 * disclosure — never a hard failure.
 *
 * Invariant (task 4.2): no finding is ever silently dropped — every guardrail
 * finding ends up in payload comments, the review body (file-level), the
 * summary comment, the suppression record, the dedupe record, or the
 * verifier-drop record (which always carries reason + evidence).
 */
import type { AgenticOptions, RepoReader } from "./agentic";
import { agenticComplete, githubRepoReader, newAgenticUsage } from "./agentic";
import type { AnchoredFinding, CommentableMap } from "./clamp";
import { anchorFindings } from "./clamp";
import type { RepoConfig } from "./config";
import {
  AIREVIEW_CONFIG_PATH,
  DEFAULT_REPO_CONFIG,
  HOUSE_RULES_PATH,
  applicableRules,
  fetchRepoFile,
  globMatch,
  parseAireviewToml,
} from "./config";
import type { LedgerIo } from "./cost";
import { CostTracker, isOverMonthlyBudget, monthKey, recordSpend } from "./cost";
import type { ExistingComments } from "./dedupe";
import { dedupeFindings, fetchExistingComments, groupNearDuplicates } from "./dedupe";
import type { FetchLike } from "./diff";
import { fetchPrDiff, parseUnifiedDiff } from "./diff";
import { ESCALATION_MODEL, riskyPaths, shouldEscalate } from "./escalate";
import { shouldRun } from "./gate";
import { decideScope, dropReviewedHunks, fetchCompareDiff } from "./incremental";
import type { Retriever } from "./retrieve";
import { DEFAULT_RETRIEVAL_TOP_K, buildRetrievalQuery, renderRetrievedContext } from "./retrieve";
import type { RunLogIo } from "./runlog";
import { appendRunLog } from "./runlog";
import type { PrState, StateStore } from "./state";
import {
  MAX_OPEN_FINDINGS,
  MAX_TRACKED_HUNK_HASHES,
  carryForwardOpenFindings,
  hashHunks,
  mergeFindings,
  prStateKey,
} from "./state";
import { parseModelFindings, parseToolCalls } from "./guardrail";
import type { ProviderChoice, ReviewModel } from "./model";
import {
  FREE_TIER_PROVIDER,
  buildProvider,
  providerChoiceConfig,
  resolveProviderChoice,
  selectProvider,
} from "./model";
import { filterNoise } from "./noise";
import { DEFAULT_IMPORT_SCAN_CAPS, collectSignatureChangeCallers } from "./importgraph";
import { scanSecrets } from "./secrets";
import { checkWorkflows } from "./workflowcheck";
import { fetchPrIntent, renderPrIntent } from "./intent";
import { buildSecurityChecklist, formatCommentableLines, loadPromptTemplate, renderPrompt } from "./prompt";
import type { ScopeExpander } from "./scope";
import { RegexScopeExpander, buildContext } from "./scope";
import type { ScopeInput } from "./scope";
import {
  VERIFIER_PROMPT_FILE,
  applyVerdicts,
  buildGroundingSource,
  formatFindingsForVerifier,
  parseVerifierOutput,
} from "./verify";
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
  PrIntent,
  ReviewPayload,
  ReviewResult,
  SkippedFile,
  SuppressedFinding,
} from "./types";
import { bySeverityDesc } from "./types";

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
  /**
   * Full file contents at the PR head, keyed by path (tests / alternate
   * transports). When provided, it is authoritative: a missing key means
   * "file unavailable" and NO contents-API fetch is attempted.
   */
  headFiles?: Record<string, string | undefined>;
  /** Replace the enclosing-scope expander (e.g. tree-sitter from packages/scope-ts). */
  scopeExpander?: ScopeExpander;
  /** Bypass loading prompts/verifier-v1.md (tests / Workers path). */
  verifierTemplate?: string;
  /** Replace the agentic repo reader (tests). */
  repoReader?: RepoReader;
  /** Environment for provider selection + monthly budget (default process.env). */
  env?: Record<string, string | undefined>;
  /** Ledger file IO overrides (tests). */
  ledgerIo?: LedgerIo;
  /** Clock (tests). */
  now?: () => Date;
  /**
   * Durable per-PR state (task 7.1): KvStateStore on the Worker path,
   * FileStateStore on the Action path. Absent → stateless mode (the summary
   * marker remains the only, SHA-only state source).
   */
  stateStore?: StateStore;
  /** Run-log file IO overrides (tests). */
  runLogIo?: RunLogIo;
  /** Retrieval implementation for the RAG experiment (task 7.6, packages/rag). */
  retriever?: Retriever;
  /**
   * Pre-fetched PR intent (feature #3). When provided (even as an explicit
   * undefined via a set key), NO GET /pulls/{n} call is made — tests inject it;
   * production fetches it when `config.prIntent` is on.
   */
  prIntent?: PrIntent;
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
    stillOpen: [],
    summaryFindings: [],
    notices: [],
    earlyStop: false,
  };
}

/**
 * The stronger model to escalate a risky diff to, or undefined when escalation
 * can't be resolved. An explicit escalationModel wins for any protocol; failing
 * that, only the anthropic protocol (or the haiku shortcut) has a known default
 * (Sonnet). An arbitrary OpenAI-compatible endpoint has no guessable upgrade.
 */
function escalationTarget(config: EngineConfig, backCompatChoice?: ProviderChoice): string | undefined {
  if (config.escalationModel) return config.escalationModel;
  if (config.provider === "anthropic" || backCompatChoice === "haiku") return ESCALATION_MODEL;
  return undefined;
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
  configPath: string = AIREVIEW_CONFIG_PATH,
): Promise<LoadedRepoConfig> {
  const files: RepoFiles =
    injected ?? {
      config: await fetchRepoFile(pr, auth, configPath, headSha, fetchImpl),
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

  // ── Durable state (7.1): store first, summary-marker SHA as the fallback.
  const stateKey = prStateKey(pr);
  let priorState: PrState | null = null;
  if (deps.stateStore) {
    try {
      priorState = await deps.stateStore.get(stateKey);
    } catch {
      priorState = null; // state reads must never crash a run
    }
  }
  const lastReviewedSha = priorState?.lastReviewedSha ?? existingSummary?.state.sha;

  // ── Gate (4.5): draft PRs, self-generated events, already-reviewed SHA.
  const gate = shouldRun({
    isDraft: config.event?.isDraft,
    actor: config.event?.actor,
    botIdentity: config.botIdentity,
    headSha: config.event?.headSha,
    lastReviewedSha,
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
    config.configPath,
  );
  if (!repoConfig.enabled) {
    // Disabled → the run ends before any model call; no comments at all (4.7).
    return emptyResult("reviews disabled by .aireview.toml");
  }
  const minSeverity = config.minSeverity ?? repoConfig.minSeverity;

  // ── Incremental scope (7.2): before..after compare when a prior review is
  // known and the event carries a before SHA; otherwise the full PR diff.
  const scope = decideScope({
    before: config.event?.before,
    headSha: config.event?.headSha,
    onDemand: config.event?.onDemand,
    lastReviewedSha,
  });
  let diffText: string;
  let incremental: ReviewResult["incremental"];
  if (scope.incremental) {
    try {
      diffText = await fetchCompareDiff(pr, auth, scope.base, scope.head, fetchImpl);
      incremental = { base: scope.base, skippedHunks: 0 };
      notices.push(`incremental review: analyzed only the changes since ${scope.base.slice(0, 7)}`);
    } catch {
      // Compare fetch failure must never kill the run — full diff instead.
      diffText = await fetchPrDiff(pr, auth, fetchImpl);
      notices.push("incremental compare fetch failed — reviewed the full PR diff");
    }
  } else {
    diffText = await fetchPrDiff(pr, auth, fetchImpl);
  }
  let files = parseUnifiedDiff(diffText);
  // Parsed pre-skip files: the coordinate system for carry-forward (7.3).
  const changedFiles = files;

  // ── Already-reviewed hunk skip (7.2): content-hash match against state.
  // Never applied to on-demand runs — /review means "review it again".
  const skipped: SkippedFile[] = [];
  if (priorState && priorState.hunkHashes.length > 0 && !config.event?.onDemand) {
    const drop = dropReviewedHunks(files, new Set(priorState.hunkHashes));
    files = drop.files;
    if (incremental) incremental.skippedHunks = drop.skippedHunks;
    for (const file of drop.fullySkippedFiles) skipped.push({ file, reason: "already-reviewed" });
    if (drop.skippedHunks > 0) {
      notices.push(`skipped ${drop.skippedHunks} already-reviewed hunk(s) (content unchanged since the last run)`);
    }
  }

  // ── Ignore globs → noise filter → size caps.
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

  // ── Provider selection (4.10) + monthly budget degrade (4.11) + escalation (6.5).
  let escalated = false;
  let model = deps.model;
  if (!model) {
    const overBudget = isOverMonthlyBudget(env, config.ledgerPath, now(), deps.ledgerIo);
    // Risky paths (auth/payment/billing/migration/crypto/secret) escalate.
    const risky = (config.escalation ?? true) && shouldEscalate(kept.map((f) => f.path));

    if (config.provider) {
      // ── Unified provider scheme: provider = the wire protocol.
      const base: Parameters<typeof buildProvider>[0] = {
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        fetchImpl,
        env,
      };
      if (overBudget) {
        if (config.provider !== "gemini") {
          notices.push("monthly budget exceeded — degraded to the free-tier model for this run");
        }
        model = buildProvider({ provider: "gemini", fetchImpl, env });
      } else {
        const target = risky ? escalationTarget(config) : undefined;
        if (target) {
          model = buildProvider({ ...base, model: target });
          escalated = true;
          notices.push(`risky paths in this diff — review escalated to ${target}`);
        } else {
          model = buildProvider(base);
        }
      }
    } else {
      // ── Back-compat: REVIEW_MODEL / resolveProviderChoice shortcuts.
      let choice = resolveProviderChoice(env);
      let budgetDegraded = false;
      if (overBudget) {
        if (choice !== FREE_TIER_PROVIDER) {
          notices.push("monthly budget exceeded — degraded to the free-tier model for this run");
        }
        choice = FREE_TIER_PROVIDER;
        budgetDegraded = true;
      }
      const target = !budgetDegraded && risky ? escalationTarget(config, choice) : undefined;
      if (target) {
        // Rebuild the shortcut's provider with the stronger model.
        model = buildProvider({ ...providerChoiceConfig(choice), model: target, fetchImpl, env });
        escalated = true;
        notices.push(`risky paths in this diff — review escalated to ${target}`);
      } else {
        model = selectProvider(choice, fetchImpl);
      }
    }
  }
  const tracker = new CostTracker(config.tokenCaps);

  let rawFindings: Finding[] = [];
  let degraded = false;
  let earlyStop = false;
  let usage: ReviewResult["usage"];
  let verification: ReviewResult["verification"];
  let agenticUsage: ReviewResult["agenticUsage"];
  const nothingReviewable = kept.length === 0;

  if (!nothingReviewable) {
    // ── Enclosing-scope context (6.1): full-file contents at the PR head,
    // expanded to the surrounding function/class, capped, clearly labeled.
    const expander = deps.scopeExpander ?? new RegexScopeExpander();
    const scopeInputs: ScopeInput[] = [];
    for (const file of kept) {
      if (file.isBinary || file.status === "deleted" || file.hunks.length === 0) continue;
      const content = deps.headFiles
        ? deps.headFiles[file.path]
        : await fetchRepoFile(pr, auth, file.path, config.event?.headSha, fetchImpl);
      if (content !== undefined) {
        scopeInputs.push({
          path: file.path,
          content,
          // Expand around the ADDED lines of each hunk — surrounding context
          // lines would drag the span past the actual enclosing scope.
          hunks: file.hunks.map((h) => {
            const added = h.lines
              .filter((l) => l.type === "add" && l.newLine !== undefined)
              .map((l) => l.newLine as number);
            const start = added.length > 0 ? Math.min(...added) : h.newStart;
            const end = added.length > 0 ? Math.max(...added) : h.newStart + Math.max(h.newLines - 1, 0);
            return { newStart: start, newLines: end - start + 1 };
          }),
        });
      }
    }
    const context = buildContext(scopeInputs, expander, { maxTotalChars: config.contextCapChars });
    if (context.truncated) notices.push("enclosing-scope context truncated at the char cap");

    // ── Cross-file caller injection (report item #8): deterministically detect
    // exported signature changes in the diff and FORCE-inject their call sites
    // from other files, so a caller left unupdated is surfaced even if the model
    // wouldn't grep for it. Opt-in (a whole-repo import scan) and fail-soft.
    let crossFileText = "(none)";
    if (config.crossFileCallers ?? false) {
      const reader = deps.repoReader ?? githubRepoReader(pr, auth, config.event?.headSha, fetchImpl);
      try {
        const injected = await collectSignatureChangeCallers(
          kept,
          reader,
          { ...DEFAULT_IMPORT_SCAN_CAPS, ...config.crossFileCaps },
          newAgenticUsage(),
        );
        if (injected.text) crossFileText = injected.text;
        if (injected.truncated) {
          notices.push("cross-file caller injection truncated at the cap — some call sites may be omitted");
        }
      } catch {
        notices.push("cross-file caller scan failed — continuing without it");
      }
    }

    // ── Grounding source (feature #1): the exact diff-line contents + context
    // text sent to the model, for the verifier's deterministic quote check.
    // The injected call sites are part of what the reviewer saw, so include them
    // so the verifier can ground a caller-mismatch quote.
    const groundingSource = buildGroundingSource(
      kept.map((f) => ({
        path: f.path,
        lines: f.hunks.flatMap((h) =>
          h.lines
            .filter((l) => l.newLine !== undefined)
            .map((l) => ({ line: l.newLine as number, content: l.content })),
        ),
      })),
      crossFileText === "(none)" ? context.text : `${context.text}\n\n${crossFileText}`,
    );

    // ── PR intent (feature #3): title/body + linked issues, one REST call,
    // fail-soft (default ON). deps.prIntent (tests) bypasses the network.
    let prIntent: PrIntent | undefined = deps.prIntent;
    if (prIntent === undefined && (config.prIntent ?? true) && !("prIntent" in deps)) {
      prIntent = await fetchPrIntent(pr, auth, fetchImpl);
    }
    const prIntentText = renderPrIntent(prIntent) ?? "(none)";

    // ── Per-language CWE / input-validation checklist (feature #5).
    const securityChecklist = buildSecurityChecklist(kept);

    // ── Agentic tool loop setup (6.3): OFF by default; one shared budget per run.
    const agenticOn = config.agentic ?? false;
    const agenticOpts: AgenticOptions | undefined = agenticOn
      ? {
          reader: deps.repoReader ?? githubRepoReader(pr, auth, config.event?.headSha, fetchImpl),
          caps: config.agenticCaps,
          usage: newAgenticUsage(),
        }
      : undefined;
    const toolsText = agenticOn
      ? "enabled — you may request tools as described in the system prompt."
      : "disabled — respond with the required JSON array only.";
    const diffText2 = kept.map((f) => f.rawText).join("\n");
    const contextText = context.text || "(none)";

    // ── Custom rules (7.4): only rules whose glob matches a reviewed path.
    const rules = applicableRules(repoConfig.rules, kept.map((f) => f.path));
    const customRulesText = rules.length > 0 ? rules.map((r) => `- ${r.text}`).join("\n") : "(none)";

    // ── Optional retrieval (7.6): flag-gated, injected impl, fail-soft.
    let retrievedText = "(none)";
    if ((config.rag ?? false) && deps.retriever) {
      try {
        const chunks = await deps.retriever.retrieve(buildRetrievalQuery(kept), DEFAULT_RETRIEVAL_TOP_K);
        retrievedText = renderRetrievedContext(chunks);
      } catch {
        notices.push("retrieval failed — continuing without retrieved context");
      }
    }

    if (!tracker.canProceed()) {
      earlyStop = true;
    } else {
      const template = deps.promptTemplate ?? loadPromptTemplate(config.promptPath);
      const rendered = renderPrompt(template, {
        DIFF: diffText2,
        COMMENTABLE_LINES: formatCommentableLines(kept),
        HOUSE_RULES: houseRules?.trim() ? houseRules.trim() : "(none)",
        CUSTOM_RULES: customRulesText,
        CONTEXT: contextText,
        RETRIEVED_CONTEXT: retrievedText,
        PR_INTENT: prIntentText,
        SECURITY_CHECKLIST: securityChecklist,
        CROSS_FILE_CALLERS: crossFileText,
        TOOLS: toolsText,
      });

      const loop = await agenticComplete(model, rendered, tracker, agenticOpts);
      if (loop.costStopped) {
        earlyStop = true;
        if (agenticOn) notices.push("agentic search stopped: cost cap");
      }
      if (loop.response) {
        if (!agenticOn && parseToolCalls(loop.response.text) !== undefined) {
          // Tools are off; a tool-call answer degrades to summary-only.
          notices.push("model requested tools but agentic mode is off");
        }
        const guard = parseModelFindings(loop.response.text);
        degraded = guard.degraded;
        rawFindings = guard.findings;
      }

      // ── Verifier pass (6.4): keep/rewrite/drop with evidence; fail OPEN.
      // Default OFF until the eval set (6.8) proves it.
      if ((config.verify ?? false) && !degraded && rawFindings.length > 0) {
        if (!tracker.canProceed()) {
          notices.push("verification skipped: cost cap");
          earlyStop = true;
        } else {
          const verifierTemplate =
            deps.verifierTemplate ?? loadPromptTemplate(undefined, VERIFIER_PROMPT_FILE);
          const verifierRendered = renderPrompt(verifierTemplate, {
            FINDINGS: formatFindingsForVerifier(rawFindings),
            DIFF: diffText2,
            CONTEXT: contextText,
            TOOLS: toolsText,
          });
          const verifierLoop = await agenticComplete(model, verifierRendered, tracker, agenticOpts);
          if (verifierLoop.costStopped && !verifierLoop.response) {
            notices.push("verification skipped: cost cap");
            earlyStop = true;
          } else if (verifierLoop.response) {
            const outcome = applyVerdicts(
              rawFindings,
              parseVerifierOutput(verifierLoop.response.text),
              groundingSource,
            );
            if (outcome.degraded) {
              notices.push(
                "verification degraded: verifier output could not be parsed — publishing unverified findings",
              );
            }
            rawFindings = outcome.kept;
            verification = {
              degraded: outcome.degraded,
              keptCount: outcome.kept.length,
              rewrittenCount: outcome.rewrittenCount,
              dropped: outcome.dropped,
              ungrounded: outcome.ungrounded,
            };
          }
        }
      }

      usage = { model: model.name, inputTokens: tracker.inputTokens, outputTokens: tracker.outputTokens };
      earlyStop = earlyStop || !tracker.canProceed();
    }
    if (agenticOpts) agenticUsage = agenticOpts.usage;
  }

  // ── Deterministic security pre-passes (features #2, #4): secret/credential
  // scan + GitHub Actions workflow supply-chain checks over ADDED diff lines
  // only. Both skip the LLM/verifier entirely and merge straight into the
  // normal publish path, so anchoring, dedupe, and suppression still apply.
  // Merged AFTER the model/verifier block so a leaked key or unpinned action is
  // still flagged even when the model call failed (degraded) or stopped early.
  const deterministic: Finding[] = [
    ...scanSecrets(kept, {
      allowPaths: repoConfig.secretAllowPaths,
      allowPatterns: repoConfig.secretAllowPatterns,
    }),
    ...checkWorkflows(kept),
  ];
  if (deterministic.length > 0) rawFindings = [...rawFindings, ...deterministic];

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
  const { kept: freshRaw, deduped } = dedupeFindings(anchored, dedupeCorpus);

  // ── Intra-run near-duplicate grouping (report item #10): collapse the SAME
  // issue repeated across files/lines into one representative comment (with an
  // "Also found in:" list) before posting. Conservative (category + normalized
  // title); folded members are disclosed in the representative's body.
  const { kept: grouped } = groupNearDuplicates(freshRaw);

  // ── Severity-first ordering (feature #9d): posted inline comments AND the
  // summary table both surface critical→nit. Stable sort keeps intra-band order.
  const fresh = [...grouped].sort((a, b) => bySeverityDesc(a.finding, b.finding));

  const publishableAnchored = fresh.filter((a: AnchoredFinding) => a.placement !== "summary");
  const publishable = publishableAnchored.map((a) => a.finding);
  const summaryFindings = fresh.filter((a) => a.placement === "summary").map((a) => a.finding);
  const findings = fresh.map((a) => a.finding);

  // ── Still-open carry-forward (7.3). On an incremental run, persisted open
  // findings whose code the new range did not touch stay open; touched or
  // deleted code → assumed resolved. Unified with the M2 dedupe path: what
  // the model re-emitted against an existing comment is also still open.
  let carried: Finding[] = [];
  if (incremental && priorState && priorState.openFindings.length > 0) {
    carried = carryForwardOpenFindings(priorState.openFindings, changedFiles).stillOpen;
  }
  const stillOpen = mergeFindings(carried, deduped);

  // ── One batched review (body headline + file-level sections + inline comments).
  const reviewBody = buildSummary({
    findings: publishable,
    skippedFiles: skipped,
    exclusions,
    degraded,
    nothingReviewable,
  });
  const payload = buildReviewPayload(reviewBody, publishableAnchored);

  // ── One upserted summary comment with hidden marker + state SHA (4.4/4.5).
  // Feature #9: severity-grouped table (#9a), deterministic risk verdict (#9b,
  // reusing escalate.ts's risky-path signal), and blob permalinks (#9c).
  const summaryComment = composeSummaryComment({
    headSha: config.event?.headSha,
    owner: pr.owner,
    repo: pr.repo,
    findingsPublished: publishable.length + summaryFindings.length,
    publishedFindings: publishable,
    risk: {
      riskyPaths: riskyPaths(kept.map((f) => f.path)),
      filesChanged: kept.length,
      linesChanged: kept.reduce(
        (n, f) =>
          n + f.hunks.reduce((m, h) => m + h.lines.filter((l) => l.type === "add" || l.type === "del").length, 0),
        0,
      ),
    },
    degraded,
    nothingReviewable,
    summaryFindings,
    stillOpen,
    suppressed,
    skippedFiles: skipped,
    exclusions,
    notices,
    earlyStop,
    verifierDropped: verification?.dropped ?? [],
    verifierUngrounded: verification?.ungrounded.length ?? 0,
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

  // ── Persist the new PR state (7.1): last-reviewed SHA, cumulative hunk
  // hashes, and the open-findings set for the next carry-forward. Best-effort
  // and never on dryRun. Requires a head SHA — state without one is useless.
  if (deps.stateStore && config.event?.headSha && !config.dryRun) {
    const priorHashes = incremental ? (priorState?.hunkHashes ?? []) : [];
    const hunkHashSet = [...new Set([...priorHashes, ...hashHunks(kept)])].slice(-MAX_TRACKED_HUNK_HASHES);
    try {
      await deps.stateStore.set(stateKey, {
        lastReviewedSha: config.event.headSha,
        hunkHashes: hunkHashSet,
        openFindings: mergeFindings(findings, stillOpen).slice(0, MAX_OPEN_FINDINGS),
      });
    } catch {
      // State writes are best-effort — never fail a published run.
    }
  }

  // ── Run log (7.5): one JSONL record per completed run. The timestamp is
  // stamped HERE from the injectable clock — the pure core never reads time.
  if (config.runLogPath) {
    const dropReasons: Record<string, number> = {};
    const bump = (reason: string): void => {
      dropReasons[reason] = (dropReasons[reason] ?? 0) + 1;
    };
    for (const s of suppressed) bump(s.reason);
    for (const _ of deduped) bump("duplicate");
    for (const d of verification?.dropped ?? []) bump(`verifier:${d.reason}`);
    appendRunLog(
      config.runLogPath,
      {
        pr: stateKey,
        timestamp: now().toISOString(),
        model: usage?.model,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        estCostUsd: tracker.spentUsd,
        findingsKept: findings.length,
        findingsDropped: suppressed.length + deduped.length + (verification?.dropped.length ?? 0),
        dropReasons,
        verifierDropped: verification?.dropped.length ?? 0,
        abstained: (verification?.dropped ?? []).filter((d) => d.reason === "insufficient-context").length,
        verifierUngrounded: verification?.ungrounded.length ?? 0,
        escalated,
        incremental: incremental !== undefined,
      },
      deps.runLogIo,
    );
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
    stillOpen,
    incremental,
    summaryFindings,
    notices,
    earlyStop,
    summaryComment,
    verification,
    agenticUsage,
  };
}
