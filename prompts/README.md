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
