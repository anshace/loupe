#!/usr/bin/env node
/**
 * Public benchmark adapters (rounding-out item from research/10 §Tier-3 list).
 *
 * Loads a LOCAL copy of a public code-review / vulnerability dataset (JSONL) and
 * converts each record into the existing `evals/cases/*` eval-case shape, so the
 * live-mode harness can track recall/precision against public data alongside the
 * hand-authored corpus and the SZZ-mined cases.
 *
 * Two formats are supported, matching the datasets called out in
 * research/features/eval-measurement.md §A:
 *   - "codereviewer" — CodeReviewer / Tufano-style review-comment records
 *     (a diff/patch + the human reviewer's comment). Diff-grained.
 *   - "primevul"     — PrimeVul / BigVul-style vulnerability records
 *     (a function body + a 0/1 vulnerable label + optional CWE). Function-grained;
 *     only the VULNERABLE (label=1) samples become gold positives.
 *
 * STRICTLY LOCAL — NO NETWORK. This script never downloads, clones, or fetches a
 * dataset. Point it at a JSONL file you already have on disk. With no dataset path
 * configured (or a path that doesn't exist) it no-ops with a clear message, so the
 * test/CI path never touches the filesystem or the network.
 *
 * Usage:
 *   node evals/benchmarks.mjs --dataset=/path/to/codereviewer.jsonl --format=codereviewer
 *   node evals/benchmarks.mjs --dataset=/path/to/primevul_test.jsonl --format=primevul --limit=200
 *   BENCHMARK_DATASET=/path/ds.jsonl BENCHMARK_FORMAT=primevul node evals/benchmarks.mjs
 *   node evals/benchmarks.mjs --dataset=... --format=... --dry-run   # count only
 *
 * Output: one `<name>.mjs` per adapted record under evals/benchmarks/ (git-ignored).
 * Like the SZZ-mined cases these carry NO mockResponses, so they are LIVE-mode only
 * (run with REVIEW_MODEL set); the deterministic default `nub run eval` reads only
 * cases/*.mjs (non-recursive) and never discovers them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveCategory, newFileDiff } from "./mine-corpus.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT_DIR = join(HERE, "benchmarks");

/** Common dataset language names → a source file extension for the synthetic path. */
const LANG_EXT = {
  javascript: "js", js: "js", typescript: "ts", ts: "ts", python: "py", py: "py",
  go: "go", golang: "go", java: "java", ruby: "rb", rb: "rb", php: "php",
  "c#": "cs", csharp: "cs", cs: "cs", c: "c", "c++": "cpp", cpp: "cpp", cxx: "cpp",
  rust: "rs", rs: "rs", swift: "swift", kotlin: "kt",
};

function extFor(lang, fallback) {
  return LANG_EXT[String(lang ?? "").toLowerCase()] ?? fallback;
}

/** Sanitize an id fragment for use in a file/case name. Pure. */
function slug(v) {
  return String(v).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "0";
}

/** Parse JSONL text into an array of records, skipping blank/corrupt lines. Pure. */
export function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      // A JSONL record is a JSON object; skip bare arrays/scalars.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed);
    } catch {
      // skip a corrupt line rather than aborting the whole file
    }
  }
  return out;
}

/**
 * Content of the ADDED lines of a unified-diff patch (the post-change code under
 * review), excluding the `+++` file header. Pure.
 */
export function addedLines(patch) {
  const out = [];
  for (const line of String(patch).split(/\r?\n/)) {
    if (line.startsWith("+++")) continue;
    if (line.startsWith("+")) out.push(line.slice(1));
  }
  return out;
}

/** Coerce a variety of 0/1 / true/false / yes label encodings to a boolean. Pure. */
export function isTruthyLabel(v) {
  if (v === true) return true;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") return /^(1|true|yes|vuln(erable)?)$/i.test(v.trim());
  return false;
}

/** Normalize a CWE field (array | string | number | absent) to an array of strings. Pure. */
export function normalizeCwe(v) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (v === undefined || v === null || v === "") return [];
  return [String(v)];
}

/**
 * Adapt one CodeReviewer/Tufano-style record into an eval case. Tolerant of the
 * differing key names across dataset exports. Returns undefined when the record
 * has no usable patch or comment. Pure.
 */
export function codeReviewerCase(record, index = 0) {
  const patch = record.patch ?? record.diff ?? record.hunk ?? record.diff_hunk ?? record.oldf_diff;
  const comment = record.msg ?? record.comment ?? record.review ?? record.body ?? record.text;
  if (typeof patch !== "string" || typeof comment !== "string" || comment.trim() === "") return undefined;
  const added = addedLines(patch);
  if (added.length === 0) return undefined;
  const id = record.id ?? record.idx ?? index;
  const ext = extFor(record.lang ?? record.language, "txt");
  const path = `benchmark/codereviewer/${slug(id)}.${ext}`;
  return {
    name: `bench-codereviewer-${slug(id)}`,
    diff: newFileDiff(path, added),
    fileContents: { [path]: added.join("\n") },
    // Region-level recall: the reviewer commented SOMEWHERE in the added block.
    // No mustMatch — these comments are noisy/free-form (research §A.4), so the
    // gold signal is "did the tool flag this region", with the human comment kept
    // in `source` for manual inspection.
    expectedFindings: [{ file: path, lineRange: [1, added.length], category: deriveCategory(comment) }],
    source: { benchmark: "codereviewer", id, lang: record.lang ?? record.language ?? null, comment: comment.trim() },
    // No mockResponses on purpose → LIVE-mode case (REVIEW_MODEL set).
  };
}

/**
 * Adapt one PrimeVul/BigVul-style vulnerability record into an eval case. Only
 * VULNERABLE samples (label truthy) become gold positives; benign samples are
 * skipped (they'd only measure clean-case FP rate, which the hand corpus already
 * covers). Returns undefined when there's no usable function body. Pure.
 */
export function primeVulCase(record, index = 0) {
  const func = record.func ?? record.function ?? record.func_before ?? record.code;
  const label = record.target ?? record.label ?? record.vul ?? record.is_vulnerable;
  if (typeof func !== "string" || func.trim() === "") return undefined;
  if (!isTruthyLabel(label)) return undefined;
  const lines = func.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return undefined;
  const id = record.idx ?? record.id ?? record.commit_id ?? index;
  const ext = extFor(record.lang ?? record.language, "c"); // PrimeVul/BigVul are mostly C/C++
  const path = `benchmark/primevul/${slug(id)}.${ext}`;
  const cwe = normalizeCwe(record.cwe ?? record.CWE);
  return {
    name: `bench-primevul-${slug(id)}`,
    diff: newFileDiff(path, lines),
    fileContents: { [path]: lines.join("\n") },
    // Function-grained ground truth: the whole function is vulnerable, so the gold
    // region spans it and the category is security. CWE/CVE kept in `source`.
    expectedFindings: [{ file: path, lineRange: [1, lines.length], category: "security" }],
    source: { benchmark: "primevul", id, cwe, cve: record.cve ?? record.CVE ?? null },
  };
}

const ADAPTERS = { codereviewer: codeReviewerCase, primevul: primeVulCase };
export const KNOWN_FORMATS = Object.keys(ADAPTERS);

/**
 * Adapt an array of dataset records to eval cases with the named format. Skips
 * records the adapter can't convert, and disambiguates any name collisions. Pure.
 * Returns { cases, skipped }. Throws on an unknown format.
 */
export function adaptRecords(records, format, { limit = Infinity } = {}) {
  const adapt = ADAPTERS[format];
  if (!adapt) throw new Error(`unknown benchmark format "${format}" (known: ${KNOWN_FORMATS.join(", ")})`);
  const cases = [];
  const seen = new Set();
  let skipped = 0;
  for (let i = 0; i < records.length && cases.length < limit; i++) {
    const c = adapt(records[i], i);
    if (!c) {
      skipped += 1;
      continue;
    }
    if (seen.has(c.name)) c.name = `${c.name}-${i}`;
    seen.add(c.name);
    cases.push(c);
  }
  return { cases, skipped };
}

/** Serialize an adapted case to an ES-module source string. Pure. */
export function renderBenchmarkCaseModule(caseObj) {
  return (
    "// Auto-generated by evals/benchmarks.mjs (public-benchmark adapter) from a\n" +
    "// LOCAL public dataset record. LIVE-mode only (no mockResponses).\n" +
    `export default ${JSON.stringify(caseObj, null, 2)};\n`
  );
}

// ── Dataset IO (LOCAL only; injectable for tests) ────────────────────────────

const DEFAULT_IO = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, "utf8"),
};

/**
 * Load and parse a local JSONL dataset. Returns { records, reason } where reason
 * is "absent" (no path / file missing → no-op), "unreadable" (IO error), or "ok".
 * Never throws; never touches the network. `io` is injectable for tests.
 */
export function loadDataset(path, io = DEFAULT_IO) {
  if (!path || !io.exists(path)) return { records: [], reason: "absent" };
  let text;
  try {
    text = io.read(path);
  } catch (err) {
    return { records: [], reason: "unreadable", error: String(err?.message ?? err) };
  }
  return { records: parseJsonl(text), reason: "ok" };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let dataset = process.env.BENCHMARK_DATASET ?? "";
  let format = process.env.BENCHMARK_FORMAT ?? "";
  let out = DEFAULT_OUT_DIR;
  let limit = Infinity;
  let dryRun = false;
  for (const a of argv) {
    if (a.startsWith("--dataset=")) dataset = a.slice("--dataset=".length);
    else if (a.startsWith("--format=")) format = a.slice("--format=".length).toLowerCase();
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
    else if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length)) || limit;
    else if (a === "--dry-run") dryRun = true;
  }
  return { dataset, format, out, limit, dryRun };
}

function main() {
  const { dataset, format, out, limit, dryRun } = parseArgs(process.argv.slice(2));

  if (!dataset) {
    console.log(
      "benchmarks: no dataset configured — nothing to adapt (no-op).\n" +
        "  Point it at a LOCAL JSONL file you already have on disk:\n" +
        "    node evals/benchmarks.mjs --dataset=/path/to/ds.jsonl --format=codereviewer\n" +
        `  Known formats: ${KNOWN_FORMATS.join(", ")}.  This script is LOCAL-ONLY — it never\n` +
        "  downloads or clones a dataset.",
    );
    return 0;
  }
  if (!KNOWN_FORMATS.includes(format)) {
    console.log(`benchmarks: --format is required and must be one of: ${KNOWN_FORMATS.join(", ")} (got "${format}").`);
    return 2;
  }

  const { records, reason, error } = loadDataset(dataset);
  if (reason === "absent") {
    console.log(`benchmarks: dataset "${dataset}" not found — no-op (LOCAL paths only; nothing is downloaded).`);
    return 0;
  }
  if (reason === "unreadable") {
    console.log(`benchmarks: could not read "${dataset}" — ${error}`);
    return 2;
  }

  const { cases, skipped } = adaptRecords(records, format, { limit });
  if (!dryRun) mkdirSync(out, { recursive: true });
  for (const c of cases) {
    if (dryRun) continue;
    writeFileSync(join(out, `${c.name}.mjs`), renderBenchmarkCaseModule(c));
  }
  console.log(
    `benchmarks: ${dataset} [${format}] → ${records.length} record(s), ` +
      `${cases.length} case(s) adapted, ${skipped} skipped.`,
  );
  console.log(
    dryRun
      ? `benchmarks: dry run — nothing written (would write to ${out}).`
      : cases.length === 0
        ? `benchmarks: 0 cases written (no records had an adaptable diff/function).`
        : `benchmarks: wrote ${cases.length} case(s) to ${out}. Run them live with REVIEW_MODEL=<provider>.`,
  );
  return 0;
}

if (process.argv[1]?.endsWith("benchmarks.mjs")) process.exit(main());
