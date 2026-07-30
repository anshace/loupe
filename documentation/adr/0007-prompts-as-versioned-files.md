# 0007. Prompts as versioned files, never edited in place

## Status

Accepted.

## Context

The reviewer and verifier prompts carry the load-bearing behavior: the severity
rubric, the do-not-report list, the required JSON findings schema, and
programmatically injected constraints (valid commentable line ranges, house
rules, cross-file callers). If prompts live as inline strings in code, they are
hard to diff, impossible to A/B-test without a code change, and a silent edit can
change every future run's behavior with no record of what changed or when.

## Decision

Keep every prompt as a **versioned markdown file** under `prompts/`, named
`<role>-v<N>.md`, and **never edit a shipped version in place** — any change to a
prompt that has been used in a real run means a new file at `N+1`
(`prompts/README.md`). Code selects the prompt file (and therefore the version)
explicitly, so runs are reproducible and versions are A/B-testable by
configuration alone. Placeholders (e.g. `{{HOUSE_RULES}}`, `{{CONTEXT}}`,
`{{PR_INTENT}}`, `{{CROSS_FILE_CALLERS}}`) mark where the engine injects computed
context.

## Consequences

**Positive**

- Prompts are diffable and reviewable like code; the git history is the changelog
  of the bot's behavior.
- A/B testing and rollback are config, not code edits — point the engine at
  `reviewer-v6.md` vs `reviewer-v7.md` and compare on the eval harness.
- Reproducibility: a past run's behavior is pinned to a specific, immutable
  prompt file, so eval results stay attributable to a version.

**Negative / trade-offs**

- Version proliferation over time (the repo already carries `reviewer-v1`…`v7`
  and `verifier-v1`…`v2`); superseded versions accumulate rather than being
  edited away.
- The never-edit rule requires discipline — even a typo fix in a shipped prompt
  is a new version, which can feel heavyweight for small changes.

## Alternatives considered

- **Inline prompt strings in code.** Rejected: not diffable in isolation, no
  version pinning, no A/B without a code change, and edits silently alter every
  run — exactly the reproducibility loss this decision avoids (ClawSweeper /
  ai-pr-review-agent established the versioned-file pattern).

See also: `design.md` decision 7; `prompts/README.md`.
