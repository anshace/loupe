#!/usr/bin/env node
/**
 * Eval harness (task 6.7): runs the full review pipeline over evals/cases/*
 * and reports precision/recall-ish counts per case and in total:
 *   expected-found, expected-missed, unexpected (= potential false positives).
 *
 * Providers are pluggable via REVIEW_MODEL:
 *   - unset or "mock" → offline replay mode (each case's mockResponses),
 *     fully deterministic, safe for CI. THIS is the mode used today.
 *   - "gemini" | "haiku" | "groq" → live provider via the engine's normal
 *     selection (requires the matching API key env var). Live runs are for
 *     later; nothing in this repo triggers them automatically.
 *
 * Usage: nub run eval   (exit code 1 when any expected finding is missed or
 * a clean case produces findings; "unexpected" counts are reported but do
 * not fail mock runs of buggy cases).
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const engine = await import(pathToFileURL(join(here, "..", "packages", "engine", "dist", "index.js")).href);
const { runReview, resolveProviderChoice, selectProvider } = engine;

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

async function runCase(c) {
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
  };
}

let totals = { expectedFound: 0, expectedMissed: 0, unexpected: 0, verifierDropped: 0 };
let failures = 0;

console.log(`eval: ${caseFiles.length} case(s), provider=${liveMode ? modelChoice : "mock (replay)"}\n`);

for (const file of caseFiles) {
  const mod = await import(pathToFileURL(join(casesDir, file)).href);
  const c = mod.default;
  let row;
  try {
    row = await runCase(c);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${c?.name ?? file}: pipeline error — ${err?.message ?? err}`);
    continue;
  }

  totals.expectedFound += row.expectedFound;
  totals.expectedMissed += row.expectedMissed;
  totals.unexpected += row.unexpected;
  totals.verifierDropped += row.verification?.dropped?.length ?? 0;

  const bad = row.expectedMissed > 0 || row.cleanViolated;
  if (bad) failures += 1;
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
process.exit(failures === 0 ? 0 : 1);
