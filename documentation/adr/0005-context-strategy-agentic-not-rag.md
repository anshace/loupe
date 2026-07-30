# 0005. Context strategy: agentic search, not embeddings-RAG

## Status

Accepted. (Embeddings-RAG kept as an M5 experiment only, not core — see ADR
0006.)

## Context

A raw unified diff says *what* changed, not *what it means*: the reviewer cannot
see the full enclosing function, the callers of a changed signature, or the
project's conventions. Context assembly — not prompting — is where review quality
is won. The classic answer is embeddings-RAG (chunk → embed → vector DB →
retrieve), which brings an indexing pipeline, staleness, embedding infra, and a
security surface (proprietary code embedded on external infra). For a single
solo-scale repo, that is a lot of machinery.

## Decision

Assemble context with **deterministic + agentic** steps, no embeddings index:

1. **Parse the unified diff** into files → hunks with valid right-side line
   numbers.
2. **Noise filter** — drop lockfiles, generated, vendored, minified, and binary
   files before anything reaches the model (`noise.ts`).
3. **Enclosing-scope expansion** — expand each hunk to its enclosing
   function/class (regex heuristic, then tree-sitter via `scope-ts`).
4. **Capped agentic search** (M4) — give the reviewer bounded grep/read tools for
   cross-file symbol lookups (`agentic.ts`), with hard loop caps.
5. **Reverse-import injection** — when a diff changes an exported signature,
   *force-inject* its call sites as context rather than hoping the model greps for
   them (`importgraph.ts`).

Embeddings-RAG is **not** part of the core architecture — only an optional M5
experiment (`packages/rag`), off by default.

## Consequences

**Positive**

- ~90% of RAG-level retrieval quality with zero index infra, no staleness, and no
  embedding pipeline — the 2026 consensus (Claude Code, Cursor, Amp all dropped
  vector indexes; Amazon Science Feb-2026 measured keyword-agentic search at "over
  90% of RAG-level performance without a vector database"; research 06 §7).
- Right context beats more context: the noise filter + enclosing-scope expansion
  spend the token budget on the parts of the diff that carry meaning.
- Nothing proprietary is embedded or shipped to external infra; grep/read are
  exact and predictable, not fuzzy.
- Forced caller injection catches cross-file breakage a diff-only view misses,
  deterministically — not left to the model's initiative.

**Negative / trade-offs**

- Agentic search struggles on very large monorepos with inconsistent naming and
  cannot find renamed/refactored symbols "by meaning"; generic identifiers can
  trigger noisy refinement loops (bounded by loop caps).
- Semantic "find code like this" cross-repo queries remain a genuine RAG niche —
  hence the M5 experiment rather than a flat "never".

## Alternatives considered

- **Embeddings-RAG as the foundation.** Rejected as core: index/staleness/infra
  cost for marginal benefit at solo-repo scale; kept only as a measured M5
  experiment (sqlite-vec first) to confirm — or refute — its value on Loupe's own
  repos.

See also: `design.md` decision 5; `research/06-context-and-rag-strategies.md`
§7, §10.
