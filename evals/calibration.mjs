#!/usr/bin/env node
/**
 * Calibration metrics for the eval tooling (report item #30). PURE functions
 * only (no IO, no clock) so they are unit-testable offline; `run.mjs` wires the
 * kappa check into the A/B mode.
 *
 * Three standard metrics from the 2026 LLM-calibration literature
 * (research/features/eval-measurement.md §E):
 *   - brierScore — a strictly-proper scoring rule for probabilistic confidence
 *     vs a binary outcome (no binning). Lower is better; 0 = perfect.
 *   - expectedCalibrationError (ECE) — binned |accuracy − confidence| gap; the
 *     standard "does 'I am 0.8 sure' actually mean right 80% of the time".
 *   - cohensKappa — chance-corrected agreement between two labelings (a model or
 *     prompt SWAP), the cheap "did the reviewer quietly become a different
 *     reviewer" drift signal that raw precision/recall can miss.
 *
 * These score the OPTIONAL verifier `confidence` field (captured in the run log
 * by the engine) against real accept/reject outcomes, and score a model/prompt
 * swap's categorical outputs (kept/dropped, severity) against each other. The
 * verifier confidence is emitted only when a verifier prompt asks for it, so
 * Brier/ECE run over whatever confidence+outcome pairs the caller has collected;
 * kappa runs over any two aligned label arrays.
 */

function round(n, dp = 4) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Brier score over `[{ confidence, correct }]` pairs. `confidence` is a
 * probability in [0,1]; `correct` is a boolean outcome. Returns the mean squared
 * error between confidence and the 0/1 outcome (0 = perfect, 0.25 = a constant
 * 0.5 guess, 1 = confidently wrong every time). Returns null for an empty set.
 * Pure.
 */
export function brierScore(pairs) {
  const usable = (pairs ?? []).filter((p) => typeof p?.confidence === "number");
  if (usable.length === 0) return null;
  let sum = 0;
  for (const p of usable) {
    const c = Math.max(0, Math.min(1, p.confidence));
    const o = p.correct ? 1 : 0;
    sum += (c - o) ** 2;
  }
  return round(sum / usable.length);
}

/**
 * Expected Calibration Error over `[{ confidence, correct }]` pairs, using
 * `bins` equal-width confidence bins in [0,1]. ECE = Σ (|bin| / N) · |acc − conf|
 * over non-empty bins. Returns { ece, bins: [...] } with per-bin detail, or null
 * for an empty set. Pure.
 */
export function expectedCalibrationError(pairs, bins = 10) {
  const usable = (pairs ?? []).filter((p) => typeof p?.confidence === "number");
  const n = usable.length;
  if (n === 0) return null;
  const buckets = Array.from({ length: bins }, () => ({ count: 0, confSum: 0, correct: 0 }));
  for (const p of usable) {
    const c = Math.max(0, Math.min(1, p.confidence));
    // c === 1 lands in the last bin, not a phantom bins+1th one.
    const idx = Math.min(bins - 1, Math.floor(c * bins));
    const b = buckets[idx];
    b.count += 1;
    b.confSum += c;
    b.correct += p.correct ? 1 : 0;
  }
  let ece = 0;
  const detail = [];
  buckets.forEach((b, i) => {
    if (b.count === 0) return;
    const acc = b.correct / b.count;
    const conf = b.confSum / b.count;
    ece += (b.count / n) * Math.abs(acc - conf);
    detail.push({ bin: i, lo: round(i / bins, 2), hi: round((i + 1) / bins, 2), count: b.count, acc: round(acc), conf: round(conf) });
  });
  return { ece: round(ece), bins: detail };
}

/**
 * Cohen's kappa over two ALIGNED categorical label arrays (paired: labelsA[i]
 * and labelsB[i] describe the same item). Corrects observed agreement for
 * chance agreement from the marginal label distributions:
 *   kappa = (po − pe) / (1 − pe)
 * Returns { kappa, po, pe, n } or null when the arrays are empty or unequal
 * length. Edge case: when pe === 1 (both raters used a single, identical label)
 * kappa is defined as 1 if they fully agree, else 0. Pure.
 */
export function cohensKappa(labelsA, labelsB) {
  if (!Array.isArray(labelsA) || !Array.isArray(labelsB)) return null;
  const n = labelsA.length;
  if (n === 0 || n !== labelsB.length) return null;

  let agree = 0;
  const marginA = new Map();
  const marginB = new Map();
  for (let i = 0; i < n; i++) {
    const a = String(labelsA[i]);
    const b = String(labelsB[i]);
    if (a === b) agree += 1;
    marginA.set(a, (marginA.get(a) ?? 0) + 1);
    marginB.set(b, (marginB.get(b) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  const labels = new Set([...marginA.keys(), ...marginB.keys()]);
  for (const label of labels) {
    pe += ((marginA.get(label) ?? 0) / n) * ((marginB.get(label) ?? 0) / n);
  }
  let kappa;
  if (pe >= 1) kappa = po >= 1 ? 1 : 0;
  else kappa = (po - pe) / (1 - pe);
  return { kappa: round(kappa), po: round(po), pe: round(pe), n };
}

/**
 * Interpret a kappa value with the conventional Landis–Koch labels. Pure.
 * (< 0 poor, 0–.2 slight, .2–.4 fair, .4–.6 moderate, .6–.8 substantial,
 *  .8–1 almost-perfect.)
 */
export function kappaLabel(kappa) {
  if (kappa < 0) return "poor";
  if (kappa < 0.2) return "slight";
  if (kappa < 0.4) return "fair";
  if (kappa < 0.6) return "moderate";
  if (kappa < 0.8) return "substantial";
  return "almost-perfect";
}
