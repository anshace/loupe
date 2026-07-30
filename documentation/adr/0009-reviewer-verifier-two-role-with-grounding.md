# 0009. Two-role reviewer + verifier with mandatory grounding

## Status

Accepted. (Verifier lands at M4; off by default until an eval set proves it kills
≥30% of raw findings correctly.)

## Context

The number-one reason AI reviewers get uninstalled is **noise** — false positives
and nitpicks. A single review pass optimizes for recall and inevitably over-flags:
pre-existing issues, repo conventions it does not know, and claims it cannot
actually substantiate. The highest-leverage known mechanism against this is an
adversarial second pass — but it must be held to real evidence, or it just
rubber-stamps.

## Decision

Use **two LLM roles**: a **reviewer** that finds issues, and a
**verifier/adversary** that must **keep / rewrite / drop** each finding
(`verify.ts`, `prompts/verifier-v2.md`). Guardrails on the verifier:

- **Grounding required on EVERY verdict** (keep and rewrite too, not only drop):
  each verdict must cite `file:line` + a verbatim quote.
- **Mechanical quote-check**: deterministic code confirms the cited quote
  actually appears in the payload sent to the model (`checkGrounding`). A
  fabricated citation on a `drop` is **demoted back to keep** — a hallucinated
  quote can never kill a genuine finding; keeps/rewrites with missing or
  fabricated evidence are kept but flagged.
- **Fail open, per finding**: a drop without a valid closed-enum reason AND
  evidence is kept; unparseable verifier output keeps everything and notes
  degraded verification. Publishing a bad finding is recoverable; silently losing
  a good one is not.
- **Insufficient-context abstention**: a distinct closed-enum reason for "noticed
  but could not ground it," logged separately from "no issue" (evidence optional
  for this reason only).

## Consequences

**Positive**

- The single biggest precision lever: the verifier removes false positives while
  the grounding requirement + quote-check stop it from removing *true* ones on a
  hallucinated basis.
- Fail-open design means the safety mechanism can never make the bot worse than
  reviewer-only (bad verifier output degrades to publishing the raw findings).
- The abstention category surfaces genuine "not enough context" cases instead of
  laundering them into confident keeps or drops.

**Negative / trade-offs**

- A second LLM call per PR (~2.2× cost from M4) — bounded by cost caps (ADR
  0004) and gated off until measured to help.
- The verifier adds real complexity (parsing, grounding, verdict application) and
  is only as good as its evidence discipline; the mechanical quote-check exists
  precisely because the model's self-grounding cannot be trusted on its own.

## Alternatives considered

- **Single pass.** Rejected: no false-positive control, which is the primary
  quality failure mode.
- **Multi-model adversarial debate (Magpie-style).** Rejected: 10+ LLM calls per
  PR for marginal gain at this scale, and a permanent multi-vendor bill against
  the free-tier ethos (research 10, out-of-scope). Its one good idea — "a keep
  needs positive evidence" — is captured by the grounding-on-every-verdict rule.

See also: `design.md` decision 9; `research/08` §1, §6;
`research/10-feature-improvements.md` #1, #6; `packages/engine/src/verify.ts`.
