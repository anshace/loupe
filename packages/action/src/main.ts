/**
 * Action adapter: read the pull_request event + the action.yml inputs, map them
 * to a RunEvent + EngineConfig, and drive the SAME engine entry (runReview) the
 * App/Worker adapter uses — task 5.8 parity. The engine posts the batched review
 * + upserted summary itself using the workflow's token.
 *
 * Inputs come from @actions/core.getInput (the `with:` block); each falls back
 * to the env var the engine already honoured, so the adapter still runs in
 * local dev with plain env vars and no INPUT_* set.
 */
import * as core from "@actions/core";
import * as github from "@actions/github";
import { FileStateStore, runReview } from "@code-review/engine";
import type { EngineConfig, Severity } from "@code-review/engine";
import { extractPrEventInfo, toRunEvent } from "./payload";

/** The identity the workflow token comments appear under (for self-event skipping). */
const ACTIONS_BOT_LOGIN = "github-actions[bot]";

/** review-model choice → the provider API-key env var the engine reads. */
const PROVIDER_KEY_ENV: Record<string, string> = {
  gemini: "GEMINI_API_KEY",
  haiku: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
};

const SEVERITIES: readonly string[] = ["critical", "high", "medium", "low", "nit"];

/** Read an action input, falling back to an env var so local dev still works. */
function input(name: string, envKey?: string): string {
  const value = core.getInput(name);
  if (value) return value;
  return (envKey && process.env[envKey]) || "";
}

async function run(): Promise<void> {
  const info = extractPrEventInfo(github.context.payload);

  const token = input("github-token", "GITHUB_TOKEN");
  if (!token) {
    throw new Error("no GitHub token — set the `github-token` input or GITHUB_TOKEN env var");
  }

  // ── Provider selection: review-model picks the provider; llm-api-key is that
  // provider's key. We set the env vars the engine already reads, so the engine
  // keeps owning provider construction, budget degrade, and escalation.
  const modelRaw = (input("review-model", "REVIEW_MODEL") || "haiku").toLowerCase();
  const model = modelRaw in PROVIDER_KEY_ENV ? modelRaw : "haiku";
  if (model !== modelRaw) core.warning(`unknown review-model "${modelRaw}" — falling back to haiku`);
  process.env.REVIEW_MODEL = model;
  const apiKey = input("llm-api-key");
  if (apiKey) process.env[PROVIDER_KEY_ENV[model]] = apiKey;

  // ── min-severity: optional publish floor. Validated; an invalid value is
  // ignored so the run falls back to .aireview.toml / the engine default.
  const minSeverityRaw = input("min-severity").toLowerCase();
  let minSeverity: Severity | undefined;
  if (minSeverityRaw) {
    if (SEVERITIES.includes(minSeverityRaw)) minSeverity = minSeverityRaw as Severity;
    else core.warning(`ignoring invalid min-severity "${minSeverityRaw}"`);
  }

  const configPath = input("config-path") || undefined;
  const runLogPath = input("run-log-path", "REVIEW_RUN_LOG_PATH") || undefined;

  // ── State store (7.1): opt-in. Point state-path at a persisted location
  // (e.g. an actions/cache path) to enable incremental re-review + carry-forward.
  const statePath = input("state-path", "REVIEW_STATE_PATH");
  const stateStore = statePath ? new FileStateStore(statePath) : undefined;

  const engineConfig: EngineConfig = {
    event: toRunEvent(info),
    botIdentity: ACTIONS_BOT_LOGIN,
    minSeverity,
    configPath,
    runLogPath,
    // Escalation routes risky paths to Anthropic Sonnet, which needs an Anthropic
    // key. With a single llm-api-key we only have one when review-model is haiku;
    // otherwise disable escalation so a risky diff can't hard-fail the run.
    escalation: model === "haiku" ? undefined : false,
  };

  const result = await runReview(
    {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      prNumber: info.prNumber,
    },
    token,
    engineConfig,
    { stateStore },
  );

  if (result.skipped) {
    core.info(`Run skipped: ${result.skipped.reason}`);
    return;
  }
  core.info(
    `Reviewed PR #${info.prNumber} (head ${info.headSha}): ` +
      `${result.findings.length} finding(s), posted=${result.posted}`,
  );
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
