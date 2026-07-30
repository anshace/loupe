# evals/

Offline eval harness for the review pipeline. Everything here is **local** — the
only thing that ever leaves the machine is a live LLM provider call, and only
when you explicitly set `REVIEW_MODEL` to a real provider (default is a
deterministic offline replay, safe for CI).

## Layout

- `cases/*.mjs` — hand-authored fixture cases. Each supplies a `diff`,
  `fileContents`, a canned `mockResponses` (replayed offline), and
  `expectedFindings`. `cases/_util.mjs` has the diff builders.
- `run.mjs` — the harness (see modes below).
- `history.mjs` — trend log + local HTML render (report item #11).
- `harness.mjs` — pure A/B + snapshot helpers (report item #24).
- `mine-corpus.mjs` — SZZ-style real-bug corpus mining (report item #25).
- `snapshots.json` — committed golden full-output baseline for `--snapshot`.
- `history.jsonl` — appended trend log (kept); `history.html` — regenerated,
  git-ignored. `mined/` — generated cases, git-ignored.

The `*.test.mjs` files are pure unit tests for the helpers above and run under
`nub run test` (vitest), not the engine build.

## Modes

```bash
nub run eval                        # default pass/fail run (exit 1 on any miss)

# Trend log (#11) — date/sha are passed IN (never Date.now()), so appends are
# reproducible. Rebuilds a self-contained evals/history.html you open directly.
node evals/run.mjs --history --sha=<sha> --date=<YYYY-MM-DD> [--prompt=reviewer-v9]
node evals/history.mjs render                 # rebuild history.html from the JSONL

# A/A self-test (#24) — run the corpus twice under one config; MUST be identical.
# A "significant" A/B result under a non-deterministic harness is meaningless, so
# this is the mandatory sanity gate.
node evals/run.mjs --selftest

# A/B paired comparison (#24) — configs are JSON merged into the engine config.
# Reports per-case deltas + McNemar's test (runs the A/A self-test first).
node evals/run.mjs --ab --configB='{"verify":true}' [--configA='{}']

# Golden-output regression (#24) — full finding-set diff vs the committed baseline.
node evals/run.mjs --snapshot            # fails (exit 1) on any drift
node evals/run.mjs --snapshot --update   # re-baseline (commit the change deliberately)
```

Statistical caveat (see `research/features/eval-measurement.md` §C.1): with a
~20-case corpus a paired test only catches *catastrophic* regressions — treat the
McNemar `significant` flag as a smoke alarm, not proof. Grow the corpus with
mining (below) before trusting fine-grained deltas.

## SZZ real-bug corpus mining (#25)

`mine-corpus.mjs` reconstructs bug-**fix** commits from **local** git checkouts
into synthetic **pre-fix** cases: the pre-fix state of a touched file becomes the
"PR" diff, and the lines the fix deleted/modified become the golden finding
location, with the category inferred from the commit subject.

**Local only — never clones or fetches over the network.** Point it at repos you
already have on disk. With no repos configured it no-ops with a message.

```bash
node evals/mine-corpus.mjs --repo=. --limit=20              # mine this repo
node evals/mine-corpus.mjs --repo=/path/to/cloned/oss --grep=fix
MINE_REPOS="/path/a;/path/b" node evals/mine-corpus.mjs
node evals/mine-corpus.mjs --repo=. --dry-run               # count only, write nothing
```

Output lands in `evals/mined/` (git-ignored) as `.mjs` cases in the standard
format. Mined cases carry **no** `mockResponses`, so they are **live-mode only**
(run with `REVIEW_MODEL=<provider>` set) and are not discovered by the default
deterministic `nub run eval` (which only reads `cases/*.mjs`, non-recursively).
