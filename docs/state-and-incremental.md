# M5 — state, incremental re-review, rules, run log, RAG (tasks 7.1–7.6)

Personal notes on how the M5 pieces fit. Engine modules: `state.ts`,
`incremental.ts`, `runlog.ts`, `retrieve.ts` (+ `packages/rag`).

## State model (7.1)

Per PR, keyed `owner/repo#number` (`prStateKey`):

```ts
PrState = {
  lastReviewedSha: string;      // gate + incremental compare base
  hunkHashes: string[];         // content hashes of hunks already reviewed
  openFindings: PersistedFinding[]; // published, not yet resolved
}
```

Behind `StateStore { get, set }`, injected via `RunDeps.stateStore`:

- **Worker/App path** — `KvStateStore` over a minimal `{get, put}` KV slice.
  Binding `REVIEW_STATE` in `packages/worker/wrangler.toml` (placeholder id;
  real one comes from `wrangler kv namespace create REVIEW_STATE` when
  deploys are allowed; `wrangler dev` simulates it locally). No binding →
  stateless mode.
- **Action path** — `FileStateStore`, one flat JSON file
  `{ "<prKey>": PrState }`. Enabled by setting `REVIEW_STATE_PATH` (point it
  at something persisted, e.g. an actions/cache path). Injectable fs, so
  tests run in memory.

**Fallback:** the hidden summary-comment marker still carries the
last-reviewed SHA (M2 behavior). No store → gate still works, but there are
no hunk hashes and no carry-forward — the marker is the floor, the store is
the durable upgrade. Corrupt/missing state always reads as `null`, never
crashes. State is persisted only after a posted (non-dryRun) run.

## Incremental scoping (7.2)

`RunEvent.before` (top-level `before` on `synchronize`, wired in both
adapters) + a known prior review → the engine fetches
`GET /repos/{o}/{r}/compare/{base}...{head}` with the diff media type instead
of the full PR diff. The base is `lastReviewedSha` (not the event's
`before`), so pushes the gate skipped are still covered. Full PR diff for:
first review, no `before` (opened/reopened), on-demand `/review`, or a failed
compare fetch (falls back with a notice — never dies).

Hunk hashes (`hashHunk`: FNV-1a ×2 over path + line types/contents, line
numbers excluded so shifted-but-unchanged hunks still match) let the engine
drop already-reviewed hunks even inside the new range; fully-skipped files
show up in the summary as `(already-reviewed)`. Hash-skipping never applies
to on-demand runs.

## Still-open carry-forward (7.3)

On an incremental run, persisted `openFindings` are partitioned against the
before..after diff using **old-side** hunk spans (correct coordinates: the
old side *is* the revision the findings were reported on):

- file untouched → **still open** (summary section only, never re-posted inline)
- line inside a changed hunk / file deleted / file-level on a touched file →
  **assumed resolved**, dropped from the open set

The "Still open from previous runs" summary section = carried findings ∪
dedupe hits (the M2 mechanism — unified, dedupe stays as the stateless
floor). New findings on newly changed code post inline as normal. The next
state's `openFindings` = this run's published findings ∪ still-open (capped).

## Custom rules (7.4)

`.aireview.toml`, two forms (schema choice: array-of-tables for scoping, plain
string array for the common unscoped case):

```toml
rules = ["No console.log in production code"]   # unscoped (pattern "**")

[[rules]]
pattern = "src/api/**"
text = "All API handlers must validate input with zod"
```

Rules whose glob matches at least one reviewed path are injected into
`{{CUSTOM_RULES}}` in **reviewer-v4.md** (v3 left untouched per the
never-edit-shipped rule; v4 also adds `{{RETRIEVED_CONTEXT}}`). Invalid rule
entries invalidate the whole config → safe defaults + summary notice, same as
every other config error.

## Run log (7.5)

`EngineConfig.runLogPath` → one JSONL record per completed run: pr, timestamp,
model, tokens, est cost, findings kept/dropped, drop-reason histogram,
verifier-dropped, escalated, incremental. Action path: set
`REVIEW_RUN_LOG_PATH`. Determinism: the engine never calls `Date.now()` — the
timestamp comes from the injectable `deps.now` clock (same pattern as the
cost ledger's month key). `readRunLog` + `summarizeRunLog` give the
self-analytics rollup. Writes are best-effort.

## RAG experiment status (7.6)

- Engine seam: `Retriever` interface, `RunDeps.retriever`, flag
  `EngineConfig.rag` (**default off**). Retrieved chunks render into the
  prompt as labeled supplementary reference material; retrieval failures are
  a notice, never a crash.
- Implementation: `packages/rag` — `InMemoryRetriever` (paragraph chunking +
  cosine similarity) with an injectable `Embedder`; the built-in
  `HashEmbedder` is a deterministic hashed bag-of-words baseline (offline,
  also the test mock).
- **sqlite-vec, honestly:** not wired in. It needs a native SQLite module
  (better-sqlite3 build or a per-platform loadable extension) and would buy a
  persistent on-disk index, sub-linear scaling to tens of thousands of
  chunks, and SQL-side filtering fused with the vector scan. This project's
  corpus (house rules, a few ADRs, past findings) is a few hundred chunks —
  in-memory brute force is microseconds, so the native build isn't earning
  its keep. Upgrade path: `nub add better-sqlite3 sqlite-vec` inside
  `packages/rag`, implement `Retriever` over a `vec0` virtual table; the
  engine seam doesn't change.
- The RAG-on vs RAG-off comparison note (task 7.8) needs live eval runs —
  deferred with the rest of the live-verification phase.
