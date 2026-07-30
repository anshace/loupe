#!/usr/bin/env node
/**
 * A/B + regression eval harness helpers (report item #24). PURE functions only
 * (no IO, no clock) so they are unit-testable offline; `run.mjs` wires them to
 * the corpus and the filesystem.
 *
 * Provides:
 *   - caseSuccess / comparePaired — per-case binary outcome + A-vs-B deltas
 *   - mcnemar                     — paired significance test for the A/B mode
 *   - snapshotCase / diffSnapshots — golden full-output diff (--snapshot mode)
 *
 * Statistical caution (from research/features/eval-measurement.md §C.1): with a
 * ~22-case corpus a paired test catches only CATASTROPHIC regressions; treat the
 * significance flag as a smoke alarm, not proof. Always run the A/A self-test
 * first — a "significant" difference between a config and itself means the
 * harness is broken, not the prompt.
 */

/**
 * Per-case binary outcome used for paired testing: did the run fully satisfy the
 * case (every expected finding caught, and — for a clean case — nothing emitted).
 */
export function caseSuccess(row) {
  if (!row) return false;
  if (row.cleanViolated) return false;
  return (row.expectedMissed ?? 0) === 0;
}

/**
 * Pair rows from two configs by case name and compute per-case deltas (B minus
 * A). Rows present in only one side are still reported (the other side's counts
 * read as 0 / success=false). Deterministic order (sorted by name). Pure.
 */
export function comparePaired(rowsA, rowsB) {
  const byNameA = new Map(rowsA.map((r) => [r.name, r]));
  const byNameB = new Map(rowsB.map((r) => [r.name, r]));
  const names = [...new Set([...byNameA.keys(), ...byNameB.keys()])].sort();
  const pairs = [];
  for (const name of names) {
    const a = byNameA.get(name);
    const b = byNameB.get(name);
    const sa = caseSuccess(a);
    const sb = caseSuccess(b);
    pairs.push({
      name,
      successA: sa,
      successB: sb,
      foundDelta: (b?.expectedFound ?? 0) - (a?.expectedFound ?? 0),
      missedDelta: (b?.expectedMissed ?? 0) - (a?.expectedMissed ?? 0),
      unexpectedDelta: (b?.unexpected ?? 0) - (a?.unexpected ?? 0),
      // regressed = A passed but B failed; improved = B passed but A failed
      regressed: sa && !sb,
      improved: !sa && sb,
    });
  }
  return pairs;
}

/**
 * McNemar's test over paired binary outcomes. `pairs` is any array of objects
 * with boolean `successA` / `successB`. Returns the discordant counts and a
 * continuity-corrected chi-square (df=1); `significant` uses the α=0.05 critical
 * value 3.841. When the discordant total is small the test is underpowered —
 * `underpowered` flags b+c < 10 so callers don't over-trust it. Pure.
 */
export function mcnemar(pairs) {
  let b = 0; // A success, B failure
  let c = 0; // A failure, B success
  for (const p of pairs) {
    if (p.successA && !p.successB) b += 1;
    else if (!p.successA && p.successB) c += 1;
  }
  const discordant = b + c;
  const statistic = discordant === 0 ? 0 : Math.pow(Math.abs(b - c) - 1, 2) / discordant;
  return {
    aOnly: b,
    bOnly: c,
    discordant,
    statistic: Math.round(statistic * 1000) / 1000,
    significant: statistic > 3.841,
    underpowered: discordant < 10,
  };
}

/** Stable identity fields of a finding for a golden snapshot. Pure. */
export function snapshotFinding(f) {
  return {
    severity: f.severity,
    category: f.category,
    file: f.file,
    line: f.line ?? null,
    title: f.title,
    hasSuggestion: Boolean(f.suggestion || f.suggestedLine || f.suggestedRange),
  };
}

/** Snapshot one case: its name + its findings' stable fields, in emitted order. Pure. */
export function snapshotCase(row) {
  return { name: row.name, findings: (row.findings ?? []).map(snapshotFinding) };
}

/**
 * Diff a committed snapshot map (name → snapshotCase) against the current one.
 * Returns `{ changed, added, removed }` where `changed` lists cases whose
 * finding-set JSON differs, with the before/after for a readable dump. Pure.
 */
export function diffSnapshots(committed, current) {
  const changed = [];
  const added = [];
  const removed = [];
  const names = new Set([...Object.keys(committed), ...Object.keys(current)]);
  for (const name of [...names].sort()) {
    const before = committed[name];
    const after = current[name];
    if (before === undefined) {
      added.push(name);
      continue;
    }
    if (after === undefined) {
      removed.push(name);
      continue;
    }
    if (JSON.stringify(before.findings) !== JSON.stringify(after.findings)) {
      changed.push({ name, before: before.findings, after: after.findings });
    }
  }
  return { changed, added, removed };
}

/** True when nothing about the snapshot changed (no drift). Pure. */
export function snapshotClean(diff) {
  return diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0;
}

// ── Shadow-mode dual-run (rounding-out; builds on comparePaired #24) ──────────
//
// Shadow mode differs from the symmetric A/B comparison above in framing, which
// is what the LLMOps "shadow mode" pattern is about (see
// research/features/eval-measurement.md §C.5): there is a PRIMARY config — the
// authoritative one whose findings would actually be posted — and a SHADOW config
// that is scored ALONGSIDE it but whose output is never posted and never affects
// the primary. The question shadow mode answers is not "is B significantly
// different from A" (that's `mcnemar`) but "if I promoted the shadow to primary,
// how would the posted outcome change, and is that safe?".

/** Posts a case would emit = expected-found (true positives) + unexpected (potential FPs). Pure. */
function postCount(row) {
  return (row?.expectedFound ?? 0) + (row?.unexpected ?? 0);
}

/**
 * Per-case shadow comparison (shadow − primary). ASYMMETRIC: `primaryRows` is the
 * live/authoritative side, `shadowRows` the candidate scored beside it. For each
 * case name (union of both, sorted) reports the found/missed/unexpected deltas, how
 * many findings each side would post, and a `verdict` classifying how promoting the
 * shadow would change that case:
 *   agree           — identical caught + emitted counts
 *   shadow-more     — shadow would post strictly more findings
 *   shadow-fewer    — shadow would post strictly fewer findings
 *   shadow-different— same number posted but a different composition (e.g. traded a
 *                     real catch for a false positive)
 * `differs` is true for anything but `agree`. Pure — no IO, no clock.
 */
export function shadowCompare(primaryRows, shadowRows) {
  const byNameP = new Map(primaryRows.map((r) => [r.name, r]));
  const byNameS = new Map(shadowRows.map((r) => [r.name, r]));
  const names = [...new Set([...byNameP.keys(), ...byNameS.keys()])].sort();
  const cases = [];
  for (const name of names) {
    const p = byNameP.get(name);
    const s = byNameS.get(name);
    const foundDelta = (s?.expectedFound ?? 0) - (p?.expectedFound ?? 0);
    const missedDelta = (s?.expectedMissed ?? 0) - (p?.expectedMissed ?? 0);
    const unexpectedDelta = (s?.unexpected ?? 0) - (p?.unexpected ?? 0);
    const primaryPosts = postCount(p);
    const shadowPosts = postCount(s);
    let verdict;
    if (foundDelta === 0 && unexpectedDelta === 0) verdict = "agree";
    else if (shadowPosts > primaryPosts) verdict = "shadow-more";
    else if (shadowPosts < primaryPosts) verdict = "shadow-fewer";
    else verdict = "shadow-different";
    cases.push({ name, foundDelta, missedDelta, unexpectedDelta, primaryPosts, shadowPosts, verdict, differs: verdict !== "agree" });
  }
  return cases;
}

/**
 * Roll a `shadowCompare` result up into the promotion-decision numbers: how many
 * cases would change if the shadow were promoted, and the net newly-caught /
 * newly-missed / new-potential-FP / fewer-potential-FP deltas across the corpus.
 * Pure.
 */
export function shadowSummary(cases) {
  const out = { total: cases.length, changed: 0, newlyCaught: 0, newlyMissed: 0, newFPs: 0, fewerFPs: 0 };
  for (const c of cases) {
    if (c.differs) out.changed += 1;
    if (c.foundDelta > 0) out.newlyCaught += c.foundDelta;
    else if (c.foundDelta < 0) out.newlyMissed += -c.foundDelta;
    if (c.unexpectedDelta > 0) out.newFPs += c.unexpectedDelta;
    else if (c.unexpectedDelta < 0) out.fewerFPs += -c.unexpectedDelta;
  }
  return out;
}
