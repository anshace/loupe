/**
 * Bounded reflection — a "verifier-of-verifier" pass (report item #27).
 *
 * After the normal verifier pass, run ONE more short critique — but only over
 * the findings the verifier marked `keep` at critical/high severity (typically a
 * small set) — asking a differently-framed question: does the verifier's own
 * cited evidence actually ESTABLISH the claim? Multi-Agent-Reflexion research
 * shows a second, differently-framed critique round catches errors the first
 * round's framing was blind to; the documented risk is over-correction and cost,
 * which is why this is scoped to the already-small critical/high `keep` set and
 * bounded to the per-run cost cap.
 *
 * HARD RULE (guardrail): a failed reflection NEVER silently drops a finding — it
 * DEMOTES it one severity and records the demotion for disclosure. Publishing a
 * slightly-over-severe finding is recoverable; losing a real critical one is not.
 *
 * PURE functions only (parse / select / apply); run.ts wires the single model
 * call and the cost cap. Flag-gated (`reflection`), default OFF.
 */
import { parseJsonCandidates } from "./guardrail";
import type { Finding, ReflectionDemotion, ReflectionRecord, Severity } from "./types";
import type { VerifierDecision } from "./verify";

export const REFLECTION_PROMPT_FILE = "verifier-meta-v1.md";

/** A critical/high `keep` finding plus the verifier evidence to be critiqued. */
export interface ReflectionCandidate {
  /** The kept finding (same reference the verifier kept, so it matches downstream). */
  finding: Finding;
  /** The verifier's cited evidence for keeping it, if any. */
  evidence?: string;
}

/** One parsed meta-verdict from the reflection model. */
export interface ReflectionVerdict {
  /** 1-based index over the candidate list sent to the model. */
  id: number;
  /** True when the meta-reviewer agrees the evidence establishes the claim. */
  upholds: boolean;
  /** Short reason when it does not uphold. */
  note?: string;
}

const REFLECTION_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(["critical", "high"]);

/** One-step severity demotion for a failed reflection. Pure. */
export function demoteSeverity(severity: Severity): Severity {
  if (severity === "critical") return "high";
  if (severity === "high") return "medium";
  if (severity === "medium") return "low";
  return "nit";
}

/**
 * Collect the reflection candidates: findings the verifier `keep`-verdicted at
 * critical/high severity, paired with the verifier's evidence. Built from the
 * ORIGINAL findings + decisions (1-based ids match prompt order), so each
 * `candidate.finding` is the SAME reference applyVerdicts kept for a `keep`
 * verdict — letting `applyReflection` match by reference. Pure.
 */
export function collectReflectionCandidates(
  findings: readonly Finding[],
  decisions: readonly VerifierDecision[] | undefined,
): ReflectionCandidate[] {
  if (!decisions) return [];
  const byId = new Map<number, VerifierDecision>();
  for (const d of decisions) if (!byId.has(d.id)) byId.set(d.id, d);
  const candidates: ReflectionCandidate[] = [];
  findings.forEach((finding, i) => {
    const decision = byId.get(i + 1);
    if (decision && decision.verdict === "keep" && REFLECTION_SEVERITIES.has(finding.severity)) {
      candidates.push({ finding, evidence: decision.evidence });
    }
  });
  return candidates;
}

/** Render the numbered candidate list sent to the meta-reviewer ({{CANDIDATES}}). */
export function formatReflectionCandidates(candidates: readonly ReflectionCandidate[]): string {
  return JSON.stringify(
    candidates.map((c, i) => ({
      id: i + 1,
      severity: c.finding.severity,
      file: c.finding.file,
      line: c.finding.line,
      claim: [c.finding.title, c.finding.body].filter(Boolean).join(" — "),
      verifier_evidence: c.evidence ?? "(none supplied)",
    })),
    null,
    2,
  );
}

const UPHOLD_WORDS = new Set(["uphold", "upheld", "keep", "yes", "true", "established", "valid", "agree", "confirmed"]);
const REJECT_WORDS = new Set(["reject", "demote", "no", "false", "unestablished", "not-established", "overturn", "fail", "failed"]);

function coerceUpholds(obj: Record<string, unknown>): boolean | undefined {
  // Explicit boolean first.
  for (const key of ["upholds", "uphold", "established", "establishes", "agree"]) {
    const v = obj[key];
    if (typeof v === "boolean") return v;
  }
  // Then a verdict word.
  for (const key of ["verdict", "decision", "meta_verdict", "result", "judgment"]) {
    const v = obj[key];
    if (typeof v === "string") {
      const w = v.trim().toLowerCase().replace(/[\s_]+/g, "-");
      if (UPHOLD_WORDS.has(w)) return true;
      if (REJECT_WORDS.has(w)) return false;
    }
  }
  return undefined;
}

function coerceMetaId(obj: Record<string, unknown>): number | undefined {
  for (const key of ["id", "index", "candidate", "candidate_id"]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
    if (typeof v === "string" && /^\d+$/.test(v.trim())) {
      const n = Number(v.trim());
      if (n >= 1) return n;
    }
  }
  return undefined;
}

function coerceNote(obj: Record<string, unknown>): string | undefined {
  for (const key of ["note", "reason", "why", "critique", "explanation"]) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

const META_WRAPPER_KEYS = ["verdicts", "reflections", "results", "critiques", "findings"];

/**
 * Defensive parse of the meta-reviewer output into a verdict list. Returns
 * undefined when it cannot be read at all (caller then upholds everything —
 * fail-open, never demoting on a parse failure). Pure; never throws.
 */
export function parseReflectionOutput(raw: string): ReflectionVerdict[] | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const parsed = parseJsonCandidates(raw);
  let array: unknown[] | undefined;
  if (Array.isArray(parsed)) {
    array = parsed;
  } else if (parsed !== null && typeof parsed === "object") {
    for (const key of META_WRAPPER_KEYS) {
      const v = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        array = v;
        break;
      }
    }
  }
  if (array === undefined) return undefined;

  const verdicts: ReflectionVerdict[] = [];
  for (const entry of array) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const id = coerceMetaId(obj);
    const upholds = coerceUpholds(obj);
    if (id === undefined || upholds === undefined) continue;
    verdicts.push({ id, upholds, note: coerceNote(obj) });
  }
  return verdicts;
}

/**
 * Apply the meta-verdicts to the kept findings. A candidate the meta-reviewer
 * did NOT uphold is demoted one severity (never dropped); the finding is matched
 * by reference (candidates carry the same object the verifier kept). Fail-open:
 * an unparseable verdict list (`decisions` undefined) demotes nothing. Pure —
 * returns a new findings array; never mutates its inputs.
 */
export function applyReflection(
  kept: readonly Finding[],
  candidates: readonly ReflectionCandidate[],
  verdicts: readonly ReflectionVerdict[] | undefined,
): { findings: Finding[]; record: ReflectionRecord } {
  const record: ReflectionRecord = { reviewed: candidates.length, demotions: [], skippedForCost: false };
  if (!verdicts || verdicts.length === 0) {
    return { findings: [...kept], record };
  }
  // Map each failed candidate's finding reference → the meta note.
  const demoteNote = new Map<Finding, string | undefined>();
  for (const v of verdicts) {
    if (v.upholds) continue;
    const candidate = candidates[v.id - 1];
    if (candidate && !demoteNote.has(candidate.finding)) demoteNote.set(candidate.finding, v.note);
  }
  if (demoteNote.size === 0) return { findings: [...kept], record };

  const findings = kept.map((f) => {
    if (!demoteNote.has(f)) return f;
    const to = demoteSeverity(f.severity);
    const demotion: ReflectionDemotion = { finding: { ...f, severity: to }, from: f.severity, to, note: demoteNote.get(f) };
    record.demotions.push(demotion);
    return demotion.finding;
  });
  return { findings, record };
}
