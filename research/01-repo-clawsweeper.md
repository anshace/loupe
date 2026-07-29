# Repo Analysis: openclaw/clawsweeper

**Repo:** https://github.com/openclaw/clawsweeper
**Status:** Exists and is active. ~1.9k stars, 284 forks, 13,713+ commits on `main`. MIT licensed. Primary language TypeScript.

> Note on framing: the README's own tagline calls it "Anthropic's conservative maintenance bot for OpenClaw repositories," but functionally it is a Codex-driven (OpenAI) maintenance/repair agent for the `openclaw` GitHub org, not a general-purpose "AI PR review agent" product like CodeRabbit/Greptile. It's closer to an autonomous backlog-triage + guarded auto-repair bot than a pure PR-diff reviewer. Worth knowing before drawing 1:1 architecture lessons.

## What It Does

ClawSweeper is a maintenance-automation system for the `openclaw` GitHub org (repos: `openclaw/openclaw`, `openclaw/clawhub`, and self-review on `openclaw/clawsweeper`). Its README describes it as scanning **all** issues and PRs and suggesting what can be closed, and why — running on a schedule (weekly-ish sweep + event-driven triggers) rather than purely per-PR.

It operates across four "lanes":

1. **Review Lane** — scheduled + event-driven scan of issues/PRs, producing durable markdown reports and syncing GitHub comments. Proposal-only; never closes anything itself.
2. **Apply Lane** — runs every ~15 minutes, re-validates unchanged proposals from the Review Lane, then executes the actual GitHub mutations (closing issues/PRs, posting comments) with a fresh safety recheck immediately before acting.
3. **Repair Lane** — handles maintainer-invoked commands (`@clawsweeper autofix`, `@clawsweeper automerge`, `@clawsweeper implement issue`) via a bounded Codex review/fix loop, can open new implementation PRs from well-specified bug issues.
4. **Commit Review Lane** — reviews commits landing on `main`, classifies which are "code-bearing," and generates findings reports; can optionally publish GitHub Check Runs.

Core guiding philosophy (from `VISION.md`): **"abundant intelligence, scarce trust"** — lean on cheap LLM calls for judgment/decision-making, but keep code (not model output) in charge of trust boundaries: auth, spend limits, and any actual write mutation. The system explicitly never merges code autonomously, never touches unconfigured repos, and never spends budget without a ledger entry.

## Architecture / Triggering

Not a single GitHub Action or webhook — it's a fairly large distributed system with **47 GitHub Actions workflow files** plus a Cloudflare Workers-based dashboard/state layer. Key pieces:

- **`.github/workflows/clawsweeper-dispatch.yml`** — the front door. Triggers on issue/PR `opened`, `reopened`, `edited`, `labeled`, and on `issue_comment` events. It:
  - mints a GitHub App installation token (via `CLAWSWEEPER_APP_PRIVATE_KEY`/`CLAWSWEEPER_APP_CLIENT_ID` — it's a **GitHub App**, not a plain PAT-based Action)
  - scans comment bodies for `@clawsweeper` mentions or slash commands (`/review`, `/auto-merge`)
  - dispatches two kinds of events downstream: direct PR/issue events, and comment-driven command events (with an emoji "seen" reaction)
  - fingerprints PR events (SHA256 of event metadata) to dedupe
  - debounces rapid label-change bursts by ~20 seconds
  - gates acknowledgment comments to org members/collaborators/owners only (anti-spam / anti-prompt-injection-from-randoms measure)

- **`.github/workflows/sweep.yml`** — the scheduled batch sweep. Fans out targets across shards (capped at 89 parallel shards), reviews "hot" high-priority items first, applies default closures, and audits its own state. Supports `repository_dispatch` for targeted/on-demand reviews plus cron. Has a 1.2M ms (20 min) default Codex timeout per item, and uses **lease-based concurrency control with heartbeats** so two shards can't double-process the same issue/PR.

- **`repair-*.yml` workflows** (10 of them) — a whole sub-pipeline: intake, cluster worker, comment router, conflict self-heal, finalize-open-PRs, publish-results, self-heal — i.e., the repair loop is durable/queue-based and resumable across job boundaries, not a single long-running job.

- **State/dashboard** — live operational state publishes to a dedicated branch/repo (`openclaw/clawsweeper-state`), rendered on a Cloudflare Pages/Workers dashboard at `clawsweeper.openclaw.ai` (workflow files: `dashboard.yml`, `dashboard-ci.yml`, `state-materializer.yml`, `state-compaction.yml`, `pages.yml`).

- **Local dev / pre-merge use**: can be run locally against a diff before opening a PR:
  ```
  pnpm run review -- --local-range --target-repo owner/name --base origin/main
  ```
  and against a specific already-open item:
  ```
  pnpm run review -- --target-repo owner/name --item-number 123 --local-only
  ```

## Context Gathering

Per `prompts/review-item.md` (the main review prompt), before making any decision the agent is instructed to read:
- repo-level guidance docs (`AGENTS.md`, `VISION.md`)
- code/git history to infer likely code owners
- reproduction evidence for bug reports
- for PRs specifically: "real-behavior proof" — actual evidence the change works, not just that it compiles/lints. This is treated as a **merge gate** (except for docs-only PRs).

It also cross-references structured state: a **decision-packets** system (`src/decision-packets.ts`), semantic and structural **review caches** (`review-semantic-cache.ts`, `review-structural-cache.ts`) to avoid redundant LLM calls on unchanged content, and an **action ledger** (`action-ledger*.ts`) that records every decision/mutation for audit and idempotency.

## LLM Usage & Model

- Primary execution engine is **Codex** (OpenAI) — `codex-process.ts`, `codex-process-worker.ts`, `codex-app-server-worker.ts`, `codex-spawn.ts`, `codex-env.ts`, `codex-output-capture.ts`, `codex-transient.ts` all wrap spawning/managing Codex subprocesses.
- The dispatch workflow's description also mentions the system "integrates with multiple AI model providers (OpenAI, Anthropic, Gemini, etc.)" — so provider choice appears configurable/pluggable rather than hardcoded to one vendor, even though Codex is the default/primary path.
- Required secrets include `OPENAI_API_KEY` plus the two GitHub App credentials — confirming OpenAI is the baseline provider for the hosted instance.
- Critically: **Codex has no write credentials**. Model output is treated as untrusted/advisory; only the ledger-backed TypeScript "Apply Lane" code can actually mutate GitHub state, and it re-validates the proposal is still true immediately before acting. This is the load-bearing security design of the whole system.

## Prompting Strategy

The `prompts/` directory holds versioned markdown prompt templates (`review-item.md`, `review-commit.md`, `pr-close-coverage-proof.md`), separate from code — i.e., prompts are treated as first-class, reviewable artifacts, not inline strings.

`review-item.md` structures the task as:
1. Gather context (AGENTS.md, VISION.md, git blame/history, related issues).
2. Classify the item (category, priority, impact).
3. Decide close-or-keep using a **fixed enum of allowed close reasons** (`implemented_on_main`, `cannot_reproduce`, `duplicate_or_superseded`, `clawhub`, plus several age/inactivity reasons) — each reason has explicit evidence requirements, so the model can't invent an ad hoc justification.
4. For PRs: require "real-behavior proof" as a merge gate.
5. Output a **structured JSON response** containing: classification, reasoning summary, security review, real-behavior-proof assessment, "vision fit" (does this align with `VISION.md`), work-lane routing, likely code owners, and a public-facing markdown comment.
6. Hard constraints baked into the prompt: read-only inspection (no mutating tools available to the model at all), protected labels (`security`, `release-blocker`, `maintainer`) block auto-close outright, and the tone requirement is "friendly, evidence-based, acknowledges contributor effort."

This is a notably rigorous prompt-engineering pattern: closed-set decision enums + required structured JSON + explicit "prove it before closing/merging" evidentiary bar, rather than free-form LLM judgment.

## Comment Posting

- Comments are **edited in place** rather than re-posted every run — `review-comment-markers.ts` implements marker-based identification of the bot's own prior comment so a durable report can be updated instead of spamming a new comment each sweep.
- Status replies use emoji-coded markers as a lightweight state machine visible in the UI: 👀 acknowledged → 🧹 reviewing → 🔧 repairing → ✅ done.
- Acknowledgment/command-response comments are only posted for verified org members/collaborators/owners — a deliberate defense against random/anonymous users invoking commands or trying prompt injection through issue comments.
- `review-placeholder-recovery.ts` suggests there's explicit handling for the case where a placeholder/"working on it" comment gets orphaned (e.g., job crash) and needs to be recovered/replaced on retry.

## Tech Stack

- **Language**: TypeScript (strict, multiple `tsconfig*.json` for core/dashboard/repair — separate build targets)
- **Package manager**: pnpm workspaces (monorepo: `pnpm-workspace.yaml`)
- **Runtime**: Node.js >= 24
- **Lint/format**: oxlint + oxfmt (the newer Rust-based Oxc toolchain, not ESLint/Prettier) plus `oxlint-tsgolint`
- **CI/CD**: GitHub Actions (47 workflow files) — this is effectively the entire orchestration layer; there's no separate always-on server for the core review logic (though there is one for the dashboard)
- **Dashboard**: Cloudflare Workers/Pages, deployed via Wrangler
- **Local test harness**: a "crabbox" (`.crabbox.yaml`, `crabbox-hydrate.yml`) — appears to be a custom sandboxed local-execution harness for safely running Codex locally
- **Testing**: Node's built-in test runner (cross-platform script for Linux/macOS/Windows), plus a coverage ratchet that enforces coverage thresholds only on the *changed* surface (not whole-repo coverage), via `pnpm run check`

## Strengths

- **Strong separation of "propose" vs "apply."** The LLM only ever produces a proposal; a separate, deterministic, ledger-audited code path is the only thing that can mutate GitHub. This directly defends against prompt injection and model hallucination causing real damage (e.g., a malicious issue body can't trick the model into closing something, because closing requires a second independent validation pass right before the mutation).
- **Closed-set decision taxonomy.** Forcing close reasons into an enum with evidence requirements (rather than free-text justification) makes behavior auditable and reviewable, and easier to gate certain reasons (e.g., never auto-close if label=`security`).
- **Idempotency & dedupe primitives**: fingerprinting, lease-based concurrency, semantic/structural caches — these matter enormously at scale (thousands of issues/PRs) and are often skipped in smaller review bots.
- **Durable, resumable pipelines** instead of one long GitHub Actions job — repair work survives job timeouts/restarts via a queue+state model, which is unusual sophistication for an OSS bot.
- **Prompts as versioned files**, not embedded strings — easy to diff/review prompt changes like code changes.
- **In-place comment editing + marker-based status** avoids notification spam, a common annoyance with bot reviewers.
- **Explicit non-goals in VISION.md** (no autonomous merging, no releases, no unbounded spend) — a clearly scoped safety envelope, decided up front rather than organically.

## Weaknesses / Risks

- **Enormous operational surface for what the README calls a review bot** — 47 workflows, a Cloudflare dashboard, a custom local sandbox ("crabbox"), a repair sub-pipeline with 10+ workflows. This is a lot of infrastructure to maintain and a lot of attack surface (GitHub App with write permissions to Contents, Issues, PRs, Workflows, Actions, Checks). Not something a small team could stand up quickly.
- **Tightly coupled to one org's conventions** (`AGENTS.md`, `VISION.md`, its own close-reason taxonomy) — not obviously portable to an arbitrary repo without adapting those governance docs first.
- **Self-hosted only** — explicitly not offered as a hosted service for third-party repos; you must fork and run your own instance, including your own OpenAI billing and GitHub App.
- **Codex-process-based execution** (spawning a coding-agent subprocess per item) rather than a lightweight single completion call — heavier per-item cost/latency than a simple "send diff + prompt, get review comment" architecture. Reasonable for its "propose fixes and repair" scope but overkill if you only want lightweight PR review comments.
- **Command surface via issue comments** (`@clawsweeper autofix`, `/review`) is a classic prompt-injection vector; the mitigations (member/collaborator gating, no-write-creds-for-Codex, pre-mutation revalidation) are solid but add complexity that must all stay correct together — a single gap in the trust chain (e.g., misconfigured collaborator check) could be serious given the App's write scopes.
- **Reliance on GitHub Actions cron/dispatch for scheduling** at this workflow count risks GitHub Actions minutes/cost and eventual-consistency lag (their own "Apply Lane" runs every 15 min specifically because of this staleness risk).

## Lessons for Building Our Own PR Review Agent

1. **Separate "decide" from "act."** Have the LLM only ever emit a structured proposal (JSON, closed enum of actions/reasons). A separate, simple, deterministic component performs the actual GitHub mutation (post comment / request changes / merge) and re-validates state immediately beforehand. This alone closes most prompt-injection and hallucination risk.
2. **Version prompts as files, not inline strings**, and structure them with an explicit evidence bar ("prove the change actually works," not just "looks fine") plus a fixed vocabulary of possible verdicts — makes behavior debuggable and testable.
3. **Cache aggressively.** Semantic + structural caches keyed on content hash avoid rerunning (and re-paying for) the LLM when nothing relevant changed — important if you review on every push/comment rather than once.
4. **Use in-place comment editing with a small state marker** (e.g., an HTML comment or emoji marker identifying "this is ClawSweeper's status comment #N") instead of posting a new comment per run — much friendlier to contributors and maintainers.
5. **Gate write-triggering commands to verified org members/collaborators.** Anyone can comment on a PR/issue; do not let arbitrary external comments trigger autofix/automerge behavior.
6. **Give the model no write credentials at all** — it should call tools that return data or draft text, never tools that call the GitHub mutation API directly. Put the mutation behind your own audited code path with a ledger/log.
7. **Decide your scope up front and write it down** (their `VISION.md` "explicit limitations" section) — e.g., "never merges autonomously," "never operates outside allow-listed repos" — and enforce it structurally (config allow-list), not just via prompt instruction.
8. **Start much smaller than this.** ClawSweeper is a full org-scale maintenance platform (47 workflows, dashboard, repair pipelines). For a first PR-review agent, the useful subset is: (a) one webhook/Action trigger on PR opened/synchronize, (b) one prompt template with structured JSON output and an evidence bar, (c) one apply step that posts/edits a single review comment, (d) a simple ledger/log of what it decided and why. The lease/dedupe/queue machinery only becomes necessary at real scale.

## Sources

- [GitHub - openclaw/clawsweeper](https://github.com/openclaw/clawsweeper)
- [clawsweeper/README.md at main](https://github.com/openclaw/clawsweeper/blob/main/README.md)
- Repo tree/file browsing: `https://github.com/openclaw/clawsweeper/tree/main/src`, `.../tree/main/prompts`, `.../tree/main/docs`, `.../tree/main/.github/workflows`
- Raw files fetched directly: `README.md`, `VISION.md`, `package.json`, `.github/workflows/sweep.yml`, `.github/workflows/clawsweeper-dispatch.yml`, `prompts/review-item.md`
- [OpenClaw AI Agent: Automating GitHub Issue and PR Management — OpenClaw Times](https://www.openclawtimes.com/en/case/clawsweeper-openclaw-maintenance-bot.html)
- [openclaw/clawsweeper · AgentSkillsHub](https://agentskillshub.top/skill/openclaw/clawsweeper/)
