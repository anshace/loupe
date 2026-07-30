# 0001. Trigger model: GitHub Action first, GitHub App later, engine trigger-agnostic

## Status

Accepted. (App phase is deferred to milestone M3+; the Action phase ships M0–M2.)

## Context

Loupe needs to run when a pull request is opened or updated. There are two
mainstream ways to be notified by GitHub, and they carry very different setup,
security, and distribution costs:

- A **GitHub Action** — a workflow YAML in the target repo, triggered on
  `pull_request`, running on GitHub-hosted runners with the built-in
  `GITHUB_TOKEN`. Zero infrastructure, zero webhook endpoint to secure, free and
  unlimited on public repos.
- A **GitHub App** — a hosted webhook receiver that GitHub calls on every event,
  authenticating with installation tokens. This is the only path to Check Runs,
  fine-grained permissions, slash commands on any repo, and multi-repo installs
  without a per-repo workflow file — but it needs a server, HMAC verification,
  and token minting.

As a solo, learning-first project that must ship something working on day one
with no infra, but also wants to learn the App/webhook stack, we do not want to
pick one and rewrite for the other later.

## Decision

Ship as a **GitHub Action first (M0–M2)** and add a **GitHub App webhook path
later (M3+)**. Crucially, the review **engine is a pure, trigger-agnostic
TypeScript library** (`packages/engine`) that takes `(PR identity, auth token,
config)` and knows nothing about how it was invoked. The Action wrapper
(`packages/action`) and the App/Worker wrapper (`packages/worker`) are thin
adapters around the same core. Both keep working after M3 — the Action path
stays green in CI.

## Consequences

**Positive**

- A working reviewer ships on day one with zero infrastructure and no webhook
  security surface (only `GITHUB_TOKEN`).
- The Action→App transition is additive, not a rewrite: the engine is untouched;
  only a new adapter is added.
- Both trigger paths coexist permanently — users can install via a workflow file
  (Action) or as an App, whichever they prefer.

**Negative / trade-offs**

- Maintaining two adapters is more surface than one (accepted; mitigated by the
  engine being pure so the adapters stay thin).
- The Action path incurs a per-run cold start (runner spin-up + checkout) and
  cannot offer Check Runs or slash commands on arbitrary repos — those wait for
  the App.

## Alternatives considered

- **App-first.** Rejected for a solo v1: requires standing up and securing a
  hosted webhook endpoint before any value is delivered, front-loading the
  hardest infra before the review logic exists.
- **PAT + webhook.** Rejected: a long-lived, coarse-grained personal token,
  per-repo wiring, and no access to Check Runs (research 05 §1).

See also: `openspec/changes/build-pr-review-agent/design.md` decision 1;
`research/08-synthesis-architecture-and-milestones.md` §1–2.
