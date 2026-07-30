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
  `suggestion` for both. Superseded as the default by v9.
- `reviewer-v8.md` — adds two OPTIONAL, flag-driven placeholder blocks on top of
  v7: `{{FEWSHOT_EXEMPLARS}}` (report item #14, curated true/false-positive
  worked examples, injected only when the `fewShotExemplars` flag is on) and
  `{{WALKTHROUGH_INSTRUCTION}}` (report item #26, tells the model to also emit a
  prose `walkthrough` field by wrapping output as `{walkthrough, findings}` when
  the `walkthrough` flag is on). Both flags DEFAULT OFF — unproven precision /
  trust-UX levers pending live-eval measurement. Superseded as the flagged
  variant by v10.
- `reviewer-v9.md` — adds two deterministic read-only context blocks on top of
  v7: `{{RELATED_TESTS}}` (report item #17, sibling-test discovery + a factual
  coverage-gap rubric line, `category: "test-coverage"`, never an "add tests"
  nag) and `{{CODE_HISTORY}}` (report item #20, a compact git-blame summary of
  how old/churny each changed region is, so pre-existing weaknesses read as
  pre-existing). Both blocks are "(none)"-safe, so v9 is a no-op when neither has
  data. **Current engine default** (used unless a flag below needs v10).
- `reviewer-v10.md` — the flagged counterpart to v9: v8's `{{FEWSHOT_EXEMPLARS}}`
  + `{{WALKTHROUGH_INSTRUCTION}}` blocks PLUS v9's `{{RELATED_TESTS}}` +
  `{{CODE_HISTORY}}`. Renders identically to v9 when both flag placeholders are
  inert. Superseded as the flagged variant by v11.
- `reviewer-v11.md` — the current flagged variant: adds `{{SINK_EVIDENCE}}` +
  the taint-reasoning instruction (report item #21, dangerous-sink pack) on top
  of v10's few-shot/walkthrough blocks and v9's related-tests/history blocks.
  Pre-flagged dangerous sinks are injected as EVIDENCE the model must reason
  about (source→sink reachability required before high/critical), never findings
  on their own. Renders identically to v9 when every flag placeholder is inert;
  the engine selects v11 only when `fewShotExemplars`, `walkthrough`, or
  `sinkPack` is on (`selectReviewerPrompt`). v10 was left untouched per the
  never-edit-shipped rule.
- `verifier-v1.md` — M4: adversarial verifier — keep/rewrite/drop per finding
  with cited `file:line` evidence and the closed drop-reason enum.
- `verifier-v2.md` — requires grounded `file:line` + verbatim-quote evidence on
  EVERY verdict (keep/rewrite too), checked deterministically by the engine
  (feature #1), and adds the `insufficient-context` abstention drop reason
  (feature #6). **Current engine default** (used unless `chainOfVerification`).
- `verifier-v3.md` — chain-of-verification (report item #13): the verifier must
  state + answer 1–2 falsifiable questions per finding (within its capped tool
  budget) BEFORE deciding a verdict. Output schema is UNCHANGED from v2 (the
  questions are optional transparency-only fields; grounded `evidence` is still
  required and still mechanically checked). Selected only when the
  `chainOfVerification` flag is on (which itself needs `verify` on). DEFAULT OFF
  — an uncertain precision lever pending live-eval measurement.
