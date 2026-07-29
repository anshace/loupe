# Loupe

A self-built AI pull-request review agent (à la CodeRabbit / Qodo PR-Agent), built
by Ansh Roshan as a learning-first, real project. Named for the jeweler's lens —
close, careful inspection of every diff.

## Usage (GitHub Action)

Drop this in a repo at `.github/workflows/ai-review.yml`. On every pull request
the agent reviews the diff and posts inline comments plus one summary comment,
using your own LLM key — no server to run.

```yaml
name: AI PR Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read        # read .aireview.toml / HOUSE_RULES.md at the PR head
  pull-requests: write  # post the batched review + inline comments
  issues: write         # upsert the summary comment

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: anshace/loupe@v1
        with:
          llm-api-key: ${{ secrets.LLM_API_KEY }}
          review-model: haiku          # gemini | haiku | groq
          # min-severity: medium       # critical | high | medium | low | nit
          # config-path: .aireview.toml
          # state-path: .aireview-state.json   # persist via actions/cache for incremental re-review
          # run-log-path: .aireview-runlog.jsonl
```

Add your provider key as a repository secret named `LLM_API_KEY`
(Settings → Secrets and variables → Actions). `github-token` defaults to the
workflow token, so you don't need to set it.

**Which key?** `review-model: gemini` uses a **free** Google AI Studio key
(<https://aistudio.google.com/apikey>) — the $0/mo path. `review-model: haiku`
(the default) uses an Anthropic API key (<https://console.anthropic.com>) for
higher-quality reviews and enables risky-path escalation to a stronger model.
`groq` is a free Llama fallback.

## Repository layout

| Path | Purpose |
|------|---------|
| `openspec/` | Source of truth — spec-driven changes (proposal → specs → design → tasks) |
| `research/` | Research: competitor repos, product landscape, GitHub integration mechanics, RAG strategies, stack & cost analysis, synthesis + milestones |
| `docs/` | Personal notes (solo project — no separate team docs) |
| `src/` | Implementation (created during `/opsx:apply`) |

## Where to start

1. `research/08-synthesis-architecture-and-milestones.md` — architecture + roadmap
2. `openspec/changes/build-pr-review-agent/proposal.md` — what & why
3. `openspec/changes/build-pr-review-agent/design.md` — how
