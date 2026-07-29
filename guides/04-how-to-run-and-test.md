# 04 — How to Run and Test It

Practical companion to [guide 01](./01-how-it-works.md). Covers local
development/testing (done, repeatable, green today) and the first live test
against a real GitHub PR (the deferred verification phase).

## Local dev

All commands use **`nub`**, not `npm` (this project's tooling rule — `nub` is
a full npm replacement).

```
nub install        # install workspace deps (root + all packages/*)
nub run build       # tsc -b — builds every package, engine → action/worker/scope-ts/rag
nub run test        # vitest run — the full unit-test suite
nub run eval        # node evals/run.mjs — the offline eval harness
```

What each verifies:

- **`nub run build`** (`tsc -b`) — type-checks and compiles every package in
  dependency order (`engine` first, since `action`, `worker`, `scope-ts`, and
  `rag` all depend on it). Also required before `nub run eval`, since the
  eval harness imports `packages/engine/dist/index.js` directly, not source.
- **`nub run test`** (`vitest run`) — the full suite. Confirmed while writing
  this guide: **399 tests passing across 32 test files** in ~6s, covering
  every engine module (diff parsing, noise filter, size cap, guardrail,
  clamp/anchoring, dedupe, suppress, config, gate, cost, scope, agentic,
  verify, escalate, state, incremental, runlog, model providers, publish,
  summary) plus the worker's route/webhook/auth handling and the action's
  payload mapping.
- **`nub run eval`** (`node evals/run.mjs`) — runs the *real* pipeline
  (`runReview`, `dryRun: true`) over 23 seeded dummy-PR cases in
  `evals/cases/*.mjs` (JS/TS/Python bugs, a cross-file signature break, a
  deliberate false-positive the verifier should drop, and several clean
  PRs), scored for expected-found / expected-missed / unexpected findings.
  Default mode is an offline **replay** provider (canned responses per case,
  fully deterministic) — confirmed passing: `18/18` expected findings found,
  `0` unexpected, `1` verifier-drop, exit 0. Set `REVIEW_MODEL=gemini` (or
  `haiku`/`groq`) with the matching API key exported to run the same cases
  against a **live** model instead — that live-mode run is what task 6.8
  (below) actually needs.

## Getting an API key

Two realistic choices, per `research/08-synthesis-architecture-and-milestones.md` §2:

- **Gemini 2.5 Flash free tier (AI Studio)** — for dev/prompt-iteration.
  Free, ~1,000 requests/day, zero cost while burning hundreds of test runs.
  **ToS caveat**: Google's AI Studio free tier has data-use terms that make
  it inappropriate for proprietary/private code — use it only against the
  public/throwaway testbed repo, never a real private codebase (`design.md`
  Risks section). Set `GEMINI_API_KEY` and `REVIEW_MODEL=gemini`.
- **Anthropic Claude Haiku 4.5** — the quality default for real reviews
  (~$0.005–0.008/review with prompt caching on the stable system prompt).
  Use this for anything beyond the disposable testbed. Set
  `ANTHROPIC_API_KEY` and `REVIEW_MODEL=haiku` (also the default if
  `REVIEW_MODEL` is unset).

Groq (`GROQ_API_KEY`, `REVIEW_MODEL=groq`) is the free secondary fallback if
Gemini's free tier is unavailable — see `packages/engine/src/model.ts`.

## The first live test (deferred-verification phase)

This is the work still pending — everything up to here is done and repeatable
offline; this section is the checklist for when Ansh is ready to actually run
the bot against GitHub. Steps, in order:

1. **Push the testbed repo.** `code-review-testbed` (a separate local git
   repo at `C:\Users\Ansh\Documents\ANSH\code-review-testbed`, seeded with
   `src/pricing.ts`, `src/slugify.js`, `src/retry.ts`) is not on GitHub yet.
   `gh repo create anshace/code-review-testbed --private --source . --push`
   — a manual, Ansh-only step (see `docs/dummy-pr-workflow.md`).
2. **Publish the bot** far enough that the testbed workflow can invoke it —
   either the full Mode B packaging from
   [guide 02](./02-plan-b-open-source-action.md) (`action.yml` + ncc bundle +
   `v1` tag, then `uses: anshace/loupe@v1`), or the simpler interim
   invocation already sketched (commented out) in
   `code-review-testbed/.github/workflows/review.yml`: check out
   `anshace/loupe`, `npm ci && npm run build`, then run
   `node .review-bot/packages/action/dist/main.js` directly. Either way the
   bot repo has to be pushed to GitHub first.
3. **Add the workflow + secret.** Un-comment the real invocation in
   `.github/workflows/review.yml` (currently a placeholder echo step), and
   add the LLM key as a repo secret (`ANTHROPIC_API_KEY` or `GEMINI_API_KEY`
   — see above).
4. **Open a dummy PR with a seeded bug.** Per `docs/dummy-pr-workflow.md`:
   branch off `main`, introduce a subtle bug (e.g. flip `applyDiscount` to
   add instead of subtract, or the `truncateSlug` off-by-one), commit, then
   `gh pr create --base main`.
5. **Confirm, checked off against the exact deferred task IDs in
   `openspec/changes/build-pr-review-agent/tasks.md`:**

   | Task | Check |
   |---|---|
   | **2.4** | Opening the PR produces a comment within ~1 min using only `GITHUB_TOKEN`; re-running the workflow doesn't crash. |
   | **3.11** | The seeded-bug PR gets ≥1 correct inline comment anchored to the right line; a docs-only PR gets a clean "no issues found" summary; deliberately garbage LLM output never crashes the run; total run time <2 min. |
   | **4.12** | Push a second commit to the same PR — zero duplicate comments; the summary comment is edited in place, not re-posted; add a `HOUSE_RULES.md` `suppress:` rule matching the seeded bug and confirm it's suppressed; open a draft PR and confirm it gets no comments at all. |
   | **4.13** | A repo with no `.aireview.toml` reviews on documented defaults; commit a broken (unparseable) `.aireview.toml` and confirm the run still completes with a visible "invalid config" notice in the summary, never a crash; edit the config and confirm the next PR picks it up with no redeploy. |
   | **6.8** | Run `REVIEW_MODEL=haiku nub run eval` (live mode, real API key) over the 23-case eval set: verifier (`verify: true`) kills ≥30% of raw findings and the drops are correct on manual inspection; at least one cross-file break (`cross-file-signature-break` case) is caught via agentic search; no case exceeds the cost cap. |
   | **7.7** | Push a 1-line fix to a large (~50-file) dummy PR with `REVIEW_STATE_PATH` set — confirm only the new commit range is reviewed (summary notes "incremental review" + any already-reviewed-hunk skips), and still-unfixed prior findings appear under "Still open from previous runs," not re-posted inline. |
   | **7.8** | Add a `[[rules]]` entry to `.aireview.toml` (e.g. `pattern = "src/api/**"`, `text = "All API handlers must validate input with zod"`) and confirm it fires on a violating PR; then write the RAG-on vs RAG-off comparison note in `docs/` from live eval-set runs (`packages/rag`'s `InMemoryRetriever`, flag `rag: true`). |

6. **App-path checks, once/if the App is ever deployed** (task **5.1** —
   register the App per `docs/github-app-setup.md`; task **5.9** — App
   installed on ≥2 local test repos reviews both with no workflow file,
   forged/unsigned webhooks get 401, collaborator `/review` triggers a run
   with a 👀 reaction ack, non-collaborator `/review` produces nothing). This
   whole path is deferred by design — see
   [guide 03](./03-future-github-app.md) — and only relevant if/when Mode A
   is revisited.

## Where to look when tuning

- **`prompts/`** — the actual reviewer/verifier instructions, versioned
  (`reviewer-v1.md` … current default `reviewer-v4.md`, `verifier-v1.md`).
  Never edit a shipped file in place; a prompt change ships as `v(N+1)` so
  runs stay reproducible and A/B-testable (`prompts/README.md`).
- **`.aireview.toml`** at the target repo's root — `enabled`, `min_severity`,
  `ignore` (glob array), and `rules` / `[[rules]]` (custom, optionally
  path-scoped review rules). Schema and the tiny dependency-free TOML subset
  it accepts: `packages/engine/src/config.ts`.
- **`HOUSE_RULES.md`** at the target repo's root — freeform guidance injected
  into the reviewer prompt, plus deterministic `suppress: <substring>` lines
  for guaranteed suppression. Full convention:
  `docs/house-rules-suppression.md`.
- **The run log** — set `REVIEW_RUN_LOG_PATH` (Action) to get one JSONL
  record per run: model, real token counts, estimated cost, findings
  kept/dropped with a drop-reason histogram, whether the verifier ran,
  whether escalation fired, whether the run was incremental. This is the
  self-analytics source referenced by task 7.8's RAG comparison note
  (`packages/engine/src/runlog.ts`).
- **State for incremental re-review** — set `REVIEW_STATE_PATH` (Action) to
  enable hunk-hash skipping and still-open carry-forward across pushes;
  without it the engine stays stateless (summary-marker SHA only). Full
  model: `docs/state-and-incremental.md`.
