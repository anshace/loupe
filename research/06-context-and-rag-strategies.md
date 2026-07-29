# Context-Gathering & RAG Strategies for AI Code Review Agents

Research date: 2026-07-29

## 1. The core problem

A raw unified diff tells you *what lines changed* but not *what they mean*. An LLM reviewing a diff in isolation cannot see: the full body of a function that was partially edited, the callers of a modified function, the type/interface a change violates, similar bugs elsewhere in the repo, or the project's own conventions. Every serious code-review agent (CodeRabbit, Qodo/PR-Agent, GitHub Copilot, Claude Code itself) spends the majority of its engineering effort on **context assembly**, not on prompting the model to "find bugs."

The overarching lesson from 2025-2026 industry practice: **more raw context is not better; the right context is better.** CodeRabbit explicitly states "context quality matters more than model quality for AI code review," and notes that a 14B model given a 40-line diff hunk plus a 500-token style guide beats the same model given 2,000 lines of undifferentiated context. Needle-in-a-haystack degradation is real — Qodo's docs describe balancing "sufficient context for accurate analysis, while avoiding information overload that could degrade AI performance."

## 2. Diff parsing and file-level chunking

Base layer, used by essentially every tool:

- Parse the **unified diff** into a list of files → hunks → added/removed/context lines, with old/new line numbers.
- Treat each **hunk** as the atomic unit of review, not the whole file and not the whole PR. This lets you attach a token budget per hunk and parallelize review across hunks/files.
- Filter out noise before it ever reaches the LLM: lockfiles, generated code, vendored/minified files, pure whitespace/rename diffs, binary files. This is free context-budget savings that every production tool does.
- Classify hunks by type (new file, deleted file, rename, pure formatting, logic change) so trivial hunks can be skipped or given a cheap pass while substantive hunks get full context treatment.

## 3. Expanding context around hunks

Raw hunks with 3 lines of git-diff context are usually insufficient. Two escalating techniques:

**a. Line-based padding** — simplest: grab N extra lines above/below each hunk from the file on disk. Qodo/PR-Agent uses an explicitly **asymmetric** strategy: more context lines *before* the change than after, on the reasoning that preceding code (variable declarations, preconditions, opening of a block) is more often needed to understand a change than trailing code. This is dynamically adjusted based on code structure rather than a fixed line count.

**b. Structural/AST-based expansion** — the more robust approach, used by CodeRabbit: parse the file with **Tree-sitter**, find the AST node(s) that fully enclose the changed lines, and expand the selection to the **entire enclosing function or class**, not an arbitrary line count. This guarantees the reviewer always sees a complete, syntactically valid unit of logic (e.g., "method `calculate_total` in class `Cart` changed" rather than "lines 40-52 changed"). CodeRabbit maintains a self-described "1:1 ratio of code-to-context" in its prompts as a budget heuristic once this expansion is done.

Practical takeaway: naive fixed-line padding is a fine v1; AST-based enclosing-scope expansion is the upgrade that meaningfully improves precision and is not that hard to build with tree-sitter (grammars exist for every mainstream language and the queries are declarative).

## 4. Retrieving related files (imports / callers / callees)

Beyond the edited file itself, real review quality comes from cross-file awareness:

- **Import/dependency following**: parse import/require statements in the changed file (or its AST) to pull in the definitions of types/functions actually referenced in the diff.
- **Caller/callee graphs**: CodeRabbit builds ("re-generates on every review to avoid missing new dependencies") a **code dependency graph** from symbol extraction, then queries it for callers and references of any symbol touched by the diff — this is how it catches breaking changes and cross-file regressions that a diff-only view would miss. Vendor marketing claims (treat as directional, not rigorous) suggest full-codebase-aware tools "catch 40-60% more cross-file issues than diff-only tools."
- **Test file discovery**: locate and include the test file(s) covering the changed function/module (by naming convention or by grep for the symbol name) so the model can check whether tests were updated appropriately.
- **History/provenance signals**: recent commits touching the same lines/file, and the linked issue/ticket or PR description, to recover the *intent* behind a change (CodeRabbit's "PR and Issue Indexing" pulls from Jira/Linear/GitHub Issues for this).

## 5. AST-based approaches and symbol indexing (ctags / LSP / SCIP)

Three tiers of "how do I know what a symbol means / where else it's used," roughly increasing in cost and power:

| Tool | What it gives you | Notes |
|---|---|---|
| **ctags / universal-ctags** | Fast, per-repo tag index of symbol definitions (function/class/variable → file:line). No cross-reference or type info. | Cheap, works offline, decades-old, good enough for "jump to definition"-style lookups in a review agent. |
| **LSP (Language Server Protocol)** | Live, language-aware go-to-definition, find-references, hover/type info, per language server (pyright, gopls, rust-analyzer, tsserver…). | Requires running the actual language server; heavier but very precise; incremental as files change. |
| **SCIP / LSIF** | Batch-generated, language-agnostic **index files** capturing definitions, references, hover docs, symbol metadata — designed for storage and cross-repository code navigation (used by Sourcegraph, GitLab Code Intelligence). SCIP (Protobuf-based, human-readable symbol IDs) superseded LSIF because LSIF's opaque global IDs made incremental updates impractical. | Best for large/monorepo or cross-repo navigation where you want a persisted, queryable index rather than a live language server per request. |

For a code-review agent, LSP-style "find references / go to definition" is the most directly useful primitive — it's effectively how CodeRabbit's symbol-extractor + dependency graph behaves, just custom-built rather than using off-the-shelf LSP. For a solo project, plain ctags or even AST-grep queries are a much lower-effort way to get 80% of the value.

## 6. Embedding-based RAG over the codebase

Standard code-RAG pipeline: chunk → embed → store in a vector DB → retrieve top-k by similarity at query time.

- **Chunking strategies**: fixed-length/token-window chunking (simple, splits mid-function, cheapest) vs. **AST-aware chunking** (chunk boundaries aligned to function/class boundaries, preserving semantic units — described in multiple 2025-2026 write-ups, e.g. Supermemory's "code-chunk" and various AST-RAG posts). A widely cited Feb-2026 benchmark (surveyed across ~50 papers) found plain **recursive 512-token splitting outperformed semantic/AST chunking on retrieval accuracy in aggregate (69% vs 54% for "semantic chunking")** — a reminder that fancier chunking doesn't automatically win; it depends heavily on the retrieval task and reranking step.
- **Vector DBs**: for a codebase-scale corpus, lightweight local options (hnswlib, FAISS, sqlite-vec, LanceDB, Chroma) are typically sufficient; hosted vector DBs (Pinecone, Weaviate, Qdrant) matter mainly at large multi-repo/enterprise scale.
- **When RAG is overkill**: for a single small-to-medium repo that the agent can already `grep`/`read` cheaply and that fits comfortably in an agentic exploration budget, embedding RAG adds an indexing pipeline (staleness risk, infra to run/host, security surface for proprietary code) for marginal benefit. RAG earns its keep at scale: very large monorepos, multi-repo/cross-service context, or when you need semantic ("find code that does something *like* this") rather than exact-symbol retrieval.

## 7. Agentic retrieval vs. embeddings — the current consensus, with evidence

This is the most important trend for a 2026-era design: **modern coding agents have largely moved away from embeddings-RAG toward "agentic search"** — letting the LLM itself drive `glob`/`grep`/`read` (and language-server-style tools) iteratively, rather than pre-computing a vector index.

- **Claude Code**: Anthropic's own team (per Boris Cherny, Claude Code's creator) tried RAG with a vector DB early on and found "agentic search generally works better," removing the embedding pipeline/vector DB/chunking heuristics (~May 2025) in favor of a tool hierarchy: **Glob** (near-zero cost path matching) → **Grep** (cheap content search) → **Read** (expensive, full file, 500-1500 tokens). For deep exploration it spawns an isolated **Explore sub-agent** (on a cheaper model) whose noisy search trajectory is discarded while only its distilled findings return to the main context — this keeps the main context window clean. Reasons cited: freshness (no index-lag on a live filesystem), security/privacy (no code index that has to be stored/shipped, relevant for enterprise customers who don't want proprietary code embedded on external infra), precision (grep is exact and predictable; embeddings are "still too fuzzy to trust" for code), and fewer moving systems to fail.
- **Evidence**: an Amazon Science paper (Feb 2026, arXiv 2602.23368) found keyword-based agentic search achieves **"over 90% of RAG-level performance without a vector database."** Claude Code's economics depend heavily on prompt caching (~92% prefix reuse cited, cache reads priced far below fresh input) which makes repeated agentic exploration cheap in practice.
- **Industry follow-through**: Cursor, Windsurf, Cline, Devin, and Sourcegraph Amp are all reported to have dropped or de-emphasized vector-embedding retrieval in favor of tool-driven/agentic search for code.
- **Trade-offs of agentic/grep-based search** (worth stating honestly): it struggles on very large monorepos with inconsistent naming, can't find renamed/refactored symbols by "meaning," and generic identifiers (e.g., `useState`) trigger noisy, expensive refinement loops. Vector search still has a niche for cross-repo semantic ("find something like this") queries at large scale.
- **CodeRabbit / Qodo**, by contrast, are B2B SaaS products reviewing PRs across *many customers' repos server-side* — for them, pre-built symbol/dependency graphs and (for CodeRabbit) some RAG-flavored retrieval make sense because they run centrally and repeatedly, amortizing index-build cost, and because they need consistent latency/cost per review rather than open-ended agentic exploration.

**Bottom line for solo/small-scale tools**: agentic search (grep/glob/read, optionally scoped with an AST-aware "find enclosing function" step) is now the better default for a single developer's repo — you get near-RAG-quality retrieval with zero indexing infrastructure, no staleness, and much lower engineering cost.

## 8. Handling large diffs

- **Split per file, then per hunk** — never send an entire multi-thousand-line diff in one shot. Review file-by-file (or hunk-by-hunk) with the model, then have a final pass synthesize/deduplicate cross-file findings.
- **Prioritize**: run cheap heuristics first to rank files/hunks by risk (e.g., touches auth/payment/security-sensitive paths, high cyclomatic complexity, large blast radius/many callers, historically bug-prone files) and spend the deepest context budget on the top-ranked hunks; skim or skip generated/vendor/config-only changes.
- **Compression strategies**: Qodo/PR-Agent's "PR compression" reduces a large diff to a token-budget-fitting representation (e.g., collapsing unchanged/low-signal hunks, summarizing far-context) so even large PRs get a single coherent pass; it aims for fast (~30s), affordable single-LLM-call reviews per tool invocation.
- **Parallelize**: independent file/hunk reviews are embarrassingly parallel — fan out to sub-agents or separate calls, then merge/de-duplicate findings in a synthesis step (this also naturally bounds each individual context window).

## 9. Incremental review state (avoiding re-reviewing everything on every push)

- Maintain a **baseline pointer** — the last commit SHA (or diff) that was actually reviewed. On a new push, diff against that baseline rather than against the PR's base branch, so only *newly introduced* changes are re-analyzed.
- **Known failure mode** (observed with GitHub Copilot's PR reviewer): naive implementations re-scan the *entire* current diff on every push rather than diffing incrementally, which regenerates comments on code that was already reviewed and not flagged — producing a noisy "endless fix-push-review loop." Community reports also note there is no reliable API to force a fresh incremental re-review; Copilot deduplicates comments against its last-reviewed baseline but this isn't always solid.
- Practical design for a solo tool: persist `{file, last_reviewed_sha_or_hash_of_hunk}` per file/hunk (a simple local SQLite/JSON store is enough) and only re-send hunks whose content-hash changed since the last run; carry forward previously-raised-but-unresolved findings so they aren't silently dropped, but don't re-emit them as new comments.

## 10. Recommended pragmatic approach for a solo-dev learning project

Given the goal is learning + a working tool, not a multi-tenant SaaS, favor **agentic exploration over building a RAG pipeline**:

1. **Diff parsing**: use `git diff --unified=3` (or a diff-parsing library) to get files/hunks with line numbers; drop lockfiles/generated/vendored files immediately.
2. **Context expansion, cheaply first**: for each hunk, grab the full enclosing function/class. Start with a naive heuristic (nearest `def`/`function`/`class`/`{` boundary via regex or a lightweight parser); upgrade to **tree-sitter** once the naive version feels limiting — tree-sitter has mature, pip/npm-installable grammars and is a genuinely good learning target (AST queries, not just parsing).
3. **Related-file retrieval via agentic search, not embeddings**: give the reviewing LLM `grep`/`glob`/`read`-style tools and let it look up a symbol's definition/other usages/tests on demand, the same way Claude Code does. This avoids building and maintaining a vector index, embedding pipeline, or vector DB — for a single repo of realistic solo-project size, this is strictly less infrastructure for comparable or better precision, per the Amazon Science finding (~90% of RAG-level performance from keyword/agentic search alone).
4. **Skip embeddings-RAG entirely for v1.** Only reach for it if the project grows into a large multi-repo/cross-service context where semantic ("find something like this elsewhere") queries matter more than exact symbol lookups — and even then, start with ctags or a simple `tree-sitter`+SQLite symbol table before standing up a vector DB.
5. **Large-diff handling**: cap review to one file/hunk per LLM call; rank hunks with a cheap heuristic (path sensitivity, diff size, "logic change" vs. "formatting-only") before spending deep context on them; merge findings in a final synthesis pass.
6. **Incremental state**: store a small local JSON/SQLite file mapping `{pr_or_branch: {file: last_reviewed_content_hash}}` so re-runs only re-review changed hunks, and carry forward unresolved prior findings instead of re-flagging them.

This mirrors what Claude Code itself does (agentic grep/read over indexing) and what the current evidence favors for single/small-repo use — it is also considerably less code to build and maintain than a RAG pipeline, which matters for a learning project meant to actually ship.

---

## Sources

- [The Local Code Review Agent: Git Diffs, Style Guides, and Inline Comments — Medium](https://medium.com/@paulhoke/the-local-code-review-agent-git-diffs-style-guides-and-inline-comments-no-cloud-required-149200b2995d)
- [AI Code Review in 2026: How It Works and How to Adopt It — Sourcegraph](https://sourcegraph.com/blog/ai-code-review)
- [The State of AI Code Review in 2026 — DEV Community](https://dev.to/rahulxsingh/the-state-of-ai-code-review-in-2026-trends-tools-and-whats-next-2gfh)
- [AI Code Review in 2026 — The Definitive Guide — Critique](https://www.critique.sh/ai-code-review-guide)
- [Context Engineering: 9 Fixes for AI Coding Agents (2026) — Fundesk](https://www.fundesk.io/context-engineering-techniques-ai-coding-agents-2026)
- [Why Claude Code is special for not doing RAG/Vector Search — Medium (Aram)](https://zerofilter.medium.com/why-claude-code-is-special-for-not-doing-rag-vector-search-agent-search-tool-calling-versus-41b9a6c0f4d9)
- [Why I'm Against Claude Code's Grep-Only Retrieval — Milvus Blog](https://milvus.io/blog/why-im-against-claude-codes-grep-only-retrieval-it-just-burns-too-many-tokens.md)
- [Why Did Claude Code Abandon RAG for Agentic Search? — Zenn](https://zenn.dev/karamage/articles/2514cf04e0d1ac?locale=en)
- [AI Agents Don't Need Vector Search Anymore — Medium (Abdullah Grewal)](https://buzzgrewal.medium.com/ai-agents-dont-need-vector-search-anymore-inside-the-agentic-search-stack-replacing-rag-in-2026-58efcabe4f6f)
- [Anthropic Replaced Their RAG Pipeline with Agentic Search — Robert Heubanks Substack](https://robertheubanks.substack.com/p/anthropic-replaced-their-rag-pipeline)
- [Settling the RAG Debate — SmartScope](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/)
- [Claude Code Doesn't Index Your Codebase. Here's What It Does Instead. — Vadim's blog](https://vadim.blog/claude-code-no-indexing/)
- [Agentic Search Over Vector Embeddings — Pattern](https://www.agentic-patterns.com/patterns/agentic-search-over-vector-embeddings/)
- [CodeRabbit Documentation — ast-grep instructions](https://docs.coderabbit.ai/configuration/ast-grep-instructions)
- [Architecting CodeRabbit like code-review AI agent at scale — learnwithparam](https://learnwithparam.com/blog/architecting-coderabbit-ai-agent-at-scale)
- [Context Engineering: Level up your AI Code Reviews — CodeRabbit blog](https://www.coderabbit.ai/blog/context-engineering-ai-code-reviews)
- [Code context: The evidence behind trustworthy AI code review — CodeRabbit](https://www.coderabbit.ai/guides/code-context)
- [How I Built CodeRAG with Dependency Graph Using Tree-Sitter — Medium](https://medium.com/@shsax/how-i-built-coderag-with-dependency-graph-using-tree-sitter-0a71867059ae)
- [How ast-grep Works: A bird's-eye view](http://astgrep.com/advanced/how-ast-grep-works.html)
- [Dynamic context — Qodo Merge (PR-Agent) docs](https://qodo-merge-docs.qodo.ai/core-abilities/dynamic_context/) (redirects to https://docs.qodo.ai/code-review)
- [How Qodo PR-Agent Smartly Compresses and Reviews Large Code Changes — Medium](https://thamizhelango.medium.com/how-qodo-pr-agent-smartly-compresses-and-reviews-large-code-changes-72db8898f622)
- [Best Chunking Strategies for RAG (and LLMs) in 2026 — Firecrawl](https://www.firecrawl.dev/blog/best-chunking-strategies-rag)
- [RAG for LLM Code Generation using AST-Based chunking — Medium (Vishnudhat Natarajan)](https://medium.com/@vishnudhat/rag-for-llm-code-generation-using-ast-based-chunking-for-codebase-c55bbd60836e)
- [code-chunk: AST-Aware Code Chunking, Explained — Supermemory](https://supermemory.ai/blog/building-code-chunk-ast-aware-code-chunking)
- [How to Build Custom Code RAG — Continue Docs](https://docs.continue.dev/guides/custom-code-rag)
- [Cross-repository code navigation — Sourcegraph](https://sourcegraph.com/blog/cross-repository-code-navigation)
- [SCIP - a better code indexing format than LSIF — Sourcegraph](https://sourcegraph.com/blog/announcing-scip)
- [SCIP and LSIF Indexing — rust-analyzer DeepWiki](https://deepwiki.com/rust-lang/rust-analyzer/9.2-scip-and-lsif-indexing)
- [Code intelligence — GitLab Docs](https://docs.gitlab.com/user/project/code_intelligence/)
- [GitHub Copilot Code Review: Complete Guide (2026) — DEV Community](https://dev.to/rahulxsingh/github-copilot-code-review-complete-guide-2026-255h)
- [Title: Copilot Code Review generates new comments on every push — GitHub community discussion](https://github.com/orgs/community/discussions/189767)
- [Feature Request: API/CLI support for re-requesting PR reviews — GitHub community discussion](https://github.com/orgs/community/discussions/186152)
- [Navigating Incremental AI Reviews with GitHub Copilot — DEV Community](https://dev.to/devactivity/navigating-incremental-ai-reviews-optimizing-your-software-engineering-kpis-with-github-copilot-3hd9)
