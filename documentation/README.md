# Loupe — Documentation

Loupe is a self-built AI pull-request review agent — in the spirit of
CodeRabbit, Qodo Merge (PR-Agent), and Greptile — built by Ansh Roshan as a
solo, learning-first, spec-driven project. When a PR is opened or updated on
GitHub, it fetches the diff plus relevant repo context, has an LLM review it
under a reviewer-then-verifier architecture, and posts inline review comments
plus one upserted summary comment back on the PR — shipping today as a
GitHub Action, with a GitHub App/Cloudflare Worker mode built and deferred.

This `documentation/` folder is the durable, English, team-shaped record of
the system: how it's architected, why each structural decision was made, and
where the project stands. It sits alongside — not instead of — `openspec/`
(the spec source of truth) and `research/` (the research corpus the design
was derived from); see the table below for how they relate.

## Start here

| Doc | What it covers |
|---|---|
| [`architecture.md`](./architecture.md) | The system as built: pipeline stages, module map, the trigger-agnostic engine + two adapters, data flow through a review run. |
| [`adr/README.md`](./adr/README.md) | Architecture Decision Records index (ADR-0001…0011) — the structural decisions (Action-then-App, Cloudflare Workers, TypeScript everywhere, agentic search over RAG, reviewer+verifier, LLM-proposes/code-disposes, etc.) with their rejected alternatives. |
| [`planning.md`](./planning.md) | Milestone status (M0–M5, all implemented), current test/eval numbers, the remaining live-verification checklist, the go-public checklist, and the feature backlog. |

## Where everything lives

Loupe's documentation is spread across several folders by design (see the
root [`CLAUDE.md`](../CLAUDE.md) conventions) — this table is the map so
this README can be the one entry point.

| Location | What's there |
|---|---|
| [`../README.md`](../README.md) | Top-level usage: how to drop the Action into a repo, provider/model configuration, the repo layout. |
| [`../guides/01-how-it-works.md`](../guides/01-how-it-works.md) | Narrative walkthrough: what the project is, the pipeline stage-by-stage, current status. |
| [`../guides/02-plan-b-open-source-action.md`](../guides/02-plan-b-open-source-action.md) | Mode B — the GitHub Action, shipping now. |
| [`../guides/03-future-github-app.md`](../guides/03-future-github-app.md) | Mode A — the GitHub App + Worker, built and deferred. |
| [`../guides/04-how-to-run-and-test.md`](../guides/04-how-to-run-and-test.md) | Local dev/test commands, getting an API key, and the live-test checklist. |
| [`../research/01-10`](../research/) | The research corpus: OSS reference architectures (01–03), commercial landscape (04), GitHub mechanics (05), context/RAG strategies (06), stack/cost analysis (07), the architecture + milestone synthesis (08), the feature-requirements catalog (09), the ranked feature-improvement backlog (10). |
| [`../openspec/changes/build-pr-review-agent/`](../openspec/changes/build-pr-review-agent/) | The spec source of truth: `proposal.md` (why/what), `specs/` (per-capability specs: `pr-trigger`, `review-pipeline`, `review-publishing`, `repo-configuration`), `design.md` (how — decisions table + milestone plan), `tasks.md` (the full task checklist this project is executed against). |
| [`../docs/github-app-setup.md`](../docs/github-app-setup.md) | Manual checklist for registering the GitHub App (task 5.1, deferred). |
| [`../docs/state-and-incremental.md`](../docs/state-and-incremental.md) | M5 state model: per-PR state shape, incremental scoping, carry-forward. |
| [`../docs/house-rules-suppression.md`](../docs/house-rules-suppression.md) | `HOUSE_RULES.md` convention: prompt-level guidance vs. deterministic `suppress:` rules. |
| [`../docs/dummy-pr-workflow.md`](../docs/dummy-pr-workflow.md) | How to generate throwaway PRs against the local testbed repo for manual testing. |

## Offline HTML renders

Self-contained HTML renders of `architecture.md` and `planning.md` will live
in `./html/`, generated locally and openable directly in a browser offline —
no upload, no external hosting, consistent with this project's local-only
rule.
