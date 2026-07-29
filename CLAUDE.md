# AI PR Review Agent (working name: "code-review")

Ansh Roshan is building his own AI pull-request review agent — in the spirit of
CodeRabbit, Qodo Merge (PR-Agent), Greptile — as a learning-first but real project.

## What this project is

A bot that, when a PR is opened/updated on GitHub, gathers the diff plus relevant
repo context, has an LLM review it, and posts inline review comments + a summary
back on the PR.

## Source of truth

- `openspec/` — **the source of truth** for what we're building. All changes go
  through OpenSpec (`/opsx:propose` → `/opsx:apply` → `/opsx:archive`). Read the
  active change under `openspec/changes/` before implementing anything.
- `research/` — competitor/product/stack research files (numbered 01-09). Read
  `08-synthesis-architecture-and-milestones.md` for the architecture decisions
  and milestone roadmap.
- `docs/` — Ansh's personal notes/scratch (Hindi allowed). No structure required.
  This is a solo project (Ansh + Claude only) — no team-facing `documentation/`
  folder; openspec + research are the documentation.

## Hard rules

- **Everything stays local.** Shared machine/account: no Artifacts, no cloud
  uploads, no share links, no pushing to remotes unless Ansh explicitly says so.
- **No GitHub pushes until the whole app is built and locally tested** (Ansh's
  explicit decision, 2026-07-29). Live-verification tasks in tasks.md (2.4,
  3.11, 4.12–4.13, 5.9, 6.8, 7.7–7.8 where they need real PRs) are deferred to
  one final verification phase; develop against unit tests and mock providers.
- Git identity: `Ansh Roshan <75963202+anshace@users.noreply.github.com>`,
  no Co-Authored-By trailers.
- Prefer free tiers and the simplest thing that works; this is a solo-dev,
  learn-by-building project. Don't gold-plate.
- Model usage preference: Fable orchestrates/advises; delegate execution work to
  Sonnet/Opus subagents where subagents are used.

## Tooling

- **Use `nub`, not npm** (Ansh's rule — nub is installed at `~/.nub/bin`, a full
  npm replacement: `nub install`, `nub add`, `nub run <script>`, `nub x <pkg>`).
- `create-reactor` (Ansh's own npm package) scaffolds React frontends — use it
  only if/when a dashboard UI is ever built (v1 has no UI by design).

## Conventions (to be firmed up once the stack is chosen in the design phase)

- Stack decisions live in `openspec/changes/*/design.md` and
  `research/08-synthesis-architecture-and-milestones.md` — check there, don't guess.
