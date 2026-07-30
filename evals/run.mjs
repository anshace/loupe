#!/usr/bin/env node
/**
 * Eval harness (task 6.7 + report items #11/#24): runs the full review pipeline
 * over evals/cases/* and reports precision/recall-ish counts per case and in
 * total: expected-found, expected-missed, unexpected (= potential false positives).
 *
 * Providers are pluggable via REVIEW_MODEL:
 *   - unset or "mock" → offline replay mode (each case's mockResponses),
 *     fully deterministic, safe for CI. THIS is the mode used today.
 *   - "gemini" | "haiku" | "groq" → live provider via the engine's normal
 *     selection (requires the matching API key env var). Live runs are for
 *     later; nothing in this repo triggers them automatically.
 *
 * MODES (all offline-deterministic except where a live provider is chosen):
 *   node evals/run.mjs                     default pass/fail run (exit 1 on any
 *                                          missed finding or clean-case violation)
 *   node evals/run.mjs --history           append a trend point to history.jsonl
 *       [--sha=<sha>] [--date=<YYYY-MM-DD>] [--prompt=<ver>]  (date/sha passed IN,
 *                                          never Date.now(); rebuilds history.html)
 *   node evals/run.mjs --selftest          mandatory A/A test: run the corpus twice
 *                                          under one config; must be identical
 *   node evals/run.mjs --ab --configB='{"verify":true}' [--configA='{}']
 *                                          paired A-vs-B run: per-case deltas +
 *                                          McNemar summary (runs A/A first)
 *   node evals/run.mjs --snapshot [--update]
 *                                          golden full-output diff; --update writes
 *                                          evals/snapshots.json, else fails on drift
 *   node evals/run.mjs --shadow --shadowConfig='{"verify":true}' [--primaryConfig='{}']
 *                                          shadow-mode dual-run: score a SHADOW config
 *                                          alongside the authoritative PRIMARY, report
 *                                          per-case "if promoted" deltas; the shadow
 *                                          never affects the primary (isolation-checked)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendHistory, buildHistoryHtml, computeMetrics, makeHistoryRecord } from "./history.mjs";
import {
  comparePaired,
  diffSnapshots,
  mcnemar,
  shadowCompare,
  shadowSummary,
  snapshotCase,
  snapshotClean,
} from "./harness.mjs";
import { cohensKappa, kappaLabel } from "./calibration.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const engine = await import(pathToFileURL(join(here, "..", "packages", "engine", "dist", "index.js")).href);
const { runReview, resolveProviderChoice, selectProvider, REVIEWER_PROMPT_FILE } = engine;

/** Deterministic replay provider for offline/CI runs. */
class ReplayProvider {
  name = "mock";
  #i = 0;
  constructor(responses) {
    this.responses = responses.length > 0 ? responses : ["[]"];
  }
  async complete() {
    const text = this.responses[Math.min(this.#i, this.responses.length - 1)];
    this.#i += 1;
    return { text, inputTokens: 10, outputTokens: 5 };
  }
}

const modelChoice = (process.env.REVIEW_MODEL ?? "mock").toLowerCase();
const liveMode = modelChoice !== "mock";

const casesDir = join(here, "cases");
const caseFiles = readdirSync(casesDir)
  .filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))
  .sort();

function matches(expected, found) {
  if (found.file !== expected.file) return false;
  if (expected.mustMatch) {
    const re = new RegExp(expected.mustMatch, "i");
    if (!re.test(`${found.title} ${found.body}`)) return false;
  }
  if (expected.lineRange && found.line !== undefined) {
    const [lo, hi] = expected.lineRange;
    if (found.line < lo || found.line > hi) return false;
  }
  return true;
}

/** Run one case, optionally with engine-config OVERRIDES (for A/B). */
async function runCase(c, overrides = {}) {
  const model = liveMode
    ? selectProvider(resolveProviderChoice(process.env))
    : new ReplayProvider(c.mockResponses ?? []);

  const fetchImpl = async (url) => {
    if (url.includes(`/pulls/`)) return { ok: true, status: 200, text: async () => c.diff };
    return { ok: false, status: 404, text: async () => "eval: not served" };
  };
  const fileContents = c.fileContents ?? {};
  const result = await runReview(
    { owner: "eval", repo: "eval", prNumber: 1 },
    "eval-token",
    {
      dryRun: true,
      minSeverity: "low",
      escalation: false, // keep the chosen provider stable across cases
      agentic: c.config?.agentic ?? false,
      verify: c.config?.verify ?? false,
      event: { headSha: "evalhead" },
      ...overrides, // A/B config overrides win over the case defaults
    },
    {
      model,
      fetchImpl,
      repoFiles: {},
      existingComments: { reviewComments: [], issueComments: [] },
      headFiles: fileContents,
      repoReader: {
        listTree: async () => Object.keys(fileContents),
        readFile: async (path) => fileContents[path],
      },
    },
  );

  const findings = result.findings;
  const expected = c.expectedFindings ?? [];
  const matchedFindings = new Set();
  let expectedFound = 0;
  for (const exp of expected) {
    const hit = findings.find((f, i) => !matchedFindings.has(i) && matches(exp, f));
    if (hit !== undefined) {
      matchedFindings.add(findings.indexOf(hit));
      expectedFound += 1;
    }
  }
  const expectedMissed = expected.length - expectedFound;
  const unexpected = findings.length - matchedFindings.size;
  const cleanViolated = Boolean(c.expectClean) && findings.length > 0;

  return {
    name: c.name,
    expectedFound,
    expectedMissed,
    unexpected,
    cleanViolated,
    verification: result.verification,
    degraded: result.degraded,
    findings,
  };
}

async function loadCases() {
  const out = [];
  for (const file of caseFiles) {
    const mod = await import(pathToFileURL(join(casesDir, file)).href);
    out.push(mod.default);
  }
  return out;
}

/** Run the whole corpus; return per-case rows + aggregate totals + failure count. */
async function runCorpus(overrides = {}) {
  const cases = await loadCases();
  const rows = [];
  const totals = { expectedFound: 0, expectedMissed: 0, unexpected: 0, verifierDropped: 0 };
  let failures = 0;
  for (const c of cases) {
    let row;
    try {
      row = await runCase(c, overrides);
    } catch (err) {
      failures += 1;
      rows.push({ name: c?.name ?? "?", error: String(err?.message ?? err), findings: [] });
      continue;
    }
    rows.push(row);
    totals.expectedFound += row.expectedFound;
    totals.expectedMissed += row.expectedMissed;
    totals.unexpected += row.unexpected;
    totals.verifierDropped += row.verification?.dropped?.length ?? 0;
    if (row.expectedMissed > 0 || row.cleanViolated) failures += 1;
  }
  return { rows, totals, failures };
}

// ── CLI arg helpers ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argVal = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : dflt;
};
function parseConfig(name) {
  const raw = argVal(name);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`eval: ${name} is not valid JSON — ${err.message}`);
    process.exit(2);
  }
}

// ── Default run output (unchanged format) ───────────────────────────────────
function printDefaultRun(rows, totals, failures) {
  console.log(`eval: ${caseFiles.length} case(s), provider=${liveMode ? modelChoice : "mock (replay)"}\n`);
  for (const row of rows) {
    if (row.error) {
      console.log(`  FAIL ${row.name}: pipeline error — ${row.error}`);
      continue;
    }
    const bad = row.expectedMissed > 0 || row.cleanViolated;
    const status = bad ? "FAIL" : "pass";
    const parts = [`found ${row.expectedFound}`, `missed ${row.expectedMissed}`, `unexpected ${row.unexpected}`];
    if (row.verification) parts.push(`verifier-dropped ${row.verification.dropped.length}`);
    if (row.degraded) parts.push("DEGRADED");
    if (row.cleanViolated) parts.push("CLEAN-CASE VIOLATED");
    console.log(`  ${status}  ${row.name}: ${parts.join(", ")}`);
  }
  console.log(
    `\ntotals: expected-found ${totals.expectedFound}, expected-missed ${totals.expectedMissed}, ` +
      `unexpected(potential FP) ${totals.unexpected}, verifier-dropped ${totals.verifierDropped}`,
  );
  console.log(failures === 0 ? "eval: PASS" : `eval: FAIL (${failures} case(s))`);
}

/** Compare two corpora row-for-row on the counts that must be identical. */
function rowsIdentical(rowsA, rowsB) {
  const mismatches = [];
  const byB = new Map(rowsB.map((r) => [r.name, r]));
  for (const a of rowsA) {
    const b = byB.get(a.name);
    if (!b) {
      mismatches.push(`${a.name}: missing in second run`);
      continue;
    }
    if (a.expectedFound !== b.expectedFound || a.expectedMissed !== b.expectedMissed || a.unexpected !== b.unexpected) {
      mismatches.push(
        `${a.name}: (found ${a.expectedFound}→${b.expectedFound}, missed ${a.expectedMissed}→${b.expectedMissed}, unexpected ${a.unexpected}→${b.unexpected})`,
      );
    }
  }
  return mismatches;
}

// ── Mode: A/A self-test ─────────────────────────────────────────────────────
async function selfTest(overrides = {}, quiet = false) {
  const first = await runCorpus(overrides);
  const second = await runCorpus(overrides);
  const mismatches = rowsIdentical(first.rows, second.rows);
  if (!quiet) {
    console.log(`eval A/A self-test: corpus run twice under identical config (${caseFiles.length} cases)`);
    if (mismatches.length === 0) {
      console.log("  PASS — outcomes identical (harness is deterministic under this config).");
    } else {
      console.log(`  FAIL — ${mismatches.length} case(s) differ between identical runs:`);
      for (const m of mismatches) console.log(`    - ${m}`);
      console.log("  A 'significant' A/B result under a non-deterministic harness is meaningless.");
    }
  }
  return mismatches.length === 0;
}

// ── Mode: A/B paired comparison ─────────────────────────────────────────────
async function abTest() {
  const configA = parseConfig("--configA");
  const configB = parseConfig("--configB");
  console.log(`eval A/B: A=${JSON.stringify(configA)}  vs  B=${JSON.stringify(configB)}\n`);

  // Mandatory A/A self-test on config A before trusting any A/B delta.
  const aaOk = await selfTest(configA);
  console.log("");
  if (!aaOk && !liveMode) {
    // Offline, A/A must be clean; if not, the harness itself is broken.
    console.log("eval A/B: aborting — A/A self-test failed offline (harness bug).");
    return 2;
  }

  const runA = await runCorpus(configA);
  const runB = await runCorpus(configB);
  const pairs = comparePaired(runA.rows, runB.rows);
  const changed = pairs.filter((p) => p.foundDelta || p.missedDelta || p.unexpectedDelta || p.regressed || p.improved);

  console.log(`per-case deltas (B − A), ${changed.length} case(s) changed:`);
  if (changed.length === 0) console.log("  (none — A and B produced identical per-case outcomes)");
  for (const p of changed) {
    const tag = p.regressed ? " REGRESSED" : p.improved ? " improved" : "";
    console.log(
      `  ${p.name}: found ${p.foundDelta >= 0 ? "+" : ""}${p.foundDelta}, missed ${p.missedDelta >= 0 ? "+" : ""}${p.missedDelta}, unexpected ${p.unexpectedDelta >= 0 ? "+" : ""}${p.unexpectedDelta}${tag}`,
    );
  }

  const mc = mcnemar(pairs);
  const mA = computeMetrics(runA.totals);
  const mB = computeMetrics(runB.totals);
  console.log(
    `\naggregate: precision ${mA.precision}→${mB.precision}, recall ${mA.recall}→${mB.recall}, ` +
      `fpRate ${mA.fpRate}→${mB.fpRate}`,
  );
  console.log(
    `McNemar: A-only wins ${mc.aOnly}, B-only wins ${mc.bOnly}, χ²=${mc.statistic} ` +
      `(${mc.significant ? "SIGNIFICANT at α=0.05" : "not significant"}${mc.underpowered ? "; UNDERPOWERED — too few discordant cases to trust" : ""})`,
  );

  // Model/prompt-swap agreement (report item #30): Cohen's kappa over the paired
  // per-case success labels — how much the judgment PATTERN shifted between the
  // two configs, chance-corrected. A distinct, cheaper signal than precision/
  // recall: it catches "quietly became a different reviewer" drift.
  const kappa = cohensKappa(
    pairs.map((p) => (p.successA ? "pass" : "fail")),
    pairs.map((p) => (p.successB ? "pass" : "fail")),
  );
  if (kappa) {
    console.log(
      `Cohen's kappa (A vs B per-case success): ${kappa.kappa} ` +
        `(${kappaLabel(kappa.kappa)} agreement, po=${kappa.po}, pe=${kappa.pe}, n=${kappa.n})`,
    );
  }
  return 0; // A/B is informational; it never fails the build on its own
}

// ── Mode: golden snapshot diff ──────────────────────────────────────────────
const SNAPSHOT_PATH = join(here, "snapshots.json");
async function snapshotMode() {
  const { rows } = await runCorpus();
  const current = Object.fromEntries(rows.map((r) => [r.name, snapshotCase(r)]));
  if (hasFlag("--update")) {
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + "\n");
    console.log(`eval snapshot: wrote ${Object.keys(current).length} case snapshot(s) to ${SNAPSHOT_PATH}`);
    return 0;
  }
  let committed;
  try {
    committed = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  } catch {
    console.log(`eval snapshot: no committed snapshot at ${SNAPSHOT_PATH}.`);
    console.log("  Run 'node evals/run.mjs --snapshot --update' to establish the baseline first.");
    return 1;
  }
  const diff = diffSnapshots(committed, current);
  if (snapshotClean(diff)) {
    console.log(`eval snapshot: OK — all ${Object.keys(current).length} case(s) match the committed golden output.`);
    return 0;
  }
  console.log("eval snapshot: DRIFT detected vs committed golden output —");
  for (const name of diff.added) console.log(`  + new case (not in snapshot): ${name}`);
  for (const name of diff.removed) console.log(`  - case missing from this run: ${name}`);
  for (const ch of diff.changed) {
    console.log(`  ~ ${ch.name} changed:`);
    console.log(`      before: ${JSON.stringify(ch.before)}`);
    console.log(`      after:  ${JSON.stringify(ch.after)}`);
  }
  console.log("  If this change is intended, re-baseline with '--snapshot --update'.");
  return 1;
}

// ── Mode: shadow-mode dual-run (rounding-out; builds on the #24 A/B harness) ──
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
async function shadowMode() {
  const primaryConfig = parseConfig("--primaryConfig");
  const shadowConfig = parseConfig("--shadowConfig");
  console.log(
    `eval shadow: PRIMARY=${JSON.stringify(primaryConfig)} (authoritative — would be posted)  |  ` +
      `SHADOW=${JSON.stringify(shadowConfig)} (scored alongside — never posted)\n`,
  );

  const primary = await runCorpus(primaryConfig);
  const shadow = await runCorpus(shadowConfig);

  // Isolation guarantee ("scored alongside, without one affecting the other"):
  // re-run the primary AFTER the shadow and assert its outcome is byte-identical.
  // A difference means the shadow run mutated shared state that leaked into the
  // primary — the exact thing shadow mode must never do.
  const primaryAgain = await runCorpus(primaryConfig);
  const leak = rowsIdentical(primary.rows, primaryAgain.rows);
  if (leak.length === 0) {
    console.log("isolation: OK — primary outcome is identical whether or not the shadow ran.\n");
  } else {
    console.log(`isolation: BROKEN — primary changed after the shadow run (${leak.length} case(s)):`);
    for (const m of leak) console.log(`    - ${m}`);
    if (!liveMode) {
      console.log("eval shadow: aborting — isolation broken offline (harness bug: shadow leaked into primary).");
      return 2;
    }
    console.log("");
  }

  const cases = shadowCompare(primary.rows, shadow.rows);
  const differing = cases.filter((c) => c.differs);
  console.log(`per-case shadow deltas (shadow − primary), ${differing.length} of ${cases.length} case(s) would change:`);
  if (differing.length === 0) console.log("  (none — the shadow would post the same outcome on every case)");
  for (const c of differing) {
    console.log(
      `  ${c.name}: found ${signed(c.foundDelta)}, missed ${signed(c.missedDelta)}, ` +
        `unexpected ${signed(c.unexpectedDelta)}  [${c.verdict}]`,
    );
  }

  const sum = shadowSummary(cases);
  const mP = computeMetrics(primary.totals);
  const mS = computeMetrics(shadow.totals);
  console.log(
    `\naggregate: precision ${mP.precision}→${mS.precision}, recall ${mP.recall}→${mS.recall}, ` +
      `fpRate ${mP.fpRate}→${mS.fpRate}`,
  );
  console.log(
    `if promoted: ${sum.changed}/${sum.total} case(s) change — ` +
      `+${sum.newlyCaught} newly caught, +${sum.newlyMissed} newly missed, ` +
      `+${sum.newFPs} new potential FP, −${sum.fewerFPs} fewer potential FP`,
  );
  console.log("shadow output is informational only — it is never posted and never affects the primary.");
  return 0; // shadow mode is a decision aid; it never fails the build on its own
}

// ── Mode: default run (+ optional --history append) ─────────────────────────
function gitShaFallback() {
  try {
    return execFileSync("git", ["-C", here, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function defaultMode() {
  const { rows, totals, failures } = await runCorpus();
  printDefaultRun(rows, totals, failures);

  if (hasFlag("--history")) {
    // date/sha are passed IN (deterministic); only a real interactive run falls
    // back to git + today's date (never exercised by the pure-function tests).
    const date = argVal("--date", process.env.EVAL_DATE ?? new Date().toISOString().slice(0, 10));
    const sha = argVal("--sha", process.env.EVAL_SHA ?? gitShaFallback());
    const promptVersion = argVal("--prompt", (REVIEWER_PROMPT_FILE ?? "reviewer-unknown").replace(/\.md$/, ""));
    const record = makeHistoryRecord({
      date,
      sha,
      promptVersion,
      model: liveMode ? modelChoice : "mock",
      cases: caseFiles.length,
      totals,
    });
    appendHistory(record);
    const htmlPath = buildHistoryHtml();
    console.log(
      `\neval history: appended ${date} ${sha} → precision ${record.precision}, recall ${record.recall}, ` +
        `fpRate ${record.fpRate}, dropRate ${record.dropRate}`,
    );
    console.log(`eval history: rebuilt ${htmlPath} (local file — open directly, never uploaded)`);
  }

  return failures === 0 ? 0 : 1;
}

// ── Dispatch ────────────────────────────────────────────────────────────────
let exitCode;
if (hasFlag("--ab")) exitCode = await abTest();
else if (hasFlag("--shadow")) exitCode = await shadowMode();
else if (hasFlag("--snapshot")) exitCode = await snapshotMode();
else if (hasFlag("--selftest")) exitCode = (await selfTest(parseConfig("--configA"))) ? 0 : 1;
else exitCode = await defaultMode();

process.exit(exitCode);
