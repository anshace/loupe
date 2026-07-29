/**
 * Action adapter: read the pull_request event, map it to a RunEvent, and
 * drive the SAME engine entry (runReview) the App/Worker adapter uses —
 * task 5.8 parity. The engine posts the batched review + upserted summary
 * itself using the workflow's GITHUB_TOKEN.
 */
import * as core from "@actions/core";
import * as github from "@actions/github";
import { FileStateStore, runReview } from "@code-review/engine";
import { extractPrEventInfo, toRunEvent } from "./payload";

/** The identity GITHUB_TOKEN comments appear under (for self-event skipping). */
const ACTIONS_BOT_LOGIN = "github-actions[bot]";

async function run(): Promise<void> {
  const info = extractPrEventInfo(github.context.payload);

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN env var is not set");

  // M5 state + run log (7.1/7.5): flat files, opt-in via env vars. Point
  // REVIEW_STATE_PATH at a persisted location (e.g. an actions/cache path)
  // to enable incremental re-review + still-open carry-forward; without it
  // the engine stays stateless (summary-marker SHA only).
  const statePath = process.env.REVIEW_STATE_PATH;
  const stateStore = statePath ? new FileStateStore(statePath) : undefined;

  const result = await runReview(
    {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      prNumber: info.prNumber,
    },
    token,
    {
      event: toRunEvent(info),
      botIdentity: ACTIONS_BOT_LOGIN,
      runLogPath: process.env.REVIEW_RUN_LOG_PATH,
    },
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
