# Architecture Decision Records — Loupe

An **Architecture Decision Record (ADR)** captures a single significant
architectural or design decision: the context that forced a choice, the decision
itself, the consequences (good and bad) that follow, and the alternatives that
were weighed and rejected. Each ADR is a small, dated, immutable record — when a
decision changes, a new ADR supersedes the old one rather than editing history.
Together they explain not just *what* Loupe is, but *why* it is shaped the way it
is.

These ADRs distill decisions that were made across the project's design and
research work. The **authoritative decision context also lives in
[`../../openspec/changes/build-pr-review-agent/design.md`](../../openspec/changes/build-pr-review-agent/design.md)**
(the numbered Decisions table and rationale paragraphs), with supporting analysis
in [`../../research/`](../../research/) — these ADRs summarize and cross-reference
that source of truth; where an ADR and the OpenSpec design ever diverge, the
OpenSpec change is authoritative.

## Index

| # | Title | Status | One-line |
|---|-------|--------|----------|
| [0001](0001-trigger-model-action-first-app-later.md) | Trigger model: Action first, App later, engine agnostic | Accepted | Ship as a GitHub Action (M0–M2), add a GitHub App (M3+); the engine is a trigger-agnostic library both wrap. |
| [0002](0002-hosting-cloudflare-workers.md) | Hosting the App phase on Cloudflare Workers | Deferred | Host the App-phase webhook on Workers — the only durable no-card free tier; I/O-bound so the CPU cap doesn't bite. |
| [0003](0003-language-and-monorepo-typescript.md) | TypeScript everywhere in a zero-runtime-dep monorepo | Accepted | One language across Action, Worker, and a zero-runtime-dependency engine, in an npm-workspaces monorepo. |
| [0004](0004-llm-provider-abstraction.md) | Unified LLM provider abstraction behind one interface | Accepted | Any endpoint (openai/anthropic/gemini protocol) behind one interface; risk escalation + cost caps. Evolved from a fixed 3-provider setup. |
| [0005](0005-context-strategy-agentic-not-rag.md) | Context strategy: agentic search, not embeddings-RAG | Accepted | Diff + noise filter + enclosing scope + capped agentic search + reverse-import injection; RAG is an M5 experiment only. |
| [0006](0006-storage-none-until-needed.md) | No storage until it is actually needed | Accepted | Stateless by default; summary-marker dedupe; KV/flat-file store only at M5 for incremental re-review. |
| [0007](0007-prompts-as-versioned-files.md) | Prompts as versioned files, never edited in place | Accepted | Prompts are versioned markdown files; a change to a shipped prompt means a new version, never an in-place edit. |
| [0008](0008-llm-proposes-code-disposes.md) | LLM proposes, deterministic code disposes | Accepted | The model emits structured JSON only; deterministic code does all scoring/anchoring/mutations and holds the write credential. |
| [0009](0009-reviewer-verifier-two-role-with-grounding.md) | Two-role reviewer + verifier with mandatory grounding | Accepted | Reviewer finds, verifier keeps/rewrites/drops with cited evidence + mechanical quote-check; insufficient-context abstention. |
| [0010](0010-distribution-open-source-action-first.md) | Distribution: open-source Action first, hosted App later | Accepted | Ship the OSS Action (users bring their own key — zero cost to the author); hosted multi-tenant App deferred. |
| [0011](0011-deterministic-security-prepasses.md) | Deterministic security pre-passes, not LLM-driven | Accepted | Secret scanning and GitHub Actions supply-chain checks run as deterministic code — ~100% precision, no SAST binary, zero-dep. |
