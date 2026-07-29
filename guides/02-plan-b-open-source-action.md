# 02 — Plan B: The Open-Source GitHub Action (current plan)

This is **Mode B** from [guide 01](./01-how-it-works.md) — the delivery mode
Ansh is building toward *right now*. Everything below reflects the actual
code in this repo as of today, plus what's still missing to make it
installable by a stranger.

## Why the Action ships first

Compared to the App (Mode A, [guide 03](./03-future-github-app.md)):

- **No hosting.** The review runs inside the consumer's own GitHub Actions
  runner. There is no server for Ansh to keep alive, patch, or pay for.
- **No ongoing cost to Ansh.** Each user brings their own LLM API key (see
  below); Ansh's account is never billed for anyone else's reviews.
- **No webhook security surface.** No HMAC verification, no App private key,
  no installation-token minting — `GITHUB_TOKEN` is already scoped and
  managed by GitHub per-workflow-run.
- **Fastest path to real usage.** A public Action on the Marketplace (or even
  just a tagged repo) is `uses: anshace/loupe@v1` away for any
  consumer; there's no App registration or deploy step gating adoption.

This is also literally milestone order in `design.md`: Action first (M0–M2),
App later (M3+), with the engine written to be trigger-agnostic from day one
so the transition never requires a rewrite.

## How a CONSUMER uses it

A consumer repo needs exactly two things: a workflow file, and their own LLM
API key as a repo secret. No install step, no App to authorize.

```yaml
# .github/workflows/review.yml
name: AI PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: anshace/loupe@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # Pick ONE provider and set its key as a repo secret:
          ANTHROPIC_API_KEY: ${{ secrets.LLM_API_KEY }}   # Claude Haiku 4.5 (quality default)
          # GEMINI_API_KEY: ${{ secrets.LLM_API_KEY }}    # or: Gemini 2.5 Flash (free tier)
          # GROQ_API_KEY: ${{ secrets.LLM_API_KEY }}      # or: Groq Llama (free fallback)
          REVIEW_MODEL: haiku   # haiku | gemini | groq — must match the key you set above
```

That's it. `GITHUB_TOKEN` is auto-provided by Actions with the
`permissions:` block above; the LLM key is the one secret the consumer adds
themselves. The engine already reads `REVIEW_MODEL`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, and `GROQ_API_KEY` directly from the environment
(`packages/engine/src/model.ts` — `resolveProviderChoice`, and each
provider's `complete()`), so this is real, working wiring today — the only
missing piece is the Action manifest that lets `uses: anshace/loupe@v1`
resolve to it at all (next section).

Optional per-repo tuning (`.aireview.toml`, `HOUSE_RULES.md`) is documented in
[guide 04](./04-how-to-run-and-test.md#where-to-look-when-tuning).

## How ANSH publishes it

Three things are needed to make the snippet above actually resolve, and
**none of them exist in the repo yet** — this is the concrete next work,
being added now:

1. **`action.yml` at the repo root.** A GitHub Action manifest, currently
   absent (confirmed: no `action.yml` anywhere in this repo). It needs to
   declare a Node-based action pointing at a bundled entry point, roughly:

   ```yaml
   name: "AI PR Review"
   description: "AI-powered pull request review — bring your own LLM key"
   inputs: {}
   runs:
     using: "node20"   # or whatever Node runtime GitHub Actions supports when this is built
     main: "dist/index.js"
   ```

2. **An ncc-bundled `dist/` actually committed to git.** Today,
   `packages/action` compiles with plain `tsc` into `packages/action/dist/`,
   but the **repo-wide `.gitignore` ignores `dist/` everywhere** — so nothing
   is committed, and even if it were, `tsc` output still `require()`s
   `@actions/core`, `@actions/github`, and `@code-review/engine` from
   `node_modules`, which a consumer's Actions run never installs (GitHub just
   checks out the tagged Action repo — it doesn't run `npm ci` for it).
   Consumers need one self-contained JS file with every dependency inlined.
   The standard tool for this is `@vercel/ncc` (what `actions/checkout` and
   most published Actions use): `nub x ncc build packages/action/src/main.ts
   -o dist`, with an explicit `.gitignore` carve-out so that one bundled
   `dist/` is tracked despite the global ignore rule.
3. **Tag a release, `v1`.** Once the manifest + bundle are committed on
   `main`, `git tag v1 && git push origin v1` (a major-version tag,
   conventionally re-pointed at each `v1.x` release) is what makes
   `uses: anshace/loupe@v1` resolve for anyone.

Optional, once the above exists and works end-to-end: list it on the
**GitHub Marketplace** (free — Marketplace listing costs nothing for an
Action, only for paid Apps) so it's discoverable outside people who already
know the repo name.

Per project rules, none of this gets pushed to GitHub until the whole app is
built and locally tested — the bundling work can be prepared locally now,
but publishing/tagging waits for the deferred live-verification phase in
[guide 04](./04-how-to-run-and-test.md).

## Cost model: zero to Ansh

Every consumer supplies their own LLM key and pays their own provider bill —
Gemini's free tier costs literally nothing (~1,000 req/day, with the caveat
in guide 04 about not using it on proprietary code), and Claude Haiku 4.5
runs about $0.005–0.008 per review with prompt caching
(`research/08-synthesis-architecture-and-milestones.md` §5). GitHub Actions
minutes are free on public repos and cheap on private ones (a review job is
under 2 minutes). **Ansh's account is never charged for anyone else's PR
reviews** — this is the structural advantage of Mode B over Mode A (compare
[guide 03](./03-future-github-app.md), where one server-side key means Ansh
funds every installation).
