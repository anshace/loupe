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
import type { DropReason, DroppedFinding, Finding, UngroundedVerdict } from "./types";

export const VERIFIER_PROMPT_FILE = "verifier-v2.md";

/**
 * Chain-of-verification verifier prompt (report item #13): requires the verifier
 * to state + answer 1–2 falsifiable questions before each verdict. Same output
 * schema as v2 (the optional questions are prose the parser ignores), so no
 * parsing change is needed. Selected only when `chainOfVerification` is on.
 */
export const VERIFIER_COVE_PROMPT_FILE = "verifier-v3.md";

/** Pick the verifier prompt file for this run (report item #13). Pure. */
export function selectVerifierPrompt(chainOfVerification?: boolean): string {
  return chainOfVerification ? VERIFIER_COVE_PROMPT_FILE : VERIFIER_PROMPT_FILE;
}

export const DROP_REASONS: readonly DropReason[] = [
  "false-claim",
  "pre-existing",
  "repo-convention",
  "out-of-scope",
  "theoretically-impossible",
  "insufficient-context",
];

/** The verifier abstention reason (feature #6) — evidence is not required for it. */
export const ABSTAIN_REASON: DropReason = "insufficient-context";

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

// ── Deterministic quote grounding (feature #1) ──────────────────────────────
//
// The verifier is asked to cite `file:line — <verbatim quote>` on EVERY verdict.
// These pure functions mechanically confirm the quote actually appears in the
// diff/context payload that was sent to the model — no extra LLM call. A quote
// that appears NOWHERE in that payload is a fabricated citation; we do not trust
// it. Consequence differs by verdict (see applyVerdicts) but is never a silent
// drop: keeps stay kept but flagged; a drop with a fabricated quote is demoted
// back to a keep so a real finding is never killed by a hallucinated citation.

export interface ParsedCitation {
  file?: string;
  line?: number;
  /** The verbatim code excerpt the model claims to have seen, if any. */
  quote?: string;
}

const CITATION_RE = /([A-Za-z0-9_./+-]+\.[A-Za-z0-9]+):(\d+)/;

/** Split an evidence string into `{ file, line, quote }`. Pure. */
export function parseCitation(evidence: string): ParsedCitation {
  const match = CITATION_RE.exec(evidence);
  if (!match) {
    const quote = evidence.trim();
    return { quote: quote.length > 0 ? quote : undefined };
  }
  const after = evidence
    .slice(match.index + match[0].length)
    .replace(/^[\s:—–-]+/, "")
    .trim();
  return { file: match[1], line: Number(match[2]), quote: after.length > 0 ? after : undefined };
}

/** New-side line contents of the payload, keyed by file, plus the context blob. */
export interface GroundingSource {
  byFile: Record<string, Array<{ line: number; content: string }>>;
  /** Full text of the enclosing-scope context sent to the model, if any. */
  contextText: string;
}

export interface GroundingFileLines {
  path: string;
  lines: ReadonlyArray<{ line: number; content: string }>;
}

/** Build a GroundingSource from the diff line contents + context text. Pure. */
export function buildGroundingSource(
  files: readonly GroundingFileLines[],
  contextText = "",
): GroundingSource {
  const byFile: Record<string, Array<{ line: number; content: string }>> = {};
  for (const f of files) {
    (byFile[f.path] ??= []).push(...f.lines.map((l) => ({ line: l.line, content: l.content })));
  }
  return { byFile, contextText };
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Strip wrapping quotes/backticks the model may put around the excerpt. */
function stripDelims(s: string): string {
  return s.replace(/^[`'"]+/, "").replace(/[`'"]+$/, "").trim();
}

function fileLines(source: GroundingSource, file: string): Array<{ line: number; content: string }> | undefined {
  if (source.byFile[file]) return source.byFile[file];
  // Loose match by basename — models sometimes cite a shortened path.
  const base = file.slice(file.lastIndexOf("/") + 1);
  for (const [path, lines] of Object.entries(source.byFile)) {
    if (path.slice(path.lastIndexOf("/") + 1) === base) return lines;
  }
  return undefined;
}

export type GroundingStatus =
  /** Quote found at/near the cited location, or anywhere in the payload. */
  | "grounded"
  /** No verifiable verbatim quote to check (e.g. only a file:line, or too short). */
  | "no-citation"
  /** A quote WAS given but appears nowhere in the payload → fabricated. */
  | "quote-not-found";

const MIN_QUOTE_LEN = 4;
const DEFAULT_WINDOW = 3;

/**
 * Mechanically check whether an evidence string's quote appears in the payload
 * sent to the model. Prefers a match within ±window lines of the cited
 * file:line, then anywhere in that file, then anywhere in the whole payload
 * (a lenient fallback that keeps the FLAG's own precision high — we only report
 * "quote-not-found" when the excerpt is genuinely absent). Pure.
 */
export function checkGrounding(
  evidence: string,
  source: GroundingSource,
  window: number = DEFAULT_WINDOW,
): GroundingStatus {
  const cit = parseCitation(evidence);
  const quote = cit.quote ? normalize(stripDelims(cit.quote)) : undefined;
  if (!quote || quote.length < MIN_QUOTE_LEN) return "no-citation";

  if (cit.file && cit.line !== undefined) {
    const lines = fileLines(source, cit.file);
    if (lines) {
      const near = lines
        .filter((l) => Math.abs(l.line - (cit.line as number)) <= window)
        .map((l) => l.content)
        .join(" ");
      if (normalize(near).includes(quote)) return "grounded";
      const whole = lines.map((l) => l.content).join(" ");
      if (normalize(whole).includes(quote)) return "grounded";
    }
  }

  const haystack = normalize(
    [...Object.values(source.byFile).flatMap((ls) => ls.map((l) => l.content)), source.contextText].join(" "),
  );
  return haystack.includes(quote) ? "grounded" : "quote-not-found";
}

export interface VerificationOutcome {
  kept: Finding[];
  dropped: DroppedFinding[];
  rewrittenCount: number;
  /** Verdicts whose cited evidence could not be grounded (feature #1). */
  ungrounded: UngroundedVerdict[];
  /** True when the whole verdict list was unparseable → everything kept. */
  degraded: boolean;
}

/**
 * Apply verdicts to the findings (1-based ids matching prompt order). Pure.
 *
 * Fail-open rules: no decision for a finding → keep; drop without a valid
 * reason AND evidence → keep; rewrite without rewritten text → keep as-is.
 *
 * Grounding (feature #1): the verifier must cite evidence on EVERY verdict.
 * When `source` is supplied, the cited quote is mechanically checked:
 *   - keep / rewrite with missing or fabricated evidence → still KEPT, but
 *     flagged in `ungrounded` (the verifier's rubber stamp isn't trusted).
 *   - drop (a real false-positive reason) with a FABRICATED quote → demoted
 *     back to a keep and flagged, so a hallucinated citation can never kill a
 *     genuine finding.
 * Abstention (feature #6): a drop whose reason is `insufficient-context` is the
 * verifier saying "noticed but could not ground it" — recorded distinctly in
 * `dropped` (evidence optional, no grounding requirement).
 */
export function applyVerdicts(
  findings: readonly Finding[],
  decisions: readonly VerifierDecision[] | undefined,
  source?: GroundingSource,
): VerificationOutcome {
  if (decisions === undefined) {
    return { kept: [...findings], dropped: [], rewrittenCount: 0, ungrounded: [], degraded: true };
  }
  const byId = new Map<number, VerifierDecision>();
  for (const d of decisions) if (!byId.has(d.id)) byId.set(d.id, d);

  const kept: Finding[] = [];
  const dropped: DroppedFinding[] = [];
  const ungrounded: UngroundedVerdict[] = [];
  let rewrittenCount = 0;

  // Flag a kept verdict (keep/rewrite) when its evidence is missing or fabricated.
  const flagKept = (finding: Finding, decision: VerifierDecision, verdict: "keep" | "rewrite"): void => {
    if (!decision.evidence) {
      ungrounded.push({ finding, verdict, reason: "missing-evidence" });
      return;
    }
    if (source && checkGrounding(decision.evidence, source) === "quote-not-found") {
      ungrounded.push({ finding, verdict, reason: "quote-not-found" });
    }
  };

  findings.forEach((finding, i) => {
    const decision = byId.get(i + 1);
    if (!decision || decision.verdict === "keep") {
      if (decision) flagKept(finding, decision, "keep");
      kept.push(finding);
      return;
    }
    if (decision.verdict === "rewrite") {
      const rewritten = decision.rewritten ? { ...finding, body: decision.rewritten } : finding;
      if (decision.rewritten) rewrittenCount += 1;
      flagKept(rewritten, decision, "rewrite");
      kept.push(rewritten);
      return;
    }
    // drop
    if (decision.reason === ABSTAIN_REASON) {
      // Abstention: kept out of the published set but logged distinctly. Evidence
      // is optional here — the whole point is the model could NOT ground it.
      dropped.push({
        finding,
        reason: ABSTAIN_REASON,
        evidence: decision.evidence ?? "(abstained — could not ground the claim in the diff/context)",
      });
      return;
    }
    // A genuine false-positive drop needs a closed-enum reason AND evidence...
    if (decision.reason && decision.evidence) {
      // ...and the quote must not be fabricated — a hallucinated citation must
      // never be allowed to kill a real finding.
      if (source && checkGrounding(decision.evidence, source) === "quote-not-found") {
        ungrounded.push({ finding, verdict: "drop", reason: "quote-not-found" });
        kept.push(finding);
      } else {
        dropped.push({ finding, reason: decision.reason, evidence: decision.evidence });
      }
    } else {
      kept.push(finding);
    }
  });

  return { kept, dropped, rewrittenCount, ungrounded, degraded: false };
}

/** Render the numbered findings JSON sent to the verifier ({{FINDINGS}}). */
export function formatFindingsForVerifier(findings: readonly Finding[]): string {
  return JSON.stringify(
    findings.map((f, i) => ({ id: i + 1, ...f })),
    null,
    2,
  );
}
