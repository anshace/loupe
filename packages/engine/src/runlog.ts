/**
 * Run log (task 7.5): ONE structured JSONL record appended per completed run,
 * for self-analytics. Written via injectable IO (mirrors the cost ledger);
 * writes are best-effort and never crash a run.
 *
 * DETERMINISM: the engine core never reads the clock. The timestamp is
 * caller-stamped — run.ts fills it from the injectable `deps.now` (exactly
 * how the monthly cost ledger gets its month key), so tests inject a fixed
 * clock and the pure pipeline stays reproducible.
 */
import { appendFileSync, readFileSync } from "node:fs";

export interface RunLogRecord {
  /** PR state key, "owner/repo#number". */
  pr: string;
  /** ISO timestamp, stamped by the caller from the injected clock. */
  timestamp: string;
  /** Model that served the run; absent when nothing reached a model. */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  findingsKept: number;
  /** suppressed + deduped + verifier-dropped. */
  findingsDropped: number;
  /** Histogram of drop reasons (suppression reasons, "duplicate", "verifier:<reason>"). */
  dropReasons: Record<string, number>;
  verifierDropped: number;
  /** True when the run was escalated to the risky-path model. */
  escalated: boolean;
  /** True when the run reviewed an incremental before..after range. */
  incremental: boolean;
}

export interface RunLogIo {
  appendFile?: (path: string, line: string) => void;
  readFile?: (path: string) => string;
}

/** Append one record as a JSONL line. Best-effort — never throws. */
export function appendRunLog(path: string, record: RunLogRecord, io: RunLogIo = {}): void {
  const append = io.appendFile ?? ((p: string, line: string) => appendFileSync(p, line));
  try {
    append(path, JSON.stringify(record) + "\n");
  } catch {
    // Run-log writes are best-effort (e.g. read-only Action filesystem).
  }
}

/** Read all records, tolerating corrupt/foreign lines (skipped silently). */
export function readRunLog(path: string, io: RunLogIo = {}): RunLogRecord[] {
  const read = io.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let text: string;
  try {
    text = read(path);
  } catch {
    return [];
  }
  const out: RunLogRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as { pr?: unknown }).pr === "string") {
        out.push(parsed as RunLogRecord);
      }
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export interface RunLogSummary {
  runs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstCostUsd: number;
  findingsKept: number;
  findingsDropped: number;
  /** Merged drop-reason histogram across all runs. */
  dropReasons: Record<string, number>;
  verifierDropped: number;
  escalatedRuns: number;
  incrementalRuns: number;
  /** Run count per model. */
  byModel: Record<string, number>;
}

/** Tiny self-analytics rollup over run-log records. Pure. */
export function summarizeRunLog(records: readonly RunLogRecord[]): RunLogSummary {
  const summary: RunLogSummary = {
    runs: records.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstCostUsd: 0,
    findingsKept: 0,
    findingsDropped: 0,
    dropReasons: {},
    verifierDropped: 0,
    escalatedRuns: 0,
    incrementalRuns: 0,
    byModel: {},
  };
  for (const r of records) {
    summary.totalInputTokens += r.inputTokens || 0;
    summary.totalOutputTokens += r.outputTokens || 0;
    summary.totalEstCostUsd += r.estCostUsd || 0;
    summary.findingsKept += r.findingsKept || 0;
    summary.findingsDropped += r.findingsDropped || 0;
    summary.verifierDropped += r.verifierDropped || 0;
    if (r.escalated) summary.escalatedRuns += 1;
    if (r.incremental) summary.incrementalRuns += 1;
    if (r.model) summary.byModel[r.model] = (summary.byModel[r.model] ?? 0) + 1;
    for (const [reason, n] of Object.entries(r.dropReasons ?? {})) {
      if (typeof n === "number") summary.dropReasons[reason] = (summary.dropReasons[reason] ?? 0) + n;
    }
  }
  return summary;
}
