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
export function parseJsonCandidates(raw: string): unknown {
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

/**
 * Carry a committable single-line replacement (feature #7). Unlike `firstString`
 * this PRESERVES the line's own leading indentation (a GitHub suggestion
 * replaces the whole line, so the indentation is part of the fix) and only
 * strips a trailing newline. A value that is empty, whitespace-only, or spans
 * more than one line is rejected — those can never be a clean same-line swap.
 */
function coerceSuggestedLine(obj: Record<string, unknown>): string | undefined {
  for (const key of ["suggestedLine", "suggested_line", "suggestion_line", "replacement", "replacementLine"]) {
    const v = obj[key];
    if (typeof v !== "string") continue;
    const line = v.replace(/\r?\n+$/, ""); // drop trailing newline(s) only
    if (line.trim().length === 0) continue; // empty / whitespace-only → not a fix
    if (/\r?\n/.test(line)) continue; // multi-line → not a single-line swap
    return line;
  }
  return undefined;
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
    suggestedLine: coerceSuggestedLine(obj),
  };
}

/** The guardrail entry point. Pure; never throws. */
export function parseModelFindings(raw: string): GuardrailResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { findings: [], degraded: true, droppedCount: 0 };
  }
  const parsed = parseJsonCandidates(raw);
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

/**
 * Agentic tool-call detection (task 6.3). Instead of a findings array, the
 * model MAY return `{"tool_calls": [...]}`. Same defensive posture as
 * findings parsing: tolerate wrapper-key and argument-key variants, drop
 * malformed entries, never throw.
 */
export interface ToolCallRequest {
  tool: "grep" | "read_file" | "find_importers";
  /** grep: the regex/substring to search for. */
  pattern?: string;
  /** grep: optional path prefix filter; read_file / find_importers: the file. */
  path?: string;
}

const TOOL_WRAPPER_KEYS = ["tool_calls", "toolCalls", "tools", "tool_requests"];

function coerceToolCall(entry: unknown): ToolCallRequest | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const obj = entry as Record<string, unknown>;
  const rawArgs = obj.args ?? obj.arguments ?? obj.input ?? obj.parameters;
  const args =
    rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : obj; // args may be flattened onto the entry itself

  const name = firstString(obj, ["tool", "name", "tool_name", "type"])
    ?.toLowerCase()
    .replace(/[-\s]/g, "_");
  if (name === "grep" || name === "search") {
    const pattern = firstString(args, ["pattern", "query", "regex", "q"]);
    if (!pattern) return undefined;
    return { tool: "grep", pattern, path: firstString(args, ["path", "dir", "prefix", "glob"]) };
  }
  if (name === "read_file" || name === "readfile" || name === "read" || name === "cat") {
    const path = firstString(args, ["path", "file", "filename", "file_path", "filePath"]);
    if (!path) return undefined;
    return { tool: "read_file", path };
  }
  if (
    name === "find_importers" ||
    name === "findimporters" ||
    name === "importers" ||
    name === "find_callers" ||
    name === "callers" ||
    name === "who_imports"
  ) {
    const path = firstString(args, ["path", "file", "filename", "file_path", "filePath", "module"]);
    if (!path) return undefined;
    return { tool: "find_importers", path };
  }
  return undefined;
}

/**
 * Returns the requested tool calls, or undefined when the output is not a
 * tool-call response at all (then try `parseModelFindings`). An empty array
 * means "the model wanted tools but every request was malformed" — the engine
 * responds by forcing a findings answer.
 */
export function parseToolCalls(raw: string): ToolCallRequest[] | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const parsed = parseJsonCandidates(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  for (const key of TOOL_WRAPPER_KEYS) {
    const arr = (parsed as Record<string, unknown>)[key];
    if (!Array.isArray(arr)) continue;
    const out: ToolCallRequest[] = [];
    for (const entry of arr) {
      const call = coerceToolCall(entry);
      if (call) out.push(call);
    }
    return out;
  }
  return undefined;
}
