/**
 * Defensive JSON guardrail (design decision 8: LLM proposes, code disposes).
 *
 * Pure function. NEVER throws. Tolerates markdown fences, a top-level array
 * or `{findings: [...]}` wrapper, and alternate key names. Individually
 * malformed findings are dropped; valid ones are kept. Fully unparseable
 * output degrades to `{findings: [], degraded: true}` so the pipeline emits
 * a summary-only review.
 */
import type { Finding, Severity } from "./types";

export interface GuardrailResult {
  findings: Finding[];
  /** True when the output could not be parsed as a findings list at all. */
  degraded: boolean;
  /** Individually malformed entries dropped from an otherwise-valid list. */
  droppedCount: number;
}

const SEVERITY_SYNONYMS: Record<string, Severity> = {
  critical: "critical",
  blocker: "critical",
  fatal: "critical",
  high: "high",
  major: "high",
  severe: "high",
  error: "high",
  medium: "medium",
  moderate: "medium",
  warning: "medium",
  warn: "medium",
  low: "low",
  minor: "low",
  info: "low",
  informational: "low",
  nit: "nit",
  nitpick: "nit",
  trivial: "nit",
  style: "nit",
};

const ARRAY_WRAPPER_KEYS = ["findings", "issues", "results", "comments"];

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parse candidates in order: as-is, fence-stripped, first bracketed slice. */
function parseCandidates(raw: string): unknown {
  const stripped = stripFences(raw);
  for (const candidate of [raw.trim(), stripped]) {
    const parsed = tryParse(candidate);
    if (parsed !== undefined) return parsed;
  }
  for (const [open, close] of [
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    const start = stripped.indexOf(open);
    const end = stripped.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const parsed = tryParse(stripped.slice(start, end + 1));
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function extractArray(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === "object") {
    for (const key of ARRAY_WRAPPER_KEYS) {
      const v = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v;
    }
    // A single finding object emitted bare.
    if ("severity" in parsed || "file" in parsed || "path" in parsed) return [parsed];
  }
  return undefined;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function coerceLine(obj: Record<string, unknown>): number | undefined {
  for (const key of ["line", "line_number", "lineNumber", "start_line", "startLine"]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
    if (typeof v === "string" && /^\d+$/.test(v.trim())) {
      const n = Number(v.trim());
      if (n >= 1) return n;
    }
  }
  return undefined;
}

function coerceSeverity(obj: Record<string, unknown>): Severity | undefined {
  const raw = firstString(obj, ["severity", "level", "priority"]);
  if (!raw) return undefined;
  return SEVERITY_SYNONYMS[raw.toLowerCase()];
}

/** Normalize one raw entry to a Finding, or undefined if it is unsalvageable. */
function coerceFinding(entry: unknown): Finding | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const obj = entry as Record<string, unknown>;

  const severity = coerceSeverity(obj);
  if (!severity) return undefined; // unknown severity word → drop, never rewrite

  const file = firstString(obj, ["file", "path", "filename", "file_path", "filePath"]);
  if (!file) return undefined;

  const title = firstString(obj, ["title", "summary", "heading"]);
  const body = firstString(obj, ["body", "description", "message", "detail", "details"]);
  if (!title && !body) return undefined;

  return {
    severity,
    category: firstString(obj, ["category", "type", "kind"]) ?? "other",
    file,
    line: coerceLine(obj),
    title: title ?? (body as string).slice(0, 80),
    body: body ?? (title as string),
    suggestion: firstString(obj, ["suggestion", "fix", "recommendation", "suggested_fix"]),
  };
}

/** The guardrail entry point. Pure; never throws. */
export function parseModelFindings(raw: string): GuardrailResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { findings: [], degraded: true, droppedCount: 0 };
  }
  const parsed = parseCandidates(raw);
  const array = extractArray(parsed);
  if (array === undefined) {
    return { findings: [], degraded: true, droppedCount: 0 };
  }

  const findings: Finding[] = [];
  let droppedCount = 0;
  for (const entry of array) {
    const finding = coerceFinding(entry);
    if (finding) findings.push(finding);
    else droppedCount += 1;
  }
  return { findings, degraded: false, droppedCount };
}
