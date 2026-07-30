# 0008. LLM proposes, deterministic code disposes

## Status

Accepted.

## Context

Loupe processes attacker-reachable text — the diff, the PR description, and PR
comments can all carry prompt-injection payloads. If the model held write
credentials, or drove GitHub mutations through tools, a successful injection
could turn the reviewer into a writer (post arbitrary comments, or worse). The
model's output is also inherently unreliable — malformed JSON, invented line
numbers, wrong keys — and a pipeline that trusts it can crash or post nonsense.

## Decision

The model **only ever emits structured JSON findings**. Everything else is done
by **deterministic code**:

- A defensive guardrail parses the JSON (alternate key names, bare lists,
  per-finding failure isolation, line clamping) and **never crashes** on bad
  output (`guardrail.ts`, `clamp.ts`).
- Deterministic code does all scoring, confidence filtering, dedup, line-mapping,
  summary formatting, and **every GitHub mutation** (`publish.ts`, `dedupe.ts`,
  `summary.ts`).
- **The model never holds write credentials.** The auth token lives only in the
  adapter/posting layer, never in the model call.

## Consequences

**Positive**

- The prompt-injection blast radius is structurally capped: the worst a
  compromised model output can do is propose a bad finding, which the guardrail
  and deterministic scoring can reject — it cannot itself write to GitHub.
- Bad model output degrades gracefully (dropped/clamped findings) instead of
  crashing the run — a hard requirement for an unattended bot.
- Scoring, dedup, and anchoring are deterministic and testable, independent of
  model nondeterminism.

**Negative / trade-offs**

- The engine must own more logic that a tool-calling agent would delegate to the
  model (parsing quirks, line clamping, fallback anchoring) — more code to write
  and maintain.
- The model cannot self-correct a mis-anchored comment by re-calling a tool; the
  deterministic fallback chain (exact line → nearest diff line → file-level →
  summary) handles that instead.

## Alternatives considered

- **Model with write access / tool-driven posting.** Rejected: hands the
  injection surface exactly the capability (write access) that makes an injection
  dangerous, and couples correctness to the model reliably calling the right tool
  with the right arguments. The proposes/disposes split is the single structural
  security decision that also happens to make the pipeline crash-proof.

See also: `design.md` decision 8, Risks (prompt injection);
`research/08-synthesis-architecture-and-milestones.md` §1.
