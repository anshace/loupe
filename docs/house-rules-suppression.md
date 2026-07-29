# HOUSE_RULES.md and the `suppress:` convention (M2)

The reviewer supports an optional `HOUSE_RULES.md` committed at the root of the
reviewed repository, read from the PR head revision on every run (no redeploy
needed). It does two things:

## 1. Prompt-level guidance (judgment)

The whole file is injected into the reviewer prompt (reviewer-v2.md) inside a
clearly delimited `<house-rules>` block, and the model is instructed not to
report anything an explicit house rule permits or declares intentional
(e.g. "we intentionally use X").

Honest limitation: "this finding contradicts a house rule" is a judgment call
that cannot be detected deterministically in code, so this part is prompt-level
only. A verifier-stage hook (M4) will re-check findings against the rules with
cited evidence.

## 2. Code-level suppression (deterministic): `suppress:` lines

For deterministic, testable suppression, any line of the file matching

```
suppress: <substring>
```

(optionally as a `-` / `*` bullet; case-insensitive keyword) registers a
**case-insensitive substring filter**. Before publishing, the engine drops any
finding whose title or body contains that substring, and records the drop in
the run's suppression record (shown as a count in the summary comment — never
a silent drop).

Example `HOUSE_RULES.md`:

```markdown
# House rules

- We intentionally use snake_case for DB column mappers.
- console.log is our sanctioned logging mechanism in scripts/.

suppress: snake_case
suppress: console.log
```

Notes:

- Filters match finding **title/body text**, not file paths — use the
  `ignore` globs in `.aireview.toml` to exclude paths.
- Keep filters specific; a short generic substring ("error") will eat real
  findings.
- Absent `HOUSE_RULES.md` → no block is injected and no suppression applies.

Implementation: `packages/engine/src/suppress.ts`
(`parseHouseRuleSuppressions`, `applySuppressions`).
