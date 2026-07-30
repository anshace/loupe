# 0003. TypeScript everywhere in a zero-runtime-dep monorepo

## Status

Accepted.

## Context

Loupe spans a GitHub Action script, a (later) Cloudflare Worker, and a shared
review engine (ADR 0001). A solo dev does not want to context-switch languages
across those surfaces. The engine must run unchanged in a GitHub Action (Node)
and on the Workers edge runtime (ADR 0002), and it processes untrusted PR content
— so its dependency footprint is also a supply-chain surface worth minimizing.

## Decision

Use **TypeScript everywhere**, organized as an **npm-workspaces monorepo**:

- `packages/engine` — the trigger-agnostic review library, with **zero runtime
  dependencies**. It talks to GitHub and LLM providers over plain `fetch`
  (injectable for tests) — no vendor SDKs (`model.ts`).
- `packages/action` — the Action adapter (`@actions/*`), bundled with `ncc`.
- `packages/worker` — the App adapter (Hono + Octokit) for the Workers runtime.
- Supporting packages: `scope-ts`, `rag` (the optional experiment, ADR 0006).

The root `package.json` declares `workspaces: ["packages/*"]`; TypeScript
project references (`tsc -b`) build the graph; Vitest runs the tests.

## Consequences

**Positive**

- One language across the Action script, the Worker, and the engine — no
  context-switching, and the engine is shared verbatim by both adapters.
- The zero-runtime-dep engine has a minimal supply-chain surface, installs
  instantly, and runs identically on Node and the Workers edge runtime (plain
  `fetch`, no SDK that assumes a Node process).
- Octokit (in the Worker) gives typed GitHub API access and webhook signature
  verification for free; Hono runs natively on Workers.

**Negative / trade-offs**

- Zero runtime deps means hand-rolling things an SDK would provide (provider HTTP
  clients, diff parsing, and even the deterministic security passes — ADR 0011);
  more code to own, in exchange for portability and a small attack surface.
- A monorepo with project references adds build-graph and tooling complexity over
  a single flat package.

## Alternatives considered

- **Probot.** The batteries-included GitHub App framework, but it wants a
  long-lived Node process and does not target the Workers edge runtime (research
  07 §3) — a poor fit for ADR 0002.
- **Python + FastAPI.** Does not run properly on Workers, which would force
  Render and its cold starts (ADR 0002). Tree-sitter and diff handling have
  perfectly good npm bindings anyway, so Python buys nothing here.

See also: `design.md` decision 3; `research/07-stack-and-cost-analysis.md` §3.
