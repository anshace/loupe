# Repo Analysis: liliu-z/magpie — Multi-AI Adversarial PR Review Tool

**Repo**: https://github.com/liliu-z/magpie
**Author**: liliu-z (Li Liu), also author of a related project [ai-code-review-arena](https://github.com/liliu-z/ai-code-review-arena) (a benchmark evaluating 5 AI models on bug detection in real Milvus PRs, built on Magpie's orchestration engine).
**Status**: Active/experimental open-source CLI tool, TypeScript, npm-installed via `npm link` (no npm registry package, no GitHub Action / hosted bot — it is a **local CLI you run yourself**, invoked manually or from your own automation).
**Research date**: 2026-07-29 (fetched via `gh api` — repo tree, README, and ~13 key source files read directly from GitHub)

---

## 1. What It Is

Magpie is fundamentally different in shape from most "AI PR review bot" projects: it is not a GitHub App/Action that auto-triggers on `pull_request` webhooks and posts a review. It is a **CLI tool** (`magpie review <pr>`) that a developer runs manually (or wires into their own CI/cron) which:

1. Spins up **multiple independent AI reviewers** (different models/providers) to review a PR/diff in parallel.
2. Runs them through a **structured multi-round debate** where reviewers see each other's opinions in later rounds and can agree/disagree.
3. Detects **convergence** (consensus) via a dedicated "judge" LLM call to stop early and save tokens.
4. Extracts raised issues into **structured JSON**, deduplicates/merges overlapping ones across reviewers.
5. Runs a dedicated **Verify+Audit pass** — a tool-equipped "auditor" LLM that re-reads the actual code (via CLI tool access: Read/Grep/Glob/Bash) to confirm, rewrite, drop (false positives), or add new issues.
6. Offers an **interactive post-processing flow** to review/edit/approve each issue before posting inline comments to the GitHub PR via `gh` CLI.

Tagline (from README): "Multi-AI adversarial PR review tool."

---

## 2. Architecture

### Directory layout
```
src/
  cli.ts                     # commander entrypoint (review, init, discuss, stats)
  commands/
    review.ts                # main `magpie review` command — target resolution, orchestration wiring, output, GitHub posting
    review/interactive.ts    # reviewer selection, Q&A, comment review/approval loop
    review/repo-review.ts    # whole-repo review mode
    discuss.ts, init.ts, stats.ts
  config/                    # YAML config loader/types (~/.magpie/config.yaml)
  context-gatherer/          # pre-review "system impact" context (call chains, history, docs, related PRs)
  feature-analyzer/          # whole-repo feature detection/caching (for --repo mode)
  orchestrator/
    orchestrator.ts          # DebateOrchestrator — the core state machine
    issue-parser.ts           # JSON extraction + dedup/merge of reviewer-raised issues
    repo-orchestrator.ts
  providers/                 # one file per LLM backend (see §5)
  github/commenter.ts        # gh CLI wrapper: classify + post inline/file/global PR comments, dedup
  history/tracker.ts         # persists past reviews, diffs "fixed / still-open / new" issues across runs
  planner/                   # feature-planner for repo review mode
  repo-scanner/, reporter/, state/, utils/
tests/                        # mirrors src/, decent unit-test coverage (Vitest-style, per-module)
docs/plans/                   # design + implementation plan docs (dated 2026-01-26)
```

### Core flow (`DebateOrchestrator.runStreaming`)
1. **Pre-analysis** (parallel with context gathering): an `analyzer` LLM call summarizes what the PR does, architecture implications, and suggests "Suggested Review Focus" areas (parsed back out via regex, supports Chinese/English headings — heavy i18n investment).
2. **Context gathering** (optional, parallel to analysis): traces call chains of changed symbols, digs repo history for related PRs, pulls doc references — produces a `GatheredContext` injected into round-1 prompts.
3. **Round 1 (independent)**: every reviewer gets the *same* prompt (task + analysis + focus hints + context) and reviews **independently** — they do not see each other yet. This is the "fair" part of the debate design.
4. **Rounds 2..N**: each reviewer now sees *only previous rounds'* messages from others (not the current round's peers) — enforced by careful message-history slicing (`buildMessages`) so that same-round reviewers always have identical information (no first-mover advantage).
5. **Convergence check** after each round (unless disabled or solo reviewer): a separate LLM call acts as a "strict consensus judge" with an explicit rubric (same verdict, no ignored critical issues, no unaddressed disagreement) and must emit `CONVERGED`/`NOT_CONVERGED` on the last line. Stops the debate early if converged — explicitly framed as a token-cost optimization.
6. **Final conclusion**: summarizer LLM synthesizes consensus/disagreement/action items across the whole conversation.
7. **Structurize issues**: a dedicated LLM call converts the free-text reviewer discussion into a strict JSON array of `{severity, category, file, line, title, description, suggestedFix, raisedBy}`, with up to 3 retry attempts on invalid JSON, constrained explicitly to only reference changed files and valid diff line ranges (computed programmatically from the diff, not just trusted to the LLM).
8. **Verify+Audit** (the standout feature): a tool-equipped "auditor" reviewer (with Read/Grep/Glob/Bash access) re-examines every structured issue against the *actual* code, must cite `evidence` (file:line + quoted line) for anything kept, can `drop` false positives with a categorized `reason` enum (codebase-convention / pre-existing / theoretically-impossible / style-out-of-scope / false-claim), can `rewrite` weak descriptions, and can propose brand `new` issues found by its own additional pattern-grep pass (e.g., "same bug repeated in another file"). Supports an optional per-repo `~/.magpie/house-rules/<owner>_<repo>.md` file whose conventions "override reviewer claims."
9. **Post-processing / GitHub posting**: interactive terminal flow — general discussion phase, then issue-by-issue approve/edit/discuss/skip, then posts via `gh api .../pulls/{n}/reviews` (batched inline comments) with fallback chain: inline comment on exact diff line → nearest valid diff line (content-matched via code-snippet search, then line-proximity within 50 lines) → file-level comment → global PR comment. Includes duplicate-comment detection against existing PR comments before posting.
10. **History tracking**: saves parsed issues per repo/target and diffs against the last run to report "fixed / still open / new" issue counts.

---

## 3. PR Trigger Mechanism

**There is no automatic trigger.** Magpie is explicitly a manual/local CLI tool:
- `magpie review <pr-number-or-url>` — reviews a specific PR (resolves via `gh pr view`, handles forks).
- `magpie review --local` — reviews uncommitted staged+unstaged changes (falls back to last commit if none).
- `magpie review --branch [base]` — reviews current branch vs. a base branch.
- `magpie review --files <files...>` — reviews specific files.
- `magpie review --repo` — reviews an entire repository (separate feature-analyzer/planner pipeline, with `--quick`/`--deep`/`--plan-only`/`--reanalyze` modes and caching by content hash).

Since it shells out to `gh` for everything (PR metadata, diff, comment posting), it inherits GitHub auth from the user's `gh` CLI session — no separate GitHub App, webhook server, or token management layer. A team wanting automatic triggering would have to wrap `magpie review <pr>` in their own GitHub Action (`--no-post` + `--format json` + `--output file` for headless/CI use, since the default interactive posting flow requires a TTY).

---

## 4. Context Gathering

Distinct, well-separated `context-gatherer` module, run **in parallel with** (not blocking) the analyzer call:
- **Reference/call-chain collector**: extracts symbols from the diff, traces call chains up to a configurable depth (`maxDepth`, `maxFilesToAnalyze`), producing "Affected Modules" with an impact-level classification (core/moderate/low) — shown to the user with colored dots in the CLI.
- **History collector**: looks at recent repo history (configurable `maxDays`/`maxPRs`) to surface related past PRs.
- **Docs collector**: reads configurable doc patterns (`docs`, `README.md`, `ARCHITECTURE.md`, `DESIGN.md`) up to a size cap, presumably to ground the analyzer in project conventions.
- The gathered context (`GatheredContext.summary`, `rawReferences`, `affectedModules`, `relatedPRs`) is injected into Round-1 reviewer prompts as a `## System Context` + formatted call-chain section, so reviewers get project-level grounding beyond the raw diff.
- Entirely optional (`--skip-context`, or config-disabled), and independently model-selectable (`contextGatherer.model` can differ from the main analyzer/reviewer models — e.g., cheaper model for this step).

This is a genuinely more sophisticated context strategy than diff-only review: it tries to answer "what else in the system does this change touch" before the reviewers even start, and feeds "focus areas" extracted from the analyzer output back into every reviewer's prompt as soft hints ("suggests focusing on X; also flag anything else").

---

## 5. LLM Usage / Prompting

### Provider abstraction (`src/providers/`)
A clean `AIProvider` interface (`chat`, `chatStream`, optional `startSession`/`endSession`/`sessionId`) implemented for:
- **CLI-subscription providers** (no API key needed, use the user's existing subscription): `claude-code` (spawns `claude -p - --dangerously-skip-permissions --effort max`), `codex-cli`, `gemini-cli`, `antigravity` (agy), `qwen-code`.
- **API-key providers**: `anthropic`, `openai` (`gpt*`), `google`/gemini API, `minimax` (hardcoded to `MiniMax-M2.5`).
- **Custom endpoints**: any of the above can point `base_url` at Azure OpenAI / Ollama / vLLM-compatible endpoints via config.
- **`mock`**: a deterministic mock provider for tests/dry-runs (`config.mock: true` globally overrides everything).

Model strings encode provider selection, e.g. `gemini-cli:gemini-2.5-pro`, `claude-code` (default model), `claude-3-5-sonnet` (routes to Anthropic API by prefix-matching `claude*`/`gpt*`/`gemini*`).

### CLI-mode vs API-mode prompt construction (key design choice)
`review.ts` checks whether **all** configured models (reviewers + analyzer + summarizer) are CLI-based:
- **All-CLI mode**: reviewers are simply told "Use `gh pr diff <url>` to get the diff, then use Read/Grep to examine source files" — the LLM does its own tool-driven investigation of the live repo. No diff is pre-fetched by Magpie.
- **Mixed/API mode**: Magpie pre-fetches the diff itself (`gh pr diff`), filters it (excludes generated files via configurable glob patterns), and embeds it directly in the prompt — because API-only models have no filesystem/tool access. Includes a **large-PR fallback**: if GitHub's diff endpoint 406s (>20k lines), it reconstructs the diff from the paginated per-file patches API (`fetchLargePRDiff`, capped at ~15k lines with a truncation note appended to the prompt).

### Claude Code CLI integration details (notable engineering)
- Spawns `claude` with `--dangerously-skip-permissions` (needed so the subprocess can run `gh`/network commands unattended) and `--effort max`.
- Streaming mode uses `--output-format stream-json --verbose` specifically so that *tool-use* events (Read, Bash, etc.) also count as "activity," preventing an inactivity-timeout kill while Claude is silently investigating code — a real pitfall of long tool-using reviews.
- Session support (`--session-id` / `--resume`) lets a reviewer's conversation persist context across debate rounds without re-sending the whole history each time (`shouldSendFullHistory` vs `buildPromptLastOnly`).
- Explicitly strips `CLAUDECODE` env var before spawning, to avoid the child process detecting it's nested inside a Claude Code session.
- `--tools ''` (disableTools) is used for the pure-text structurization/audit calls where tool use would derail the model into editing files instead of emitting JSON — except the *audit* call, which deliberately keeps tools enabled since it needs Read/Grep/Bash to verify claims.

### Prompt engineering highlights (unusually detailed, worth studying directly)
- **Round-1 reviewer prompt** enforces a strict format per issue: exact `file:line` (inside diff hunks only — "lines outside hunks are wasted, GitHub can't anchor them"), a 1-3 line code quote, concrete failure scenario, and a severity self-rating against an explicit 5-tier rubric (critical/high/medium/low/nitpick with hard definitions). It also has an explicit **do-not-report list**: no CI/build polish, no missing docstrings, no speculative "someone might later..." concerns, no dead code unless risky, no style nits, nothing outside the diff unless severity≥high, no "theoretically correct but practically impossible" cases (e.g. int64 overflow on 64-bit). Explicit brevity directive: "5 well-evidenced issues > 20 weak ones."
- **Convergence-judge prompt**: a deliberately adversarial, skeptical rubric ("Be VERY conservative — if there is ANY doubt, respond NOT_CONVERGED"), with explicit false-consensus traps called out (silence ≠ agreement, differing severities ≠ consensus).
- **Structurizer prompt**: converts free-text discussion to JSON, with a fixed category enum (12 values), a strict rule that `line` must fall in valid diff ranges (computed programmatically and injected as a constraint string) or be omitted entirely, and multi-attempt retry with an explicit "your previous output wasn't valid JSON" correction prompt.
- **Audit/Verify prompt** (the most elaborate one) instructs the tool-equipped auditor to never guess, always cite `evidence`, use a closed `reason` enum for drops, cross-grep the whole diff for repeated instances of the same bug pattern, check orthogonal callers of touched interfaces, and respect a repo-specific house-rules file that "overrides reviewer claims." Output is a fixed JSON schema (`verifiedIssues[]` with verdict keep/rewrite/drop/new).
- **i18n**: a `language` config option threads a "you MUST respond in X" instruction through every single prompt (prefix for system prompts, suffix for user prompts), and the focus-area parser explicitly supports Chinese heading variants alongside English — suggesting the primary dev/user base may be bilingual (Chinese/English).

---

## 6. Comment Posting (`src/github/commenter.ts`)

All via the `gh` CLI (no direct REST/GraphQL client, no Octokit dependency) — noteworthy because it inherits the user's `gh` auth for free but ties portability to `gh` being installed/logged in.

- **Diff-line validation**: parses the unified diff patch per-file to build a `Set<number>` of valid right-side line numbers (`parseDiffLines`) before attempting to comment, since GitHub rejects inline comments on lines not part of the diff.
- **Fallback chain per comment**: exact inline line → content-based line match (extracts a code snippet from the comment body via regex, greps the patch for that snippet's actual line) → nearest valid diff line within 50 lines → file-level comment (`subject_type: file`) → global PR comment. Every fallback annotates the body with the originally-intended line ("**Line 42:**") so context isn't lost.
- **Batch posting** via the Reviews API (`POST /pulls/{n}/reviews` with a `comments[]` array) for efficiency, with per-comment fallback to individual `postComment` calls if the batch call fails.
- **Dedup**: fetches existing PR review comments first and skips posting anything matching path+line+first-100-chars of body — makes repeated runs against the same PR idempotent.
- **Large-file handling**: when GitHub's file-list API returns `patch: null` for large files, falls back to reconstructing per-file patches from the full unified diff.

---

## 7. Tech Stack

- **Language**: TypeScript (ESM, `.js` import extensions), compiled via `tsc`.
- **CLI**: `commander` for command parsing, `ora` for spinners, `chalk` for color, `marked` + `marked-terminal` for rendering markdown responses in-terminal, `readline` for interactive prompts.
- **GitHub**: shells out to `gh` CLI exclusively (no SDK) — for PR metadata, diffs, comment/review posting, and `--paginate` file listings.
- **No database** — state is flat files (`~/.magpie/config.yaml`, `~/.magpie/house-rules/*.md`, history tracker presumably JSON files under a state dir).
- **Testing**: dedicated `tests/` tree mirroring `src/`, appears to be genuinely unit-tested per module (config loader, issue parser, providers, orchestrator resilience/session behavior, repo scanner, etc.) rather than only e2e-tested.
- **Distribution**: git-clone + `npm install && npm run build && npm link` — not published to npm registry, no Docker image, no GitHub Action packaging. Pure local tool.

---

## 8. Strengths

1. **Multi-model adversarial debate with genuinely fair information symmetry** — the round-based message-slicing logic (`buildMessages`) is carefully engineered so same-round reviewers never see more than their peers; round 1 is truly independent so identical conclusions across different models is real signal, not anchoring.
2. **Verify+Audit as a first-class second pass** — most PR-review tools stop at "LLM says X is a bug." Magpie's auditor step re-reads the actual code with tools, demands cited evidence, and has a principled taxonomy for rejecting false positives (this is the single most transferable idea for a homegrown reviewer).
3. **Convergence detection saves cost** — explicit token-budget awareness baked into the architecture, not just an afterthought.
4. **CLI-subscription providers as first-class citizens** — recognizing that `claude-code`/`gemini-cli`/`codex-cli` are effectively free (already-paid subscriptions) and give tool access "for free" (Read/Grep/Bash) is a smart way to sidestep both API cost and the diff-only context-poverty problem that plagues most PR bots.
5. **Diff-line-aware issue anchoring throughout the pipeline** — programmatically computed valid line ranges are injected as hard constraints into the structurizer prompt (not just hoped for from the LLM), and the commenter has a robust multi-level fallback so comments almost never silently fail to post.
6. **Per-repo house rules file** — lets teams encode "don't flag X, it's intentional here" conventions that persist across all future reviews without re-prompting every model every time.
7. **Detailed, opinionated prompt engineering** — the do-not-report list, severity rubric, and "brevity is a feature" framing directly target the classic AI-review complaint of noisy, low-value nitpicking.
8. **Reasonable test coverage** for a solo/small open-source project — orchestrator resilience and session behavior are explicitly tested, not just the happy path.
9. **Session reuse** for CLI providers to avoid re-sending full conversation history each round (cost/latency optimization specific to stateful CLI tools).

## 9. Weaknesses / Gaps

1. **No automatic trigger / no bot mode out of the box** — it is a manual CLI tool. A team wanting "auto-comment on every new PR" must build the webhook/Action layer themselves (feasible via `--no-post --format json`, but not provided).
2. **Hard dependency on `gh` CLI** — no native GitHub API client; brittle to `gh` version/auth quirks, and everything is `execSync`/`spawn` shelling, which is harder to unit test and to run in constrained CI sandboxes (also a security surface: multiple string-built shell commands, though PR numbers and remote names are validated with regexes).
3. **Interactive-first UX** — the primary comment-posting flow assumes a TTY and human-in-the-loop approval (readline prompts); the non-interactive/bot path (`--no-post`, `--no-conclusion`) is there but clearly secondary, and less battle-tested than the interactive path based on code volume.
4. **Cost/latency multiplier** — running N reviewers × M rounds × convergence-judge × summarizer × structurizer × auditor is a lot of LLM calls per PR (potentially 10+ calls for even a 2-reviewer, 2-round review); token tracking is only an *estimate* (rough char-count heuristic, not real usage from provider responses) and cost is a flat `$0.01/1K` guess regardless of actual model pricing — not accurate for cost governance.
5. **No persistent database / dashboard** — history tracking is local flat files tied to the developer's machine; there's no team-visible view of review history, trends, or accepted/rejected findings across a repo, unlike a hosted product would offer.
6. **Single-maintainer, early-stage project** (design/implementation docs dated 2026-01-26, i.e., ~6 months old at research time) — no evidence of large-scale production adoption, no CI badges/releases visible in the fetched tree, so maturity/stability claims should be treated cautiously.
7. **Convergence and audit steps add real latency** — an extra full LLM round-trip per round just to judge consensus, plus a final full-repo-reading audit pass, meaningfully lengthens wall-clock review time versus a single-pass reviewer.
8. **CLI-mode prompts trust the LLM to fetch its own diff correctly** — for all-CLI configurations, Magpie doesn't verify the model actually ran `gh pr diff` or read the right files; a model could hallucinate without being caught until the audit stage (which itself is LLM-judged, not deterministically verified).

---

## 10. Lessons for Building Our Own PR Review Agent

1. **Separate "reviewer" and "auditor/verifier" as distinct LLM roles with distinct tool access.** The verify pass (tool-equipped, evidence-required, closed drop-reason taxonomy) is the highest-leverage idea here for cutting false positives — steal this even if we don't do multi-model debate.
2. **Compute diff-valid-line-ranges programmatically and inject as a hard prompt constraint**, rather than trusting the LLM to only cite in-diff lines. This alone will reduce "GitHub rejected this comment" failures.
3. **Build a robust comment-posting fallback chain** (inline exact line → content-matched line → nearest line within N → file-level → global comment) plus **dedup against existing comments** — this is cheap to implement and directly avoids the two most common integration bugs (silently-dropped comments, duplicate spam on re-runs).
4. **Give reviewers an explicit "do not report" list and a strict severity rubric with concrete definitions**, not just "review this code" — this is the single biggest lever against noisy AI review complaints from real teams.
5. **Consider a CLI-subscription-provider tier** (if your target users already pay for Claude Code/Codex/Gemini CLI subscriptions) as a zero-marginal-cost, tool-having alternative to raw API calls — but be aware you inherit all the subprocess-management complexity (activity-based timeouts, env var stripping, streaming JSON event parsing) that comes with it.
6. **If doing multi-round/multi-model debate, enforce information symmetry deliberately** — the "same round sees same information" invariant is easy to violate accidentally and is worth unit-testing directly (Magpie does).
7. **Decide trigger/hosting model deliberately, up front.** Magpie chose "local CLI, human-in-the-loop" — reasonable for a dev tool, wrong shape if the actual goal is an always-on bot that reviews every PR automatically; our own agent should pick its shape (CLI vs. GitHub Action vs. hosted webhook service) based on the actual deployment target rather than bolting automation on after the fact.
8. **Support a repo-level "house rules" override file** for known false-positive patterns/conventions — cheap to add, meaningfully reduces repeat noise once a team has triaged findings once.
9. **Track real token usage from provider API responses where available**, not char-count heuristics, if cost governance matters — Magpie's estimate approach is a known-inaccurate shortcut worth avoiding in a production tool.
10. **Convergence detection is a nice cost-saving idea for multi-reviewer setups**, but weigh the extra LLM round-trip it costs against the token savings it's supposed to provide — only pays off with ≥3 rounds configured.

---

## Sources

- Repo root & file tree: https://github.com/liliu-z/magpie (fetched via `gh api repos/liliu-z/magpie/git/trees/main?recursive=1`)
- README: https://raw.githubusercontent.com/liliu-z/magpie/main/README.md
- Key source files fetched directly (via `gh api repos/liliu-z/magpie/contents/<path>`): `src/cli.ts`, `src/commands/review.ts`, `src/github/commenter.ts`, `src/orchestrator/orchestrator.ts`, `src/orchestrator/issue-parser.ts`, `src/providers/factory.ts`, `src/providers/claude-code.ts`, `src/config/types.ts`, `src/context-gatherer/gatherer.ts`
- Related project (same author): https://github.com/liliu-z/ai-code-review-arena
- Web search confirming repo identity: search query "liliu-z magpie github AI PR review agent" (2026-07-29)
