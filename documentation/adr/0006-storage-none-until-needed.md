# 0006. No storage until it is actually needed

## Status

Accepted. (State introduced at M5 only.)

## Context

Many PR-review bots reach for a database or queue on day one. But the core review
loop is a **stateless transform**: event → diff → LLM → comment. The one place
state seems needed early — not re-posting duplicate comments on repeated
pushes — can be handled without a store by reading the bot's own existing PR
comments over the API. Every reference project that added a DB early regretted
the ops surface. The free-tier-first, local-first constraints also penalize
standing up a database before there is a proven need.

## Decision

Be **stateless by default (M0–M4)**. Deduplicate against existing PR comments via
the API, and identify the single summary comment with a hidden HTML **marker** so
it is edited in place, never re-posted (`dedupe.ts`, `summary.ts`). Add a real
store **only at M5**, for incremental re-review — persisting
`{pr → last-reviewed SHA, hunk content-hashes}` — in **Cloudflare KV** on the App
path or a **flat JSON file** (via `actions/cache`) on the Action path
(`state.ts`, `incremental.ts`).

## Consequences

**Positive**

- Zero database and zero queue for the first four milestones: nothing to
  provision, secure, back up, or pay for; the loop stays a pure function.
- Dedupe and summary-upsert are achieved with the data GitHub already holds (the
  PR's own comments), so idempotency needs no external state.
- When state finally arrives at M5, it is the minimum shape that unlocks
  incremental re-review, on the same platform already chosen (KV on Workers, ADR
  0002) or a committed file — no new vendor.

**Negative / trade-offs**

- Stateless dedupe costs an API read per run to inspect existing comments
  (cheap, well within limits).
- Without stored state before M5, the bot cannot do true incremental re-review —
  it reasons from the current PR each run; this is an accepted limitation until
  the milestone that needs it.

## Alternatives considered

- **Postgres / a queue from day one.** Rejected: ops surface and cost with no
  concrete need at solo scale; the stateless transform plus API-based dedupe
  covers every M0–M4 requirement. A free hosted Postgres (Neon/Supabase) remains
  available if a genuine relational need ever appears — it has not for v1.

See also: `design.md` decision 6; `research/07-stack-and-cost-analysis.md` §5;
`research/06-context-and-rag-strategies.md` §9.
