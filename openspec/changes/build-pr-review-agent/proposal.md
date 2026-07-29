# Proposal: build-pr-review-agent

## Why

Ansh wants to build his own AI pull-request review agent — the product category
occupied by CodeRabbit, Qodo Merge (PR-Agent), Greptile, and several small
open-source projects — both to learn the full concept stack (webhooks, GitHub
Apps, diff handling, LLM prompting, repo context/RAG) and to end up with a
working, self-hosted reviewer he controls. Nothing exists in this repo yet;
this change bootstraps the whole product from zero to a working MVP.

## What Changes

- Stand up a service/bot that is notified when a pull request is opened or
  updated on GitHub (webhook or GitHub App — decided in design).
- Build a review pipeline: fetch the PR diff, parse it into reviewable units,
  gather supporting repo context (surrounding code, related files; RAG or
  agentic retrieval — decided in design), and send it to an LLM with a review
  prompt.
- Publish results back to the PR: inline review comments anchored to diff
  lines plus one summary comment (upserted, not duplicated, on re-review).
- Support re-review on new commits, reviewing only what changed since the
  last review.
- Allow per-repo configuration (enable/disable, ignore paths, review depth)
  via a config file in the target repo.
- Keep the whole thing runnable on free tiers (hosting + LLM) as the default
  posture; costs are a design constraint, not an afterthought.

## Capabilities

### New Capabilities
- `pr-trigger`: detecting PR events (opened, synchronize, on-demand command)
  and deciding when a review should fire, including auth with GitHub and
  webhook signature verification.
- `review-pipeline`: turning a PR into review findings — diff fetching and
  parsing, repo context gathering, LLM invocation, and structuring the
  model's output into findings.
- `review-publishing`: posting findings to the PR — line-anchored inline
  comments, an upserted summary comment, and graceful handling of re-reviews.
- `repo-configuration`: per-repo config file controlling whether and how
  reviews run (ignore paths, depth, enable/disable).

### Modified Capabilities
<!-- none — greenfield project, no existing specs -->

## Impact

- New codebase under `src/` (language/framework chosen in design.md from
  `research/07-stack-and-cost-analysis.md`).
- New external dependencies: GitHub API (App/webhooks), one LLM provider API.
- New documentation under `documentation/`; research corpus under `research/`.
- No existing systems affected — greenfield.
