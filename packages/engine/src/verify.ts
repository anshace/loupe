/**
 * Verifier pass (task 6.4, design decision 9): a second LLM call re-reads
 * each finding against the actual code and must keep / rewrite / drop it.
 * Dropping REQUIRES a closed-enum reason AND cited `file:line` evidence —
 * otherwise the finding is kept (fail OPEN, per finding). Fully unparseable
 * verifier output also fails OPEN: original findings are published and the
 * summary notes degraded verification. Publishing bad findings is
 * recoverable; silently losing good ones is not.
 *
 * Config: `verify` is OFF by default — it stays off until the eval set
 * (task 6.8) proves the verifier kills ≥30% of raw findings correctly.
 */
import { parseJsonCandidates } from "./guardrail";
import type { DropReason, DroppedFinding, Finding } from "./types";

export const VERIFIER_PROMPT_FILE = "verifier-v1.md";

export const DROP_REASONS: readonly DropReason[] = [
  "false-claim",
  "pre-existing",
  "repo-convention",
  "out-of-scope",
  "theoretically-impossible",
];

export type VerifierVerdict = "keep" | "rewrite" | "drop";

export interface VerifierDecision {
  /** 1-based finding id, matching the numbering sent in the prompt. */
  id: number;
  verdict: VerifierVerdict;
  evidence?: string;
  reason?: DropReason;
  rewritten?: string;
}

const VERDICT_SYNONYMS: Record<string, VerifierVerdict> = {
  keep: "keep",
  accept: "keep",
  valid: "keep",
  confirmed: "keep",
  rewrite: "rewrite",
  revise: "rewrite",
  edit: "rewrite",
  drop: "drop",
  remove: "drop",
  reject: "drop",
  discard: "drop",
  invalid: "drop",
};

const DECISION_WRAPPER_KEYS = ["verdicts", "decisions", "findings", "results"];

function coerceId(obj: Record<string, unknown>): number | undefined {
  for (const key of ["id", "index", "finding_id", "findingId", "finding"]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
    if (typeof v === "string" && /^\d+$/.test(v.trim())) {
      const n = Number(v.trim());
      if (n >= 1) return n;
    }
  }
  return undefined;
}

function coerceString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function coerceReason(obj: Record<string, unknown>): DropReason | undefined {
  const raw = coerceString(obj, ["reason", "drop_reason", "dropReason", "why"]);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase().replace(/[\s_]+/g, "-");
  return (DROP_REASONS as readonly string[]).includes(normalized) ? (normalized as DropReason) : undefined;
}

function coerceDecision(entry: unknown): VerifierDecision | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const obj = entry as Record<string, unknown>;
  const id = coerceId(obj);
  if (id === undefined) return undefined;
  const rawVerdict = coerceString(obj, ["verdict", "decision", "action", "status"]);
  if (!rawVerdict) return undefined;
  const verdict = VERDICT_SYNONYMS[rawVerdict.toLowerCase()];
  if (!verdict) return undefined;
  return {
    id,
    verdict,
    evidence: coerceString(obj, ["evidence", "citation", "proof"]),
    reason: coerceReason(obj),
    rewritten: coerceString(obj, ["rewritten", "rewrite", "rewritten_body", "rewrittenBody", "new_body"]),
  };
}

/**
 * Defensive parse of the verifier output. Returns undefined when the output
 * cannot be read as a decision list at all — the caller then fails OPEN.
 */
export function parseVerifierOutput(raw: string): VerifierDecision[] | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const parsed = parseJsonCandidates(raw);
  let array: unknown[] | undefined;
  if (Array.isArray(parsed)) {
    array = parsed;
  } else if (parsed !== null && typeof parsed === "object") {
    for (const key of DECISION_WRAPPER_KEYS) {
      const v = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        array = v;
        break;
      }
    }
  }
  if (array === undefined) return undefined;

  const decisions: VerifierDecision[] = [];
  for (const entry of array) {
    const decision = coerceDecision(entry);
    if (decision) decisions.push(decision);
  }
  return decisions;
}

export interface VerificationOutcome {
  kept: Finding[];
  dropped: DroppedFinding[];
  rewrittenCount: number;
  /** True when the whole verdict list was unparseable → everything kept. */
  degraded: boolean;
}

/**
 * Apply verdicts to the findings (1-based ids matching prompt order). Pure.
 * Fail-open rules: no decision for a finding → keep; drop without a valid
 * reason AND evidence → keep; rewrite without rewritten text → keep as-is.
 */
export function applyVerdicts(
  findings: readonly Finding[],
  decisions: readonly VerifierDecision[] | undefined,
): VerificationOutcome {
  if (decisions === undefined) {
    return { kept: [...findings], dropped: [], rewrittenCount: 0, degraded: true };
  }
  const byId = new Map<number, VerifierDecision>();
  for (const d of decisions) if (!byId.has(d.id)) byId.set(d.id, d);

  const kept: Finding[] = [];
  const dropped: DroppedFinding[] = [];
  let rewrittenCount = 0;

  findings.forEach((finding, i) => {
    const decision = byId.get(i + 1);
    if (!decision || decision.verdict === "keep") {
      kept.push(finding);
      return;
    }
    if (decision.verdict === "rewrite") {
      if (decision.rewritten) {
        kept.push({ ...finding, body: decision.rewritten });
        rewrittenCount += 1;
      } else {
        kept.push(finding);
      }
      return;
    }
    // drop — only with a closed-enum reason AND cited evidence.
    if (decision.reason && decision.evidence) {
      dropped.push({ finding, reason: decision.reason, evidence: decision.evidence });
    } else {
      kept.push(finding);
    }
  });

  return { kept, dropped, rewrittenCount, degraded: false };
}

/** Render the numbered findings JSON sent to the verifier ({{FINDINGS}}). */
export function formatFindingsForVerifier(findings: readonly Finding[]): string {
  return JSON.stringify(
    findings.map((f, i) => ({ id: i + 1, ...f })),
    null,
    2,
  );
}
