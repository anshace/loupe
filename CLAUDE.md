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
- `documentation/` — team-facing docs, **English only**.
- `docs/` — Ansh's personal notes/scratch (Hindi allowed). No structure required.

## Hard rules

- **Everything stays local.** Shared machine/account: no Artifacts, no cloud
  uploads, no share links, no pushing to remotes unless Ansh explicitly says so.
- Git identity: `Ansh Roshan <75963202+anshace@users.noreply.github.com>`,
  no Co-Authored-By trailers.
- Prefer free tiers and the simplest thing that works; this is a solo-dev,
  learn-by-building project. Don't gold-plate.
- Model usage preference: Fable orchestrates/advises; delegate execution work to
  Sonnet/Opus subagents where subagents are used.

## Conventions (to be firmed up once the stack is chosen in the design phase)

- Stack decisions live in `openspec/changes/*/design.md` and
  `research/08-synthesis-architecture-and-milestones.md` — check there, don't guess.
