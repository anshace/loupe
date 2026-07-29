# prompts/

Versioned markdown prompt files — the source of truth for all model
instructions (design decision 7). No prompt text lives inline in code.

## Convention

- File name: `<role>-v<N>.md`, e.g. `reviewer-v1.md`, `verifier-v1.md`.
- **Never edit a shipped version in place.** Any change to a prompt that has
  been used in a real run means a new file with `N+1`.
- Code selects the prompt file (and therefore version) explicitly, so runs
  are reproducible and versions are A/B-testable by config alone.
- Prompts carry the severity rubric, do-not-report list, required JSON
  findings schema, and any programmatically injected constraints (e.g. valid
  commentable line ranges) as documented placeholders.

First real file arrives with M1: `reviewer-v1.md`.

Versions:

- `reviewer-v1.md` — M1 single-pass reviewer (rubric + line-range constraint).
- `reviewer-v2.md` — M2: adds the do-not-report list and the `{{HOUSE_RULES}}`
  block.
- `reviewer-v3.md` — M4: adds the `{{CONTEXT}}` enclosing-scope block and the
  `{{TOOLS}}` capped agentic-tool protocol.
- `reviewer-v4.md` — M5: adds the `{{CUSTOM_RULES}}` block (path-scoped
  `.aireview.toml` rules, task 7.4) and the `{{RETRIEVED_CONTEXT}}` block
  (optional RAG experiment, task 7.6 — "(none)" unless the `rag` flag is on).
  v3 was left untouched per the never-edit-shipped rule.
- `reviewer-v5.md` — adds the `{{PR_INTENT}}` block + scope-mismatch rubric
  (feature #3), the per-language `{{SECURITY_CHECKLIST}}` block (feature #5,
  CWE Top-25 / input-validation), a single-line `suggestion` instruction (for
  a later GitHub-suggestion-block renderer), and a grounding instruction
  (feature #6).
- `reviewer-v6.md` — adds the `{{CROSS_FILE_CALLERS}}` block (report item #8,
  cross-file recall): call sites in other files of exported signatures the diff
  changed, force-injected so the reviewer checks whether every caller was
  updated; documents the new `find_importers` agentic tool.
- `reviewer-v7.md` — splits the fix output into a committable `suggestedLine`
  (exact single-line replacement → rendered as a one-click GitHub
  ```suggestion block, report item #7) and free-text `suggestion` prose, so the
  publish renderer can tell the committable case apart. v6 overloaded
  `suggestion` for both. **Current engine default.**
- `verifier-v1.md` — M4: adversarial verifier — keep/rewrite/drop per finding
  with cited `file:line` evidence and the closed drop-reason enum.
- `verifier-v2.md` — requires grounded `file:line` + verbatim-quote evidence on
  EVERY verdict (keep/rewrite too), checked deterministically by the engine
  (feature #1), and adds the `insufficient-context` abstention drop reason
  (feature #6). **Current engine default.**
