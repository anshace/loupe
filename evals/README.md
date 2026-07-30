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
- `harness.mjs` — pure A/B + snapshot + shadow-mode helpers (report item #24 +
  shadow-mode rounding-out).
- `calibration.mjs` — Brier / ECE / Cohen's kappa helpers (report item #30).
- `mine-corpus.mjs` — SZZ-style real-bug corpus mining (report item #25).
- `benchmarks.mjs` — public-benchmark adapters (CodeReviewer / PrimeVul-style
  JSONL → eval cases; LOCAL only, rounding-out item).
- `snapshots.json` — committed golden full-output baseline for `--snapshot`.
- `history.jsonl` — appended trend log (kept); `history.html` — regenerated,
  git-ignored. `mined/` and `benchmarks/` — generated cases, git-ignored.

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

# Shadow-mode dual-run — score a SHADOW config alongside the authoritative PRIMARY.
# Asymmetric framing (unlike --ab): "if I promoted the shadow, how would the posted
# outcome change, and is that safe?" Reports per-case verdicts (agree / shadow-more /
# shadow-fewer / shadow-different) + an "if promoted" roll-up. The shadow NEVER
# affects the primary — the mode re-runs the primary after the shadow and asserts an
# identical outcome (isolation check; aborts offline if that ever breaks).
node evals/run.mjs --shadow --shadowConfig='{"verify":true}' [--primaryConfig='{}']

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

## Public benchmark adapters

`benchmarks.mjs` adapts a **LOCAL** copy of a public code-review / vulnerability
dataset (JSONL) into the same eval-case format, to track recall/precision against
public data (see `research/features/eval-measurement.md` §A). Two formats:

- `codereviewer` — CodeReviewer / Tufano-style records (a diff/patch + the human
  reviewer's comment); diff-grained, region-level gold (the reviewer commented
  *somewhere* in the added block — no `mustMatch`, since these comments are noisy).
- `primevul` — PrimeVul / BigVul-style records (a function body + a 0/1 vulnerable
  label + optional CWE); function-grained, and only the **vulnerable** samples
  become gold `security` positives (benign ones are skipped).

**Local only — never downloads or clones.** Point it at a JSONL file you already
have on disk; with no dataset path (or a missing file) it no-ops with a message.

```bash
node evals/benchmarks.mjs --dataset=/path/to/codereviewer.jsonl --format=codereviewer
node evals/benchmarks.mjs --dataset=/path/to/primevul_test.jsonl --format=primevul --limit=200
BENCHMARK_DATASET=/path/ds.jsonl BENCHMARK_FORMAT=primevul node evals/benchmarks.mjs
node evals/benchmarks.mjs --dataset=... --format=... --dry-run   # count only, write nothing
```

Output lands in `evals/benchmarks/` (git-ignored). Like mined cases these carry
**no** `mockResponses` — **live-mode only**, not discovered by the default run.

## External eval tooling (promptfoo, DSPy)

Deliberately **not** built into Loupe (zero-dep/local ethos). See
[`docs/external-tooling-notes.md`](../docs/external-tooling-notes.md) for how to
use them out-of-band against this corpus if the in-repo harness stops paying off.
