# 0010. Distribution: open-source GitHub Action first, hosted App later

## Status

Accepted. (Hosted multi-tenant App deferred; the packaged Action is the first
distributable — "Plan B" in the repo history.)

## Context

Loupe could be distributed two ways: as a **hosted GitHub App** that users
install (the author runs the servers and, critically, pays the LLM bill for every
install), or as an **open-source GitHub Action** that users add to their own
workflow with **their own LLM key**. The economic reality is decisive for a solo
dev: a hosted multi-tenant bot means **one person's key (and wallet) funds every
install** — LLM spend that scales with other people's PRs, plus hosting and the
operational burden of multi-tenant isolation, secret rotation, and uptime. That
is a business, not a learning project.

## Decision

Ship the **open-source GitHub Action first** (`uses: anshace/loupe@v1`), where
each user brings their own LLM key (`llm-api-key` secret) and any provider (ADR
0004). This is enabled directly by the trigger-agnostic engine (ADR 0001) and the
provider abstraction (ADR 0004). The **hosted multi-tenant App is deferred** — it
remains an available install path built on the same engine (ADR 0001), but is not
the primary distribution.

## Consequences

**Positive**

- **Zero hosting and zero LLM cost for the author** — each user runs it on their
  own GitHub Actions minutes with their own key, so cost scales with the user who
  incurs it, not with the maintainer.
- Aligns perfectly with the free-tier-first, local-first, shared-machine
  constraints: nothing centralized to run or pay for.
- Users keep full control of their key, provider, and data (the Action runs in
  their own CI); no proprietary code flows through the author's infra.

**Negative / trade-offs**

- Distribution requires a per-repo workflow file (or a reusable workflow) rather
  than a one-click org-wide install — higher setup friction than a hosted App.
- No centralized Check Runs, cross-repo analytics, or slash-commands-on-any-repo
  until the App path is built (ADR 0001) — these are the App's reason to exist
  later.
- Each user must obtain and manage their own LLM key.

## Alternatives considered

- **Hosted multi-tenant App first.** Rejected for v1: one key funds all installs,
  plus multi-tenant hosting/isolation/billing burden — economically and
  operationally wrong for a solo learning project. Deferred, not abandoned; the
  engine is ready for it (ADR 0001).

See also: `design.md` decision 1; `README.md` (Usage);
`research/07-stack-and-cost-analysis.md` §1; `action.yml`.
