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
import { ESCALATION_MODEL, computeEscalation, riskyPaths } from "./escalate";
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
import { parseModelFindings, parseToolCalls, parseWalkthrough } from "./guardrail";
import type { ProviderChoice, ReviewModel } from "./model";
import {
  FREE_TIER_PROVIDER,
  buildProvider,
  providerChoiceConfig,
  resolveProviderChoice,
  selectProvider,
} from "./model";
import { filterNoise } from "./noise";
import {
  DEFAULT_IMPORT_SCAN_CAPS,
  collectSignatureChangeCallers,
  countImporters,
  scanRepoImports,
} from "./importgraph";
import { scanSecrets } from "./secrets";
import { checkWorkflows } from "./workflowcheck";
import { auditDependencies, scanDependencyChanges } from "./deps";
import { renderSinkEvidence, scanSinks } from "./sinkpack";
import { fetchPrIntent, renderPrIntent } from "./intent";
import { discoverRelatedTests, extractChangedSymbols, renderRelatedTests } from "./relatedtests";
import { collectChurnyPaths, collectFileHistories, renderHistoryContext } from "./history";
import type { CiIo } from "./ci";
import { filterToTouched, loadCiDiagnostics, renderCiGroundTruth } from "./ci";
import {
  buildFewShotExemplars,
  buildSecurityChecklist,
  formatCommentableLines,
  loadPromptTemplate,
  renderPrompt,
  sanitizeUntrusted,
  selectReviewerPrompt,
} from "./prompt";
import {
  SELF_CONSISTENCY_MAX_SAMPLES,
  SELF_CONSISTENCY_TEMPERATURE,
  isHighStakes,
  reconcileSelfConsistency,
} from "./selfconsistency";
import type { ScopeExpander } from "./scope";
import { RegexScopeExpander, buildContext } from "./scope";
import type { ScopeInput } from "./scope";
import {
  applyVerdicts,
  buildGroundingSource,
  formatFindingsForVerifier,
  parseVerifierOutput,
  selectVerifierPrompt,
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
  /** CI/lint/tsc output file IO overrides (feature #16 ingestion; tests). */
  ciIo?: CiIo;
  /** Retrieval implementation for the RAG experiment (task 7.6, packages/rag). */
  retriever?: Retriever;
  /**
   * Pre-fetched PR intent (feature #3). When provided (even as an explicit
   * undefined via a set key), NO GET /pulls/{n} call is made — tests inject it;
   * production fetches it when `config.prIntent` is on.
   */
  prIntent?: PrIntent;
}

/**
 * Walkthrough instruction (report item #26) injected into the reviewer-v8
 * {{WALKTHROUGH_INSTRUCTION}} placeholder. When on, the reviewer wraps its
 * output as an object with a sibling `walkthrough` field (the guardrail already
 * reads the findings array out of that wrapper). When off, it must stay on the
 * bare findings-array contract.
 */
const WALKTHROUGH_INSTRUCTION_ON =
  "Also provide a brief high-level walkthrough of this PR. To do so, wrap your " +
  'output as a JSON object: {"walkthrough": "<2–4 sentence plain-language ' +
  'overview of what this change does and where the risk is>", "findings": [ ...the findings array... ]}. ' +
  "The walkthrough is prose (not a finding) and never a substitute for a finding.";
const WALKTHROUGH_INSTRUCTION_OFF = "(not requested — respond with the bare findings array as specified above)";

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

    // ── Escalation signals (6.5 + report item #19): the risky-PATH heuristic
    // (default on), OR-ed with two opt-in deterministic signals — blast radius
    // (a changed file imported by many others, from the import-graph substrate)
    // and churn (a changed file with recent revert/hotfix history). The two
    // extra signals cost a repo scan + per-file history calls, so they only run
    // when `blastRadiusEscalation` is on (free-tier-first); both are fail-soft.
    const keptPaths = kept.map((f) => f.path);
    let importerCounts: Map<string, number> | undefined;
    let churnyPaths: string[] | undefined;
    if ((config.blastRadiusEscalation ?? false) && keptPaths.length > 0) {
      const reader = deps.repoReader ?? githubRepoReader(pr, auth, config.event?.headSha, fetchImpl);
      try {
        const scan = await scanRepoImports(
          reader,
          { ...DEFAULT_IMPORT_SCAN_CAPS, ...config.crossFileCaps },
          newAgenticUsage(),
        );
        importerCounts = countImporters(scan, keptPaths);
      } catch {
        // blast-radius scan is best-effort — fall back to the path signal alone
      }
      try {
        churnyPaths = await collectChurnyPaths(
          pr,
          auth,
          config.event?.headSha ?? "HEAD",
          keptPaths,
          fetchImpl,
        );
      } catch {
        // churn history is best-effort — fall back to the path signal alone
      }
    }
    const escalation = computeEscalation({
      paths: keptPaths,
      importerCounts,
      blastRadiusThreshold: config.blastRadiusThreshold,
      churnyPaths,
    });
    const risky = (config.escalation ?? true) && escalation.escalate;
    const escalationWhy = escalation.reasons.join("; ");

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
          notices.push(`review escalated to ${target} (${escalationWhy})`);
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
        notices.push(`review escalated to ${target} (${escalationWhy})`);
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
  let walkthrough: string | undefined;
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

    // ── Related-tests discovery (report item #17): deterministic sibling-test
    // lookup against the repo tree. Default ON — it is "(none)"-safe (no matches
    // → no prompt noise) and fail-soft. Reviewer-only context ({{RELATED_TESTS}}).
    let relatedTestsText = "(none)";
    if (config.relatedTests ?? true) {
      const reader = deps.repoReader ?? githubRepoReader(pr, auth, config.event?.headSha, fetchImpl);
      const testInputs = kept
        .filter((f) => !f.isBinary && f.status !== "deleted")
        .map((f) => ({
          path: f.path,
          symbols: extractChangedSymbols(
            f.hunks.flatMap((h) => h.lines.filter((l) => l.type === "add").map((l) => l.content)),
          ),
        }));
      try {
        relatedTestsText = renderRelatedTests(await discoverRelatedTests(testInputs, reader));
      } catch {
        notices.push("related-tests discovery failed — continuing without it");
      }
    }

    // ── Git blame / history context (report item #20): one GraphQL blame call
    // per changed file → "last touched N days ago by M author(s)". Default OFF
    // (extra API calls, like crossFileCallers/rag); fail-soft. `now` comes from
    // the injected clock so the pure pipeline stays deterministic. Feeds the
    // reviewer {{CODE_HISTORY}} block AND the verifier ground-truth context
    // (real evidence for the verifier's `pre-existing` drop reason).
    let historyText = "(none)";
    if (config.historyContext ?? false) {
      const historyInputs = kept
        .filter((f) => !f.isBinary && f.status !== "deleted" && f.hunks.length > 0)
        .map((f) => ({
          path: f.path,
          spans: f.hunks.map((h) => ({
            startLine: h.newStart,
            endLine: h.newStart + Math.max(h.newLines - 1, 0),
          })),
        }));
      try {
        const histories = await collectFileHistories(
          pr,
          auth,
          config.event?.headSha ?? "HEAD",
          historyInputs,
          fetchImpl,
          now(),
        );
        historyText = renderHistoryContext(histories);
      } catch {
        notices.push("history/blame context failed — continuing without it");
      }
    }

    // ── CI/lint/tsc output ingestion (report item #16): parse the repo's
    // EXISTING static-analysis output at an operator-provided local path, filter
    // to the touched files, and render it as CITED deterministic ground truth
    // the verifier can cross-reference. Path set by the TRUSTED operator (never
    // the attacker-controllable .aireview.toml); fail-soft when absent/unreadable.
    // Scoped to the verifier, so only loaded when the verifier will consume it.
    let ciGroundTruth = "(none)";
    if (config.ciOutputPath && (config.verify ?? false)) {
      const diags = filterToTouched(
        loadCiDiagnostics(config.ciOutputPath, config.ciOutputFormat, deps.ciIo),
        kept.map((f) => f.path),
      );
      ciGroundTruth = renderCiGroundTruth(diags);
      if (diags.length > 0) {
        notices.push(
          `ingested ${diags.length} CI/lint diagnostic(s) for the touched files as verifier ground truth`,
        );
      }
    }

    // ── Dangerous-sink rule pack (report item #21): a deterministic per-language
    // pattern scan over the ADDED lines, injected as PRE-FLAGGED evidence the
    // reviewer must reason about — source→sink reachability required before a
    // high/critical (see reviewer-v11). Default OFF (uncertain precision lever,
    // pending live-eval measurement). The matched lines ARE diff lines, so they
    // ground against the diff; included in the grounding context for consistency.
    let sinkText = "(none)";
    const sinkOn = config.sinkPack ?? false;
    if (sinkOn) {
      const matches = scanSinks(kept);
      sinkText = renderSinkEvidence(matches);
      if (matches.length > 0) {
        notices.push(`dangerous-sink pack: pre-flagged ${matches.length} sink(s) for taint reasoning`);
      }
    }

    // ── Grounding source (feature #1): the exact diff-line contents + context
    // text sent to the model, for the verifier's deterministic quote check. The
    // injected call sites, blame history, CI ground truth, and sink evidence are
    // all part of what the verifier is shown, so include them so those quotes
    // ground too.
    const groundingContext = [context.text, crossFileText, historyText, ciGroundTruth, sinkText]
      .filter((t) => t && t !== "(none)")
      .join("\n\n");
    const groundingSource = buildGroundingSource(
      kept.map((f) => ({
        path: f.path,
        lines: f.hunks.flatMap((h) =>
          h.lines
            .filter((l) => l.newLine !== undefined)
            .map((l) => ({ line: l.newLine as number, content: l.content })),
        ),
      })),
      groundingContext,
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

    // ── Prompt-injection self-defense (report item #23): the diff, house rules,
    // custom rules, and PR intent are all attacker-reachable text templated into
    // the prompt. Strip zero-width/bidi Unicode from all of them and NEUTRALIZE
    // injection-marker phrases inline in the instruction-like blocks (house/custom
    // rules, PR intent); the diff is left visually verbatim (grounding depends on
    // it) — its defense is the invisible-char strip + a surfaced notice. Default
    // ON — it protects Loupe itself. A single aggregated notice per source.
    const injectionOn = config.injectionDefense ?? true;
    const sanitize = (label: string, text: string, defang: boolean): string => {
      if (!injectionOn || !text || text === "(none)") return text;
      const s = sanitizeUntrusted(text, { defang });
      if (s.markers.length > 0 || s.strippedChars > 0) {
        const strip = s.strippedChars > 0 ? `, ${s.strippedChars} hidden char(s) stripped` : "";
        notices.push(
          `⚠ possible prompt-injection content ${defang ? "neutralized" : "detected"} in ${label} ` +
            `(${s.markers.length} marker(s)${strip})`,
        );
      }
      return s.text;
    };
    const houseRulesText = houseRules?.trim()
      ? sanitize("HOUSE_RULES.md", houseRules.trim(), true)
      : "(none)";
    const customRulesSafe = sanitize(".aireview.toml custom rules", customRulesText, true);
    const prIntentSafe = sanitize("the PR description", prIntentText, true);
    const diffForModel = sanitize("the diff", diffText2, false);

    if (!tracker.canProceed()) {
      earlyStop = true;
    } else {
      // ── Reviewer prompt selection (report items #14, #26, #21): the flagged
      // reviewer-v11 (with the exemplar/walkthrough/sink placeholders) only when a
      // flag needs it, else the v9 default. All placeholder vars are always
      // passed; v9 has no such tokens so they are simply ignored there
      // (renderPrompt no-ops on absent tokens).
      const fewShotOn = config.fewShotExemplars ?? false;
      const walkthroughOn = config.walkthrough ?? false;
      const reviewerFile = selectReviewerPrompt({
        fewShotExemplars: fewShotOn,
        walkthrough: walkthroughOn,
        sinkPack: sinkOn,
      });
      const template =
        deps.promptTemplate ?? loadPromptTemplate(config.promptPath, reviewerFile);
      const rendered = renderPrompt(template, {
        DIFF: diffForModel,
        COMMENTABLE_LINES: formatCommentableLines(kept),
        HOUSE_RULES: houseRulesText,
        CUSTOM_RULES: customRulesSafe,
        CONTEXT: contextText,
        RELATED_TESTS: relatedTestsText,
        CODE_HISTORY: historyText,
        RETRIEVED_CONTEXT: retrievedText,
        PR_INTENT: prIntentSafe,
        SECURITY_CHECKLIST: securityChecklist,
        CROSS_FILE_CALLERS: crossFileText,
        SINK_EVIDENCE: sinkText,
        FEWSHOT_EXEMPLARS: buildFewShotExemplars(fewShotOn),
        WALKTHROUGH_INSTRUCTION: walkthroughOn ? WALKTHROUGH_INSTRUCTION_ON : WALKTHROUGH_INSTRUCTION_OFF,
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
        // ── Walkthrough narrative (report item #26): optional sibling field on
        // the reviewer JSON; fail open (absent → undefined). Off by default.
        if (walkthroughOn && !degraded) {
          walkthrough = parseWalkthrough(loop.response.text);
        }
      }

      // ── Self-consistency voting (report item #15): on critical/high findings,
      // re-run the reviewer 1–2× at temperature > 0 and DEMOTE (never drop) any
      // high-stakes finding a majority of samples do not reproduce. Bounded to
      // the per-run cost cap; off by default (uncertain precision lever).
      if ((config.selfConsistency ?? false) && !degraded && rawFindings.some((f) => isHighStakes(f.severity))) {
        const samples: Finding[][] = [];
        for (let i = 0; i < SELF_CONSISTENCY_MAX_SAMPLES; i += 1) {
          if (!tracker.canProceed()) {
            notices.push("self-consistency: cost cap reached — used fewer samples");
            earlyStop = true;
            break;
          }
          const resample = await model.complete({
            system: rendered.system,
            user: rendered.user,
            temperature: SELF_CONSISTENCY_TEMPERATURE,
          });
          tracker.record(model.name, resample.inputTokens, resample.outputTokens);
          const g = parseModelFindings(resample.text);
          if (!g.degraded) samples.push(g.findings);
        }
        if (samples.length === 0) {
          notices.push("self-consistency: no usable extra samples — severities unchanged");
        } else {
          const reconciled = reconcileSelfConsistency(rawFindings, samples);
          rawFindings = reconciled.findings;
          if (reconciled.demoted.length > 0) {
            notices.push(
              `self-consistency: demoted ${reconciled.demoted.length} high-stakes finding(s) not reproduced across ${samples.length + 1} samples`,
            );
          }
        }
      }

      // ── Verifier pass (6.4): keep/rewrite/drop with evidence; fail OPEN.
      // Default OFF until the eval set (6.8) proves it.
      if ((config.verify ?? false) && !degraded && rawFindings.length > 0) {
        if (!tracker.canProceed()) {
          notices.push("verification skipped: cost cap");
          earlyStop = true;
        } else {
          const verifierTemplate =
            deps.verifierTemplate ??
            loadPromptTemplate(undefined, selectVerifierPrompt(config.chainOfVerification));
          // The verifier gets the same enclosing-scope context PLUS the blame
          // history and CI/lint ground truth (features #20, #16) folded in as
          // labeled sections — deterministic evidence it can cite (esp. for the
          // `pre-existing` drop reason). Grounded against `groundingSource`,
          // which already includes those sections.
          const verifierContext =
            [
              contextText === "(none)" ? "" : contextText,
              historyText === "(none)" ? "" : `## Code history (blame)\n${historyText}`,
              ciGroundTruth === "(none)"
                ? ""
                : `## Static-analysis findings (CITED ground truth from CI/lint/tsc)\n${ciGroundTruth}`,
            ]
              .filter((t) => t.trim().length > 0)
              .join("\n\n") || "(none)";
          const verifierRendered = renderPrompt(verifierTemplate, {
            FINDINGS: formatFindingsForVerifier(rawFindings),
            DIFF: diffForModel,
            CONTEXT: verifierContext,
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

  // ── Deterministic security pre-passes (features #2, #4, #22): secret scan +
  // GitHub Actions workflow supply-chain checks + dependency review (new-dep +
  // install-script heads-up) over ADDED diff lines only. All skip the LLM/
  // verifier and merge straight into the normal publish path, so anchoring,
  // dedupe, and suppression still apply. Merged AFTER the model/verifier block so
  // a leaked key / unpinned action / risky new dep is still flagged even when the
  // model call failed (degraded) or stopped early.
  // Dependency scan runs over `afterIgnore` (respects ignore globs) rather than
  // `kept`, because lockfiles — where `hasInstallScript` lives — are noise-
  // filtered out of `kept`. A lockfile finding lands file-level (lockfiles have
  // no commentable lines), which is the right place for a generated file anyway.
  const depScan =
    (config.dependencyReview ?? true) ? scanDependencyChanges(afterIgnore) : { findings: [], newDeps: [] };
  const deterministic: Finding[] = [
    ...scanSecrets(kept, {
      allowPaths: repoConfig.secretAllowPaths,
      allowPatterns: repoConfig.secretAllowPatterns,
    }),
    ...checkWorkflows(kept),
    ...depScan.findings,
  ];
  // Optional network audit (feature #22): OSV.dev CVEs + npm license on the new
  // deps. Off by default; only runs when there are new deps to audit. Fail-soft.
  if ((config.dependencyAudit ?? false) && depScan.newDeps.length > 0) {
    try {
      const audit = await auditDependencies(depScan.newDeps, fetchImpl);
      deterministic.push(...audit.findings);
      notices.push(...audit.notices);
    } catch {
      notices.push("dependency audit failed — continuing with the deterministic dependency scan only");
    }
  }
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
  // Pass the commentable map so an exact-anchored finding carrying a validated
  // contiguous `suggestedRange` renders as a multi-line ```suggestion (#18);
  // publish falls back to single-line / prose when the range isn't clean.
  const payload = buildReviewPayload(reviewBody, publishableAnchored, commentable);

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
    walkthrough,
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
    walkthrough,
  };
}
