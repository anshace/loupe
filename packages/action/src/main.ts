/**
 * M0 Action adapter: read the pull_request event, ask the engine for the
 * comment body, post it as an issue comment. The engine builds; this posts.
 */
import * as core from "@actions/core";
import * as github from "@actions/github";
import { buildStatsComment } from "@code-review/engine";
import { extractPrEventInfo } from "./payload";

async function run(): Promise<void> {
  const info = extractPrEventInfo(github.context.payload);

  const body = buildStatsComment({
    fileCount: info.fileCount,
    additions: info.additions,
    deletions: info.deletions,
  });

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN env var is not set");

  const octokit = github.getOctokit(token);
  await octokit.rest.issues.createComment({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: info.prNumber,
    body,
  });

  core.info(`Posted stats comment on PR #${info.prNumber} (head ${info.headSha})`);
}

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
