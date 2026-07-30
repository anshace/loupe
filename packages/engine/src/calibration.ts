/**
 * Empirical calibration from run-log history (report item #29). PURE functions —
 * no IO, no clock — so they are unit-testable offline; run.ts wires them to the
 * run-log JSONL and the pipeline.
 *
 * The idea (research/features/quality-methods.md Method 5): Loupe already writes
 * a per-run JSONL log recording, per (category, severity) SHAPE, how many
 * findings the verifier historically KEPT vs DROPPED. Mine that history into a
 * keep-rate table and use it as a deterministic, zero-inference prior: a shape
 * whose keep-rate is persistently low over enough samples is pre-suppressed
 * BEFORE the LLM verifier even sees it. This is behavioral calibration (observed
 * outcome rates), deliberately NOT the LLM's self-reported confidence — the
 * research finds raw self-confidence is miscalibrated and truncated.
 *
 * Guardrails baked in here: nothing is ever silently dropped (pre-suppression
 * returns the removed findings tagged `low-keep-rate` for disclosure), and a
 * shape is trusted only once it has at least `minSamples` observations, so a
 * cold/short history suppresses nothing.
 */
import type { Finding, Severity, SuppressedFinding } from "./types";
import type { RunLogRecord } from "./runlog";

/** Stable "category|severity" key for a finding shape. Pure. */
export function shapeKey(category: string, severity: Severity): string {
  return `${category}|${severity}`;
}

/** Tally a finding list into a per-shape count map ("category|severity" → n). Pure. */
export function tallyShapes(findings: readonly Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) {
    const key = shapeKey(f.category, f.severity);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export interface ShapeKeepRate {
  /** Times the verifier kept a finding of this shape across the history. */
  kept: number;
  /** Times the verifier dropped a finding of this shape across the history. */
  dropped: number;
  /** kept + dropped. */
  total: number;
  /** kept / total in [0,1] (0 when total is 0). */
  keepRate: number;
}

export type KeepRateTable = Record<string, ShapeKeepRate>;

/**
 * Mine the run-log records' `verifierShapes` tallies into a per-shape keep-rate
 * table. Records without verifier-shape data are ignored. Pure.
 */
export function buildKeepRateTable(records: readonly RunLogRecord[]): KeepRateTable {
  const kept: Record<string, number> = {};
  const dropped: Record<string, number> = {};
  const keys = new Set<string>();
  for (const r of records) {
    const shapes = r.verifierShapes;
    if (!shapes) continue;
    for (const [key, n] of Object.entries(shapes.kept ?? {})) {
      if (typeof n === "number" && n > 0) {
        kept[key] = (kept[key] ?? 0) + n;
        keys.add(key);
      }
    }
    for (const [key, n] of Object.entries(shapes.dropped ?? {})) {
      if (typeof n === "number" && n > 0) {
        dropped[key] = (dropped[key] ?? 0) + n;
        keys.add(key);
      }
    }
  }
  const table: KeepRateTable = {};
  for (const key of keys) {
    const k = kept[key] ?? 0;
    const d = dropped[key] ?? 0;
    const total = k + d;
    table[key] = { kept: k, dropped: d, total, keepRate: total > 0 ? k / total : 0 };
  }
  return table;
}

export interface LowKeepRateOptions {
  /** Keep-rate at/under which a shape is considered persistently low. Default 0.2. */
  threshold?: number;
  /** Minimum total observations before a shape's rate is trusted. Default 5. */
  minSamples?: number;
}

export const DEFAULT_KEEP_RATE_THRESHOLD = 0.2;
export const DEFAULT_MIN_SAMPLES = 5;

/**
 * The set of shape keys with a persistently low keep-rate: observed at least
 * `minSamples` times AND kept at a rate ≤ `threshold`. A shape with too few
 * samples is never included (cold history suppresses nothing). Pure.
 */
export function lowKeepRateShapes(table: KeepRateTable, opts: LowKeepRateOptions = {}): Set<string> {
  const threshold = opts.threshold ?? DEFAULT_KEEP_RATE_THRESHOLD;
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  const low = new Set<string>();
  for (const [key, rate] of Object.entries(table)) {
    if (rate.total >= minSamples && rate.keepRate <= threshold) low.add(key);
  }
  return low;
}

export interface CalibrationSplit {
  /** Findings that survive the calibration prior — go on to the verifier/publish. */
  kept: Finding[];
  /** Findings pre-suppressed because their shape has a persistently low keep-rate. */
  suppressed: SuppressedFinding[];
}

/**
 * Split findings by the low-keep-rate shape set: any finding whose
 * "category|severity" is in `lowShapes` is pre-suppressed (reason
 * `low-keep-rate`); the rest are kept. Original order preserved within each
 * group. Pure — never mutates its inputs.
 */
export function preSuppressByCalibration(
  findings: readonly Finding[],
  lowShapes: ReadonlySet<string>,
): CalibrationSplit {
  const kept: Finding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const f of findings) {
    if (lowShapes.has(shapeKey(f.category, f.severity))) {
      suppressed.push({ finding: f, reason: "low-keep-rate" });
    } else {
      kept.push(f);
    }
  }
  return { kept, suppressed };
}
