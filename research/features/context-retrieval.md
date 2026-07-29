# Research: Better Code-Context Gathering for Loupe (2026-07-30)

Scope: methods Loupe does **not** yet have for gathering code context, evaluated
against the project's actual constraints — zero-runtime-dep engine, free-tier /
local-first, GitHub Action (shipping) + Cloudflare Worker (deferred) delivery,
no clone-and-execute of untrusted PR code. Quality priority order: precision >
recall > actionability > trust/UX.

I re-read `research/06-context-and-rag-strategies.md` first so this file adds
new ground rather than repeating it. File 06 already covers: diff/hunk
chunking, line-padding vs AST-based enclosing-scope expansion, the
agentic-search-over-RAG consensus, large-diff handling, and incremental review
state. Loupe has since **built** enclosing-scope expansion (`scope.ts`,
regex + optional tree-sitter), capped agentic grep/read (`agentic.ts`), and an
optional `Retriever` seam (`retrieve.ts`) for the M5 RAG experiment. File 06
also *names* caller/callee graphs, symbol indexing tiers (ctags/LSP/SCIP),
test-file discovery, and history/PR-intent signals as concepts worth having —
but **none of them are implemented**. That gap is the subject of this file.

I also read the current engine source (`run.ts`, `agentic.ts`, `scope.ts`,
`prompt.ts`, `types.ts`) to ground every recommendation in the actual
extension points: the `RunDeps` injection pattern (how `scope-ts` and the RAG
package are wired in without touching the zero-dep engine core), the
`RepoReader` interface (`listTree`/`readFile`, currently backing `grep` and
`read_file` tool calls), and the prompt placeholder set
(`DIFF`, `COMMENTABLE_LINES`, `HOUSE_RULES`, `CUSTOM_RULES`, `CONTEXT`,
`RETRIEVED_CONTEXT`, `TOOLS`). Every candidate below names its concrete
integration point in these terms.

Confirmed gaps in the current code: `PrIdentity` carries only
`{owner, repo, prNumber}` — no title/body/labels anywhere; `RunEvent` carries
`isDraft/actor/headSha/onDemand/before` — no linked-issue data; nothing reads
git blame/history; nothing distinguishes tests from source files; the only
"symbol lookup" is regex `grep` over raw text (no real definition/reference
resolution); nothing computes an import/dependency graph in either direction.

---

## 1. PR title/description + linked-issue intent context

**What's missing:** the reviewer never sees *why* the diff exists. It judges
code shape but not whether the code does what the author says it does.

**Evidence:** Every 2026 write-up on context engineering for review agents
converges on this as a *minimum*, not a nice-to-have: "Minimum inputs include
the PR diff, PR title, PR description, and branch name to reduce
misinterpretation of the change's intent" (SurePrompts), and "the ticket
carries the intent the code is judged against — without the requirements, an
AI reviewer can tell whether the code is well built, but not whether it does
what it should" (CodeRabbit's agentic-context-engineering guide). CodeRabbit's
"PR and Issue Indexing" pulls Jira/Linear/GitHub Issues specifically for this
(already noted in file 06 §4, still unimplemented in Loupe).

**Concrete implementation:**
- One extra REST call per run: `GET /repos/{owner}/{repo}/pulls/{n}` → `title`,
  `body`. Cheap, same auth token, same shape as `fetchRepoFile` in `config.ts`.
- Linked issues, tiered by effort: (a) **free tier** — regex-parse the PR body
  for GitHub's own closing keywords (`close[sd]?|fix(e[sd])?|resolve[sd]?
  #\d+`), needs zero extra permission since the body is already fetched; (b)
  **better tier** — GraphQL `closingIssuesReferences(first: 10) { nodes {
  number title body } }` on the PR, which also catches the "Development"
  sidebar links the regex misses; requires `issues: read` on the token (add to
  the Action's `permissions:` block — a one-line workflow change, already
  listed as an App permission for M3).
- New `PrIdentity` fields (`title?`, `body?`) or a sibling `PrIntent` struct
  populated in `run.ts` before the reviewer prompt is built; new prompt
  placeholder `{{PR_INTENT}}` rendered as "Title: …\nDescription: …\nLinked
  issue #123: …" or `(none)`.
- Add one line to the do-not-report / scope section of the prompt: intent
  context is background for judging correctness, not a spec to enforce
  literally — avoids the model inventing "you didn't implement X" findings off
  a stale or sloppy PR description.

**Effort: S.** One API call (+ one optional GraphQL call), one new prompt
placeholder, no new packages, no new agentic tools.

---

## 2. Intent/scope-consistency check (built on §1)

**What's missing:** a distinct finding category that catches "PR description
promises X, diff only does part of X" or "diff does something unrelated to
the stated intent" — a real, cheap, high-trust class of bug (partial
implementations, scope creep, forgotten edge cases mentioned in the ticket but
not handled).

**Evidence:** "AI Reviewer cross-references your PR description against the
actual code changes, flagging any promised business logic that hasn't been
implemented" (lowcode.agency, 2026 survey of PR-review automation).

**Concrete implementation:** once `{{PR_INTENT}}` exists (§1), add a rubric
line and a `scope-mismatch` (or reuse `category: "other"`) finding class to
`prompts/reviewer-v4.md`: "If the PR title/description/linked issue names
specific behavior the diff does not implement, or the diff does something the
description doesn't mention, report it at `medium` severity, citing the
specific unmet claim." No new plumbing beyond the prompt text — the
`Finding`/severity/category shape is unchanged.

**Effort: S** (prompt-only, contingent on §1). **Priority: actionability +
trust** — this is the kind of finding a human reviewer would actually thank
the bot for, versus another style nit.

---

## 3. Reverse-dependency ("who imports this file") impact tool

**What's missing:** Loupe's agentic `grep` tool can search for an identifier
by name, but nothing tells the reviewer *which files would break* if a
changed export's shape changed — the single most-cited mechanism competitors
use to catch cross-file regressions.

**Evidence:** Greptile's pitch is explicitly this: "builds a Semantic Code
Graph… so it can flag a change that breaks a caller three files away";
independent 2026 comparisons note "monorepos with strong internal coupling
get more from Greptile, because the cross-file context is where the bugs
hide" (BirJob AI code review comparison, 2026). CodeRabbit "re-generates [a
code dependency graph] on every review to avoid missing new dependencies" and
uses it to find callers/references of any touched symbol (file 06 §4,
previously noted but unbuilt).

**Concrete implementation — regex import scan, not a real parser:**
- New function in a new module (e.g. `packages/engine/src/importgraph.ts`):
  walk `RepoReader.listTree()`, for each JS/TS/Python file regex-match import
  statements (`import ... from '...'`, `require(...)`, `from X import Y`,
  resolve relative paths against the importing file's directory — no
  `tsconfig.json` path-alias resolution needed for v1, just relative + bare
  specifiers matched against the tree). Build a `Map<file, Set<importer>>` in
  one pass over the (already-fetched-once-per-run) tree.
- Expose it as a new agentic tool, `find_importers`, following the exact
  pattern of `runGrep`/`runReadFile` in `agentic.ts`: `{"tool": "find_importers",
  "path": "src/foo.ts"}` → list of files that import it, ranked by whether
  they also reference the specific changed export name (cheap second grep
  pass, reusing the existing `RepoReader.readFile`).
- Document it in the `TOOLS` section of the reviewer prompt next to `grep`/
  `read_file`; caps come for free from the existing `AgenticCaps` (file-read
  budget) since it's built from the same reader.

**Why it beats plain `grep`-for-the-symbol-name:** grep for an identifier
returns every textual match (including unrelated shadowed names, comments,
strings); `find_importers` gives a structurally-scoped starting set (files
that actually import the module) before the model has to reason about which
matches are real call sites — cuts noise in the model's own exploration,
which is a precision lever on the *tool output*, not just the prompt.

**Effort: M** (~1–2 days: import-statement regex set for JS/TS + Python,
relative-path resolution, tests on Loupe's own repo as the fixture, wiring
into `guardrail.ts`'s `ToolCallRequest` union and `agentic.ts`'s dispatch).

---

## 4. Blast-radius signal for risk escalation (built on §3)

**What's missing:** `escalate.ts` currently escalates only on a path-name
heuristic (auth/payment/migration/crypto/secret substrings). It has no signal
for "this file has 40 importers" vs "this file has 0" — a change to a
widely-depended-on module is inherently higher-risk regardless of its path.

**Concrete implementation:** once §3's import graph exists for the run, add
one pure function `highBlastRadius(changedFiles, importGraph, threshold)` and
OR it into the existing `shouldEscalate` boolean in `escalate.ts` — same
call site in `run.ts`, one new signal, no new config surface required (though
a `.aireview.toml` threshold override would be a natural, cheap follow-up).

**Effort: S** (once §3 exists; this is a ~20-line addition to `escalate.ts` +
tests). **Priority:** precision (spend the expensive model where it matters)
more than recall.

---

## 5. TypeScript virtual-language-service symbol resolution (flagship)

**What's missing:** real "go to definition" / "find all references" for
TS/JS — the actual mechanism the research literature identifies as the
correct primitive for cross-file bug-catching ("LSP-style find
references/go-to-definition is the most directly useful primitive" — file 06
§5), which Loupe currently approximates only with regex `grep`.

**Key finding worth acting on:** you do **not** need a running language
server or a real disk checkout to get this. The `typescript` npm package
exposes `ts.createLanguageService()` against an in-memory
`ts.LanguageServiceHost` — you hand it a virtual file map (exactly what
`RepoReader.readFile` already gives you per path) and it gives you real,
type-aware `getReferencesAtPosition`, `getDefinitionAtPosition`, and
`getQuickInfoAtPosition` (hover type info) with no filesystem access at all.
This is the same technique the TypeScript Playground uses to run full
compiler analysis client-side in a browser sandbox — proof it works with no
disk and no subprocess, so it is viable on **both** the Action and (later)
Worker delivery paths, not just Action-with-a-checkout. This directly answers
the research prompt's "call-graph / caller-callee expansion", "def/reference
following", and "type information" asks for the languages Loupe's own repo is
written in.

**Concrete implementation:**
- New optional package `packages/ts-symbols` (same pattern as
  `packages/scope-ts`): implements a small `SymbolIndex` interface
  (`findDefinition(file, line, col)`, `findReferences(file, line, col)`,
  `hoverType(file, line, col)`) backed by a virtual `LanguageServiceHost`
  whose `readFile`/`getScriptSnapshot` are populated lazily from the same
  `RepoReader` already injected for agentic tools — no separate file-fetching
  path, no duplicate caching.
- Wire it in as two new tool types in the existing `tool_calls` protocol:
  `find_definition` and `find_references`, taking a symbol name + file hint
  (resolve to a position by locating the identifier text on the given line —
  simple, since the model already sees line-numbered content) rather than
  raw line/col, so the model doesn't need to reason in character offsets.
  Injected via `RunDeps.symbolIndex`, defaulted to `undefined` (disabled) —
  exactly the `scopeExpander`/`retriever` opt-in pattern already established.
  Absence → those two tool names simply aren't advertised in `{{TOOLS}}`.
- Scope to `.ts/.tsx/.js/.jsx` files for v1 (Loupe's own stack); this is a
  real semantic capability upgrade *specifically* for TS/JS repos, not a
  general-purpose polyglot solution — say so explicitly in the prompt's tool
  docs so the model doesn't expect it elsewhere.

**Effort: L** (>2 days: building a correct virtual `LanguageServiceHost`
against a lazy/async `RepoReader` is the fiddly part — the LSHost API is
synchronous, so file content needs prefetching or a sync cache warmed by a
first async pass; plus symbol-name-to-position resolution, plus new
`ToolCallRequest` variants, plus tests). Highest value-per-research-question
of any candidate here — it is the one item that gives *real* (not
approximated) caller/callee + def/reference + type info simultaneously.

---

## 6. Deterministic `tsc` diagnostics as zero-hallucination findings

**What's missing:** Loupe currently gets 100% of its "does this type-check"
judgment from the LLM's guess. The actual TypeScript compiler already knows,
with certainty, when a changed signature breaks a caller three files away —
and it's very likely already a devDependency of any TS repo Loupe reviews.

**Why this is worth doing distinctly from §5:** §5 gives the *model* better
tools to reason with; this gives the *pipeline* a source of findings that
require no LLM judgment at all — real compiler diagnostics are 100%-precision
by construction (no false positives from a hallucinating model) and catch
exactly the "signature change, caller not updated" class the research prompt
asks about, for free.

**Concrete implementation:**
- New optional package (again following the `scope-ts` pattern), Action-path
  only for v1 (see honesty note below): shell out to the target repo's own
  `tsc --noEmit -p <its tsconfig>` (or `ts.createProgram` via the `typescript`
  package, reusing whatever v5's virtual-host machinery if built) against the
  PR head checkout, filter diagnostics to files/lines touched by the diff
  (using the same `CommentableMap` shape `clamp.ts` already defines for the
  LLM path), and turn each into a `Finding` with `severity: "high"`,
  `category: "type-error"`, no LLM call involved — these merge into the
  existing `rawFindings` array before suppression/anchoring/dedupe, so all
  the existing machinery (severity filter, house-rule suppression, dedupe,
  verifier) applies to them unchanged.
- **Honesty on scope/risk:** this requires a real checkout with the repo's
  `node_modules` installed (the Action path already has this via
  `actions/checkout` + the user's own install step) — it does **not** fit the
  Worker/webhook path (no checkout there) and brushes against the letter of
  "never clone-and-execute untrusted PR code": `tsc` is a static type-checker,
  not code execution (no `eval`, no test/build script runs), so the risk
  profile is much closer to a lint pass than to "execute the PR" — but flag
  this for Ansh's explicit sign-off rather than assuming it clears the bar,
  since some repos' `tsconfig.json` can reference transformer plugins that do
  execute. Recommend gating behind an explicit opt-in config flag
  (`config.typeCheck?: boolean`, default off) so it's never silently on.

**Effort: M/L** depending on how much diagnostic-to-Finding mapping polish is
wanted; the core "spawn tsc, parse diagnostics, filter to changed lines" is
~M. **Priority: precision, hard** — this is the single highest-precision
candidate in this whole file because it isn't a model guess.

---

## 7. Lightweight ctags-style definition index (multi-language fallback)

**What's missing:** §5 only covers TS/JS. Loupe's `RegexScopeExpander`
already special-cases Python (indent-based), and the research prompt asks for
symbol indexing broadly — a cheap, language-agnostic def-location index is
the natural fallback for everything that isn't TS/JS.

**Evidence:** file 06 §5 already scores this correctly: "ctags… cheap, works
offline, decades-old, good enough for jump-to-definition-style lookups… for a
solo project, plain ctags or even AST-grep queries are a much lower-effort
way to get 80% of the value" [than LSP/SCIP]. 2026 write-ups on lightweight
code-intelligence agree: "the simplest tools keep ctags-style text maps or
JSON symbol tables" (survey of local vs. enterprise code-intel approaches,
2026).

**Concrete implementation:** spawn `universal-ctags` (feature-detect: try
`ctags --version`, if absent skip silently — this is optional-enhancement,
not a hard dependency) over the repo tree once per run, parse its tab-separated
output into a flat `Map<symbolName, {file, line}[]>`, and use it to make the
existing `grep` tool's symbol lookups **O(1) exact + fallback to regex scan**
instead of always re-scanning the whole tree — same tool name/interface from
the model's point of view, just a faster/more precise backend when the
binary is present.

**Effort: M.** **Priority: lower than §3/§5/§6** — it mostly makes the
*existing* grep tool faster/more precise rather than adding a new
capability; do this only after the higher-value items, and only if reviewing
non-TS/JS repos becomes a real use case.

---

## 8. Related-tests retrieval

**What's missing:** nothing in Loupe currently tells the reviewer "here is
the test file that exercises this changed function" — a cheap, high-signal
context block for judging both correctness (does the test still pass the new
semantics?) and completeness (was a test added at all for new behavior?).

**Evidence:** "When an agent reasons about whether a function change is
safe, it can issue queries like… 'What tests exercise this path?'" — cited as
core to comprehensive review context (CORE-Bench-adjacent 2026 discussion of
code-review retrieval).

**Concrete implementation, deterministic, no LLM:**
- Naming-convention match: for each changed file `src/x/foo.ts`, look for
  `foo.test.ts`, `foo.spec.ts`, `__tests__/foo.ts`, or a mirrored path under
  a `test(s)/` root — reuse `RepoReader.listTree()` (already fetched once per
  run) for the existence check, no extra API round trips beyond the file
  reads Loupe already does.
- If found, a lightweight grep of the test file for the *name* of the
  specific changed export/function is enough to decide "this test likely
  covers what changed" (per-symbol precision, not just per-file).
- Feed the result into the prompt as a small deterministic addendum next to
  `{{CONTEXT}}` — e.g. a `{{RELATED_TESTS}}` block listing
  "`src/x/foo.test.ts` (found, references `bar()`)" or "no test file found
  for `src/x/foo.ts`" — and add one do-not-report-adjacent rubric line:
  "if no related test file exists for a new/changed function, you MAY note
  this at `low` severity; this is not a demand to add tests, just a factual
  observation." Loupe already suppresses "add a TODO"-style suggestions, so
  phrase the rubric carefully to avoid reintroducing that noise class.

**Effort: S.** This is almost entirely reuse of machinery Loupe already has
(`RepoReader`, prompt placeholder mechanism) — the only new code is the
naming-convention matcher itself.

---

## 9. Git blame / history context via the GraphQL Blame API

**What's missing:** Loupe has no signal for "is this surrounding code old and
stable, or was it itself just written last week by someone else in a
different PR" — a signal that both the reviewer and (especially) the
**verifier** could use directly. The verifier's closed drop-reason enum
already includes `"pre-existing"` — right now the model has to *guess* that a
flagged line predates the PR; blame data would let it *know*.

**Evidence:** HAFixAgent (arXiv 2511.01047, 2026) shows commit-history
signals — blame plus the commits immediately before/after the blamed
change — meaningfully improve an agent's ability to reason about *why* a bug
exists and whether a pattern is a longstanding convention vs. a fresh mistake.
GitHub exposes exactly this via GraphQL, confirmed shape:

```graphql
query($owner:String!, $repo:String!, $path:String!, $ref:String!) {
  repository(owner:$owner, name:$repo) {
    ref(qualifiedName:$ref) {
      target { ... on Commit {
        blame(path:$path) {
          ranges {
            startingLine
            endingLine
            age
            commit { oid messageHeadline committedDate author { name } }
          }
        }
      }}
    }
  }
}
```
(field shapes confirmed via GitHub's public GraphQL docs and community
examples — `Blame`/`BlameRange` objects, `age` is a small integer bucket
GitHub itself computes for UI coloring, useful as a cheap "how old" signal
without date math.)

**Concrete implementation:**
- New function, e.g. in a `history.ts` module: given a file + the enclosing
  span already computed by `scope.ts`, call the blame query once, intersect
  `ranges` against the span, and produce a compact summary: "lines 40–52 last
  touched in `a1b2c3d` ('refactor validation', 3 commits, 2 authors, 400+
  days old)" vs. "lines 40–52 touched in the last 7 days by 1 author" —
  exactly the kind of signal that lets the verifier lean confidently toward
  `pre-existing` for old/stable code and toward taking a fresh finding
  seriously for code that just changed alongside the diff (even if outside
  the hunk itself, e.g. a helper edited in the same PR by a different commit).
- Feed as a new `{{HISTORY}}` labeled context block, or fold directly into
  the existing `{{CONTEXT}}` enclosing-scope block as an extra header line —
  the latter is cheaper (no new placeholder, no new prompt section) and
  keeps the blame data visually attached to the code it describes.
- Natural secondary use: an `escalate.ts` signal ("this file/lines changed N
  times in the last 30 days" → churn-based risk, a well-established static
  analysis heuristic independent of this specific API).

**Effort: M** (~1–2 days: one GraphQL call per distinct file+span, response
parsing, span-intersection logic, prompt wiring, tests with a fixture
GraphQL response).

---

## 10. Ranked repo-map priming block (Aider-style, scoped down)

**What's missing:** on a large or unfamiliar-to-the-model PR, Loupe gives the
reviewer the diff + expanded hunks + (if agentic) on-demand grep/read — but
no *ambient* sense of which files in the neighborhood are structurally
central (heavily imported) before it starts exploring. Aider's repo map
(tree-sitter extraction + PageRank over the file-dependency graph, budgeted to
fit the context window) is the reference implementation for this idea.

**Evidence:** "Aider analyzes the full repo map using a graph ranking
algorithm… PageRank… returns a dictionary mapping each file to score, with
higher scores indicating more important files given the current context"
(Aider docs / DeepWiki repo-mapping-system page). 2026 lightweight-code-intel
surveys note this pattern (tree-sitter + ranked symbol maps) as the standard
"cheap tier" versus SCIP/LSP's "precise tier."

**Concrete implementation, deliberately smaller than Aider's:** don't rank
the *whole* repo — that's needless work for a single-PR review and drifts
toward "build a persistent index," which the project has already correctly
decided against for RAG. Instead, reuse §3's import graph, restricted to a
1–2 hop neighborhood of the changed files, and rank by simple in-degree
(files most depended-on by the neighborhood) rather than full PageRank —
cheaper to compute and explain, and the difference between in-degree and
PageRank matters far more at whole-repo scale than in a small local
neighborhood. Render as a short "these N files are central to what changed;
importing them are: …" block.

**Effort: M.** **Honest caveat on priority:** of everything in this file,
this is the one whose marginal value over "agentic search already available"
is least certain — it's ambient priming for a capability (grep/read
exploration) the model can already reach for on demand. Build §3 first (the
tool); revisit this only if the eval set shows the model isn't reaching for
`find_importers` proactively on large PRs without a nudge.

---

## Considered and explicitly not recommended (for completeness)

**Full SCIP/LSIF index or a persisted graph database** (Sourcegraph-style,
Coograph/KotaDB-style SQLite-backed code-intel stores): these are the
"enterprise tier" in every 2026 source surveyed, aimed at cross-repository
navigation and many-repos-at-once scale (a growing multi-tenant SaaS or a
huge monorepo). For a single-repo, solo-dev, run-once-per-PR tool, they add
persistent storage, index-staleness management, and a build/refresh pipeline
for a benefit the in-memory options above (§5's virtual LanguageService, §3's
per-run import graph) already capture at v1 scale, at a fraction of the
engineering cost and with zero staleness risk (recomputed fresh every run,
same principle the project already applies by rejecting persistent
embeddings-RAG). Revisit only if Loupe ever reviews genuinely large
monorepos where per-run recomputation becomes too slow.

---

## Priority summary (precision → recall → actionability → trust)

| # | Feature | Precision | Recall | Actionability | Effort |
|---|---|---|---|---|---|
| 6 | Deterministic `tsc` diagnostics | ★★★ (zero hallucination) | ★★ | ★★ | M/L |
| 1 | PR/issue intent context | ★★ (fewer misjudged-intent FPs) | ★ | ★ | S |
| 3 | Reverse-import impact tool | ★★ | ★★★ (cross-file catches) | ★★ | M |
| 5 | TS virtual-LS symbol resolution | ★★ | ★★★ | ★★★ (real refs, not guesses) | L |
| 9 | Git blame/history | ★★ (verifier precision) | ★ | ★ | M |
| 2 | Intent-fulfillment check | ★ | ★★ | ★★★ | S |
| 8 | Related-tests retrieval | ★ | ★★ | ★★ | S |
| 4 | Blast-radius escalation | ★★ | — | ★ | S |
| 7 | ctags-lite fallback | ★ | ★ | ★ | M |
| 10 | Ranked repo-map priming | ★ (uncertain) | ★ (uncertain) | ★ | M |

Recommended build order if picking a subset: **1 → 3 → 6 → 5 → 9**, with 2/4/8
as cheap adjacent wins alongside 1/3/9 respectively.

---

## Sources

- [Repository Mapping System — Aider-AI/aider (DeepWiki)](https://deepwiki.com/Aider-AI/aider/4.1-repository-mapping-system)
- [Repository map — aider docs](https://aider.chat/docs/repomap.html)
- [Building a better repository map with tree sitter — aider blog](https://aider.chat/2023/10/22/repomap.html)
- [Best Code Review Tools 2026: 8 AI Code Review Tools Compared — Greptile](https://www.greptile.com/content-library/best-ai-code-review-tools)
- [AI Code Review Tools 2026: CodeRabbit, Greptile, Diamond, Cody, Cursor — BirJob](https://www.birjob.com/blog/ai-code-review-tools-2026)
- [The practical guide to agentic context engineering — CodeRabbit](https://www.coderabbit.ai/guides/agentic-context-engineering)
- [AI Pull Request Reviews: Automate Code QA 2026 — LOW/CODE](https://www.lowcode.agency/blog/ai-pull-request-review-automation)
- [How we built a high-quality AI code review agent — Augment Code](https://www.augmentcode.com/blog/how-we-built-high-quality-ai-code-review-agent)
- [We benchmarked 7 AI code review tools on real-world PRs — Augment Code](https://www.augmentcode.com/blog/we-benchmarked-7-ai-code-review-tools-on-real-world-prs-here-are-the-results)
- [gitlab-review-agent (search_code / multi_diff tools) — GitHub](https://github.com/antlss/gitlab-review-agent)
- [HAFixAgent: History-Aware Automated Program Repair Agent (arXiv 2511.01047)](https://arxiv.org/pdf/2511.01047)
- [Vibe coding needs git blame — Quesma blog](https://quesma.com/blog/vibe-code-git-blame/)
- [Code Intelligence & Code-Graph Indexing for AI Agents 2026 — Anthony West](https://anthonywest.co.uk/research/code-intelligence-indexing-2026-openai)
- [SCIP - a better code indexing format than LSIF — Sourcegraph](https://sourcegraph.com/blog/announcing-scip)
- [The future of SCIP — Sourcegraph](https://sourcegraph.com/blog/the-future-of-scip)
- [Rev-dep — High-Speed Dependency Graph Analysis for JS/TS Monorepos](https://rev-dep.com/)
- [py-dependency-mapper — PyPI (reverse-lookup impact analysis)](https://pypi.org/project/py-dependency-mapper/)
- [TypeScript-wiki: Using the Compiler API — microsoft/TypeScript-wiki](https://github.com/microsoft/TypeScript-wiki/blob/main/Using-the-Compiler-API.md)
- [ts-morph-analyzer skill (call-chain tracing, low token usage) — playbooks.com](https://playbooks.com/skills/ratacat/claude-skills/ts-morph-analyzer)
- [ts-morph — npm](https://www.npmjs.com/package/ts-morph)
- [An example GraphQL query to get git blame data from the GitHub GraphQL API — gist (davidcelis)](https://gist.github.com/davidcelis/dd85095ac46e159b9efe420687aaa7e9)
- [BlameRange — GitHub GraphQL docs (v4 object reference)](https://developer.github.com/v4/object/blamerange/)
- [Fetching Github Blame with the GraphQL API V4 — Menubar](https://menubar.io/github-blame-graphql-api-v4/)
- [Support GraphQL closingIssuesReferences — PyGithub issue #2567](https://github.com/PyGithub/PyGithub/issues/2567)
- [Add field to retrieve linked issues (closingIssuesReferences) — cli/cli issue #10529](https://github.com/cli/cli/issues/10529)
- [CORE-Bench: A Comprehensive Benchmark for Code Retrieval in the Era of Agentic Coding (arXiv 2606.11864)](https://arxiv.org/html/2606.11864)
- Existing project research: `research/06-context-and-rag-strategies.md`,
  `research/08-synthesis-architecture-and-milestones.md` (read for
  already-covered ground and existing architecture decisions).
