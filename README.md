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
          provider: anthropic          # openai | anthropic | gemini (see below)
          model: claude-haiku-4-5
          # min-severity: medium       # critical | high | medium | low | nit
          # config-path: .aireview.toml
          # state-path: .aireview-state.json   # persist via actions/cache for incremental re-review
          # run-log-path: .aireview-runlog.jsonl
```

Add your provider key as a repository secret named `LLM_API_KEY`
(Settings → Secrets and variables → Actions). `github-token` defaults to the
workflow token, so you don't need to set it.

## Model providers

Loupe works with **any** OpenAI-API-compatible endpoint, any Anthropic endpoint,
and Gemini. `provider` selects the API **protocol** (not the vendor):

- `openai` — any OpenAI-compatible `/chat/completions` endpoint. Set `base-url`
  (a preset keyword or a full URL) and `model`. Covers OpenAI, OpenRouter,
  DeepSeek, Together, Groq, and local runtimes like Ollama.
- `anthropic` — any Anthropic `/v1/messages` endpoint. `base-url` optional.
- `gemini` — Google AI Studio. `base-url` optional.

`base-url` accepts a preset keyword or a full `http(s)://` URL:

| Protocol | Example provider | `base-url` | `model` | Key source |
|----------|------------------|-----------|---------|------------|
| `openai` | OpenAI | `openai` | `gpt-4o-mini` | OpenAI key |
| `openai` | OpenRouter | `openrouter` | `deepseek/deepseek-chat` | OpenRouter key |
| `openai` | Groq (**free**) | `groq` | `llama-3.3-70b-versatile` | Groq key |
| `openai` | DeepSeek | `deepseek` | `deepseek-chat` | DeepSeek key |
| `openai` | Together | `together` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Together key |
| `openai` | Ollama (local) | `http://localhost:11434/v1` | your local model | any (unused) |
| `anthropic` | Anthropic | *(default)* | `claude-haiku-4-5` | Anthropic key |
| `gemini` | Google AI Studio (**free**) | *(default)* | `gemini-2.5-flash` | Gemini key |

**$0/mo options:** `gemini` (Google AI Studio free tier) and `groq` (free Llama).

### Copy-paste examples

```yaml
# OpenAI — gpt-4o-mini
with:
  llm-api-key: ${{ secrets.LLM_API_KEY }}
  provider: openai
  model: gpt-4o-mini
```

```yaml
# OpenRouter — any model (here DeepSeek)
with:
  llm-api-key: ${{ secrets.LLM_API_KEY }}
  provider: openai
  base-url: openrouter
  model: deepseek/deepseek-chat
```

```yaml
# Groq — free Llama
with:
  llm-api-key: ${{ secrets.LLM_API_KEY }}
  provider: openai
  base-url: groq
  model: llama-3.3-70b-versatile
```

```yaml
# Anthropic Haiku (enables risky-path escalation to claude-sonnet-5 by default)
with:
  llm-api-key: ${{ secrets.LLM_API_KEY }}
  provider: anthropic
  model: claude-haiku-4-5
  # escalation-model: claude-sonnet-5   # override; or set on any provider to enable escalation
```

```yaml
# Gemini — free
with:
  llm-api-key: ${{ secrets.LLM_API_KEY }}
  provider: gemini
  model: gemini-2.5-flash
```

You can also configure everything from **env/secrets** instead of `with:` inputs
— handy for local dev or matrix workflows. The env fallbacks are `PROVIDER`,
`LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY`, and `ESCALATION_MODEL`:

```yaml
- uses: anshace/loupe@v1
  env:
    PROVIDER: openai
    LLM_BASE_URL: openrouter
    LLM_MODEL: deepseek/deepseek-chat
    LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
```

### Escalation

For any provider, set `escalation-model` to route risky diffs
(auth/payment/migration/…) to a stronger model — Loupe rebuilds the **same**
provider/base-url/key with that model. The `anthropic` protocol defaults to
`claude-sonnet-5` when `escalation-model` is unset; other endpoints don't
escalate unless you set it (Loupe can't guess a stronger model for an arbitrary
endpoint).

### Back-compat shortcut

Leaving `provider` empty falls back to the `review-model` shortcut
(`gemini | haiku | groq`), the older single-input form:

```yaml
with:
  llm-api-key: ${{ secrets.LLM_API_KEY }}
  review-model: haiku          # gemini | haiku | groq
```

## Repository layout

| Path | Purpose |
|------|---------|
| `packages/` | Code: `engine` (zero-dep core), `action` (GitHub Action adapter), `worker` (Cloudflare App adapter), `scope-ts` (optional tree-sitter), `rag` (optional retriever) |
| `prompts/` | Versioned reviewer/verifier prompt files (`reviewer-v7.md`, `verifier-v2.md`, …) |
| `documentation/` | **Formal docs** — architecture, ADRs, planning (+ offline HTML renders in `documentation/html/`) |
| `openspec/` | Spec-driven change record — proposal → specs → design → tasks |
| `research/` | Research corpus: competitor landscape, GitHub mechanics, RAG strategies, stack & cost, synthesis + milestones (01–10) |
| `guides/` | How-to guides: how it works, the open-source Action, the future App, running & testing |
| `evals/` | Offline eval harness + seeded cases |
| `docs/` | Personal notes + setup docs (App setup, state, house-rules) |

## Where to start

1. `documentation/README.md` — the documentation index (architecture, ADRs, planning)
2. `documentation/architecture.md` — the full architecture (or `documentation/html/architecture.html` offline)
3. `openspec/changes/build-pr-review-agent/design.md` — the original design decisions
