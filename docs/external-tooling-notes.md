# External tooling notes — promptfoo & DSPy (recommended, deliberately not built in)

Two well-known tools keep coming up for exactly the kind of eval/prompt work
Loupe does: **promptfoo** (prompt & model A/B testing) and **DSPy** (offline
prompt optimization). This note records, honestly, why neither is a dependency
of Loupe and how Ansh could still use each **out-of-band** against the eval
corpus if the hand-rolled harness ever stops paying its way.

Sources: `research/features/eval-measurement.md` §C.4 (promptfoo) and §F (DSPy).

## Why they are external, not built in

- **Zero-dep / local ethos.** `packages/engine` is deliberately zero-runtime-dep
  (plain `fetch`), and the whole project is free-tier / local-first. promptfoo is
  a Node package and DSPy is a **Python** framework — a second-language runtime in
  an otherwise all-TypeScript repo. Neither belongs in the engine or the
  Action/Worker bundle.
- **"Don't gold-plate."** The `evals/` harness already covers the 80% these tools
  are famous for — A/B (`--ab`), A/A self-test (`--selftest`), golden-snapshot
  regression (`--snapshot`), shadow-mode dual-run (`--shadow`), McNemar + Cohen's
  kappa, and a local trend log/HTML. For a solo learning project that's the
  "simplest thing that works." These tools are the escape hatch for **if the
  harness starts eating real time**, not a now-need.
- **They stay out-of-band.** Both operate on the same corpus and the same
  provider calls Loupe already makes; neither has to touch engine code to be
  useful. So there is no reason to vendor them — install ad hoc, use, discard.

## promptfoo — prompt/model A/B & regression testing (Node, MIT)

CLI-first, YAML-driven; runs fully locally except for the provider calls Loupe
already makes. Does side-by-side prompt/model comparison, CI-friendly non-zero
exit on regression, and web-view diffs out of the box — a superset of the
`evals/run.mjs --ab/--snapshot` modes with a nicer UI.

How Ansh could use it out-of-band (no repo change):

- `npx promptfoo@latest init` in a scratch dir (never added to `package.json`).
- Point a `providers:` block at the same endpoint Loupe uses (Haiku / Gemini /
  an OpenAI-compatible base URL), and a `prompts:` block at
  `prompts/reviewer-v*.md` to compare two prompt versions on identical inputs.
- Feed it the eval corpus as `tests:` — the `evals/cases/*.mjs` fixtures, the
  SZZ-mined cases from `evals/mine-corpus.mjs`, or the public-benchmark cases from
  `evals/benchmarks.mjs` (export the diffs to promptfoo's `vars` shape).
- Use it as the "should I promote reviewer-vN → vN+1" gate before bumping the
  default in `prompt.ts`, then throw the scratch dir away.

Reach for it when the hand-rolled A/B output stops being enough (many prompt
variants at once, a richer diff view, or sharing a run with someone).

## DSPy — offline prompt optimization (Python)

Compiles a measurable metric + labeled examples into an automatically-tuned
prompt via optimizers like MIPRO/OPRO; runs against a local model, no GPU needed.
Its own guidance is **≥50 labeled examples** minimum, so it only becomes viable
once `evals/mine-corpus.mjs` (SZZ mining) and/or `evals/benchmarks.mjs` have
grown the corpus past a handful of hand-written cases.

How Ansh could use it out-of-band (offline dev tooling only):

- In a separate Python venv (never a dependency of this repo), express the review
  task as a DSPy signature, feed it the mined/benchmark corpus as labeled
  examples, and let an optimizer search for better instruction phrasing /
  few-shot exemplars.
- Treat the output as **suggestions to hand-copy** into the next
  `prompts/reviewer-v<N+1>.md` — never a runtime dependency, never auto-applied.
  Verify any suggested change with the normal harness (`--ab` / `--snapshot`)
  before it becomes the default.

Flagged honestly as a **later** experiment, not a now-priority: it's a
second-language toolchain whose payoff only appears after the corpus is large and
the harness has shown *where* the prompt is actually weak.

## Bottom line

Both are good tools and worth knowing. Loupe keeps the eval harness hand-rolled
and in-repo (zero-dep, local, already sufficient); promptfoo and DSPy stay as
external, out-of-band options to run against the same corpus if and when the
in-repo harness stops being the simplest thing that works.
