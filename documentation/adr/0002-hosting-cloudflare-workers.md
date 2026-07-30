# 0002. Hosting the App phase on Cloudflare Workers

## Status

Deferred (chosen for the App phase, M3+; not built during M0–M2, which run as a
GitHub Action with no hosting at all — see ADR 0001).

## Context

When Loupe grows a GitHub App (ADR 0001), its webhook receiver needs somewhere to
run. The workload is a request/response webhook handler that is almost entirely
**I/O-bound**: verify a signature, call the GitHub API, call an LLM, post a
review. It runs at hobby volume (tens to low hundreds of PRs/month). The
free-tier-first constraint means $0/mo must remain achievable, and the shared
machine / everything-local rule rules out anything that leaks work off-box until
we deliberately deploy.

## Decision

Host the App-phase webhook receiver on **Cloudflare Workers** (`packages/worker`,
Hono + Octokit). Use **Cloudflare KV** for the M5 incremental-review state on the
same platform (see ADR 0006).

## Consequences

**Positive**

- The only host among those surveyed with a durable, no-credit-card,
  genuinely-free-forever tier: 100K requests/day — orders of magnitude above
  hobby PR volume (research 07 §2).
- The 10ms CPU limit measures compute, not wall-clock time spent waiting on
  network I/O — so for this I/O-bound handler it is effectively a non-constraint.
- KV's free tier covers M5 state without adding a second vendor.

**Negative / trade-offs**

- The Workers edge runtime is not a long-lived Node process, which constrains
  framework choice (drives the Hono-not-Probot decision — ADR 0003) and rules out
  Python (ADR 0003).
- The 10ms CPU budget would bite if any heavy synchronous compute were ever added
  to the hot path; such work must stay off the webhook thread.

## Alternatives considered

- **Render.** Real permanent free tier, but free web services cold-start 30s+
  after idle — hostile to GitHub's webhook delivery/retry windows.
- **Railway / Fly.io.** No real free tier anymore (Railway went metered
  post-paid; Fly is trial-only for new accounts) — both fail the $0/mo bar.
- **Home server + tunnel (Cloudflare Tunnel / ngrok).** $0 infra, but adds "my
  home PC/ISP must always be up" as a reliability dependency; fine for local
  webhook dev, worse than Workers for something meant to be reliable.

See also: `design.md` decision 2; `research/07-stack-and-cost-analysis.md` §2.
