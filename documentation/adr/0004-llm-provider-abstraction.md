# 0004. Unified LLM provider abstraction behind one interface

## Status

Accepted. (Superseded the original fixed 3-provider design — see below — while
keeping the same interface.)

## Context

Loupe calls an LLM to review diffs. During prompt iteration it must be free
(hundreds of test reviews burn real money on paid models); for real reviews it
wants a cheap-but-good default and a stronger model on risky diffs; and, as an
open-source Action where users bring their own key (ADR 0010), it cannot assume
any single vendor. Cost must never run away on a shared, free-tier-first project.

The original design (decision 4) named three concrete rungs: Gemini 2.5 Flash
free tier for dev, Claude Haiku 4.5 as the M2+ quality default (with prompt
caching), and Claude Sonnet 5 escalation on sensitive paths. In building the
Action for public use, this evolved: pinning three vendors is too rigid when
every user brings a different key, so the abstraction was generalized to **any**
endpoint while preserving those defaults.

## Decision

Put every model behind one interface — `ReviewModel { complete(req) }` — and
select a provider by **wire protocol, not vendor** (`model.ts`):

- `openai` — any OpenAI-compatible `/chat/completions` endpoint (OpenAI,
  OpenRouter, DeepSeek, Together, Groq, local Ollama, …), configured with a
  `base-url` (preset keyword or full URL) + explicit `model`.
- `anthropic` — any Anthropic `/v1/messages` endpoint; stable system prompt sent
  with `cache_control: ephemeral` so repeat reviews hit the prompt cache.
- `gemini` — Google AI Studio.

Providers use plain `fetch` (no SDKs — ADR 0003) and report **real token counts**
from the response, never char estimates. **Risk-based escalation**: an
`escalation-model` reroutes risky diffs (auth/payment/migration paths) to a
stronger model — defaulting to `claude-sonnet-5` on the `anthropic` protocol.
**Cost guards**: a per-run token cap and a monthly budget that degrades the bot
to the free-tier model when exceeded.

## Consequences

**Positive**

- Provider swaps are configuration, not code; users bring any key (enables the
  open-source Action, ADR 0010) and `$0/mo` stays reachable via Gemini/Groq free
  tiers.
- One interface keeps the engine testable (`MockProvider`) and keeps every
  vendor-specific quirk (auth header, caching, usage-field names) at the edge.
- Real token counts make the cost caps and budget-degrade honest.

**Negative / trade-offs**

- The generic `openai` protocol cannot guess a sensible default model or a
  stronger escalation model for an arbitrary endpoint, so both must be set
  explicitly (the code throws a clear error rather than guessing).
- Supporting arbitrary endpoints means tolerating differences (e.g. some servers
  reject `response_format`), handled with per-option flags.

## Alternatives considered

- **Single fixed model.** Simplest, but no free dev tier + no risk escalation,
  and it would force one vendor on every user of the open-source Action.
- **Hardcoded per-vendor providers (the original 3-rung design).** Cleaner code,
  but too rigid once users bring their own keys; superseded by the protocol-based
  abstraction, which keeps the same defaults as presets.
- **OpenRouter `:free` as a dependency.** Rejected — the free roster is volatile
  (models delisted/relisted constantly), unsafe to depend on (research 07 §4).

See also: `design.md` decision 4; `research/07-stack-and-cost-analysis.md` §4;
`README.md` (Model providers); `packages/engine/src/model.ts`.
