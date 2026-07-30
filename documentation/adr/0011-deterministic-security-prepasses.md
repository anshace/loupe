# 0011. Deterministic security pre-passes, not LLM-driven

## Status

Accepted.

## Context

Two high-value security categories are exactly the kind of "boring" finding an
LLM reviewer skims past or, worse, hallucinates away: **leaked
secrets/credentials** in a diff, and **GitHub Actions supply-chain risks**
(unpinned action tags, `pull_request_target` + PR-head checkout, untrusted
`${{ github.event.* }}` interpolated into `run:`). These have crisp, mechanical
signatures. The obvious "real" tools — Semgrep, CodeQL, OpenGrep — would give
strong coverage, but each is an external OCaml/Python/compiled binary, which
collides head-on with the zero-runtime-dependency engine (ADR 0003).

## Decision

Run these checks as **deterministic code pre-passes, before the LLM call** — the
same spirit as the noise filter:

- `secrets.ts` — zero-dep regex + Shannon-entropy scan over the **added** diff
  lines (named formats for AWS/GitHub/Slack/Stripe/Google/PEM/JWT, plus a generic
  high-entropy-assignment detector), value redacted, with a per-repo allowlist. It
  emits `critical` findings that **skip the reviewer and verifier entirely**.
- `workflowcheck.ts` — pure regex/line analysis over changed
  `.github/workflows/*.yml`, scoped to the diff (fires on added lines / touched
  dangerous pairs, never on wholly pre-existing config).

Both feed the same deterministic publish path as every LLM finding.

## Consequences

**Positive**

- **~100% precision** on crisp signatures and **can't be hallucinated away** —
  the finding does not depend on the model noticing it (it never reaches the
  model), so a leaked key or a `pwn-request` workflow is caught reliably.
- Cheaper and faster: these findings skip the LLM round-trip entirely.
- **No external SAST binary** — stays within the zero-dep engine (ADR 0003) and
  runs identically on Node and the Workers edge runtime.

**Negative / trade-offs**

- Hand-rolled detectors cover far less than a real SAST engine — no dataflow, no
  taint analysis, and only the patterns explicitly encoded (dangerous-sink/taint
  coverage is a separate, deferred item).
- Regex/entropy detectors risk false positives (a posted comment is the cost), so
  they carry precision controls: named-format shapes, entropy + length + no-interp
  thresholds, `EXAMPLE`-value skips, and a `.aireview.toml` allowlist.

## Alternatives considered

- **Shell out to Semgrep CE / OpenGrep / CodeQL.** Rejected: requires an external
  OCaml/Python/compiled binary, breaking the zero-dep engine and the "runs
  anywhere including Workers" property. The hand-rolled sink pack + taint
  prompting is the recorded substitute for deeper coverage (research 10,
  out-of-scope).

See also: `research/10-feature-improvements.md` #2, #4, out-of-scope (SAST);
`packages/engine/src/secrets.ts`; `packages/engine/src/workflowcheck.ts`.
