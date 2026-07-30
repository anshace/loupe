#!/usr/bin/env node
/**
 * Local eval trend log + static HTML (report item #11).
 *
 * Appends one `{date, sha, promptVersion, model, precision, recall, fpRate,
 * dropRate, ...}` record per eval run to `evals/history.jsonl`, and renders a
 * self-contained `evals/history.html` you open DIRECTLY in a browser.
 *
 * LOCAL ONLY. The HTML is written to disk and never uploaded anywhere (this is a
 * shared-account machine; nothing "goes out"). It embeds all CSS/SVG inline — no
 * external requests — so it works offline from a file:// URL.
 *
 * DETERMINISM: `date` and `sha` are passed IN (CLI/env), never `Date.now()`, so
 * appending a record is reproducible; the pure functions below take no clock.
 * `run.mjs` reads them from `--date`/`--sha` (falling back to git + today ONLY
 * for a real, interactive run — never inside a test).
 *
 * Usage:
 *   node evals/history.mjs render                 # (re)build evals/history.html
 *   node evals/history.mjs render --out=foo.html  # to a custom path
 * `run.mjs --history --sha=<sha> --date=<YYYY-MM-DD>` appends a record.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HISTORY_JSONL = join(HERE, "history.jsonl");
export const HISTORY_HTML = join(HERE, "history.html");

/** Injectable IO so tests never touch the filesystem. */
const DEFAULT_IO = {
  append: (p, line) => appendFileSync(p, line),
  read: (p) => readFileSync(p, "utf8"),
  write: (p, text) => writeFileSync(p, text),
};

function ratio(numer, denom) {
  if (denom <= 0) return 0;
  return Math.round((numer / denom) * 10000) / 10000; // 4 dp — stable across runs
}

/**
 * Derive the headline quality metrics from a run's aggregate counts. Pure.
 *   TP = expectedFound, FP = unexpected, FN = expectedMissed.
 *   precision = TP/(TP+FP)     — of what we emitted, how much was wanted
 *   recall    = TP/(TP+FN)     — of what was wanted, how much we caught
 *   fpRate    = FP/(TP+FP)     — share of emitted findings matching nothing (= 1-precision)
 *   dropRate  = verifierDropped/(TP+FP+verifierDropped) — share the verifier removed
 */
export function computeMetrics(totals) {
  const tp = totals.expectedFound ?? 0;
  const fp = totals.unexpected ?? 0;
  const fn = totals.expectedMissed ?? 0;
  const dropped = totals.verifierDropped ?? 0;
  return {
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    fpRate: ratio(fp, tp + fp),
    dropRate: ratio(dropped, tp + fp + dropped),
  };
}

/**
 * Build one history record from a run's identity + totals. Pure. `date`/`sha`
 * are supplied by the caller (never read from the clock here).
 */
export function makeHistoryRecord({ date, sha, promptVersion, model, cases, totals }) {
  const metrics = computeMetrics(totals);
  return {
    date: date ?? "unknown",
    sha: sha ?? "unknown",
    promptVersion: promptVersion ?? "unknown",
    model: model ?? "mock",
    cases: cases ?? 0,
    expectedFound: totals.expectedFound ?? 0,
    expectedMissed: totals.expectedMissed ?? 0,
    unexpected: totals.unexpected ?? 0,
    verifierDropped: totals.verifierDropped ?? 0,
    ...metrics,
  };
}

/** Append one record as a JSONL line. Best-effort — never throws. */
export function appendHistory(record, io = DEFAULT_IO, path = HISTORY_JSONL) {
  try {
    io.append(path, JSON.stringify(record) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Read all history records, skipping corrupt/foreign lines. Never throws. */
export function readHistory(io = DEFAULT_IO, path = HISTORY_JSONL) {
  let text;
  try {
    text = io.read(path);
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.date === "string") out.push(parsed);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** Inline SVG line chart (0..1) for one metric across the run sequence. Pure. */
function sparkline(values, color) {
  const W = 640;
  const H = 120;
  const pad = 8;
  if (values.length === 0) return "";
  const n = values.length;
  const x = (i) => (n === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (n - 1));
  const y = (v) => H - pad - v * (H - 2 * pad);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dots = values
    .map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${color}" />`)
    .join("");
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" role="img">` +
    `<line x1="${pad}" y1="${y(0.5).toFixed(1)}" x2="${W - pad}" y2="${y(0.5).toFixed(1)}" class="mid"/>` +
    `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>${dots}</svg>`
  );
}

/**
 * Render the whole history as a self-contained HTML document string. Pure —
 * takes the records, returns HTML text (the caller writes it to disk). Never
 * uploaded; opened locally.
 */
export function renderHistoryHtml(records) {
  const rows = records
    .map((r) => {
      const pct = (v) => `${(Number(v) * 100).toFixed(1)}%`;
      return (
        `<tr><td>${esc(r.date)}</td><td class="mono">${esc(String(r.sha).slice(0, 12))}</td>` +
        `<td>${esc(r.promptVersion)}</td><td>${esc(r.model)}</td><td class="num">${r.cases ?? ""}</td>` +
        `<td class="num good">${pct(r.precision)}</td><td class="num good">${pct(r.recall)}</td>` +
        `<td class="num warn">${pct(r.fpRate)}</td><td class="num">${pct(r.dropRate)}</td></tr>`
      );
    })
    .join("\n");
  const precision = records.map((r) => Number(r.precision) || 0);
  const recall = records.map((r) => Number(r.recall) || 0);
  const last = records[records.length - 1];
  const headline = last
    ? `Latest (${esc(last.date)} · ${esc(String(last.sha).slice(0, 8))}): precision ${(last.precision * 100).toFixed(
        1,
      )}% · recall ${(last.recall * 100).toFixed(1)}%`
    : "No runs recorded yet — run <code>node evals/run.mjs --history --sha=&lt;sha&gt; --date=&lt;YYYY-MM-DD&gt;</code>.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Loupe eval trend</title>
<style>
  :root{color-scheme:light dark;--bg:#fff;--fg:#1c2024;--muted:#667;--line:#e3e6ea;--card:#f7f8fa;--good:#0a7d3c;--warn:#b25b00;--acc:#2563eb;--acc2:#0a7d3c}
  @media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e9ec;--muted:#9aa4ad;--line:#262b30;--card:#1b1f24;--good:#3fbf6a;--warn:#e0913a}}
  *{box-sizing:border-box}
  body{margin:0;padding:2rem 1.25rem;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
  main{max-width:960px;margin:0 auto}
  h1{font-size:1.4rem;margin:0 0 .25rem}
  p.sub{color:var(--muted);margin:.1rem 0 1.5rem}
  .cards{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.5rem}
  @media(max-width:640px){.cards{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem}
  .card h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 .5rem}
  .card svg .mid{stroke:var(--line);stroke-dasharray:4 4}
  .tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px}
  table{border-collapse:collapse;width:100%;font-size:14px}
  th,td{padding:.5rem .7rem;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
  th{font-size:.72rem;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);background:var(--card)}
  tr:last-child td{border-bottom:none}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;color:var(--muted)}
  .good{color:var(--good)} .warn{color:var(--warn)}
  footer{color:var(--muted);font-size:.8rem;margin-top:1.5rem}
</style></head>
<body><main>
  <h1>Loupe — eval quality trend</h1>
  <p class="sub">${headline}</p>
  <div class="cards">
    <div class="card"><h2>Precision</h2>${sparkline(precision, "var(--acc)")}</div>
    <div class="card"><h2>Recall</h2>${sparkline(recall, "var(--acc2)")}</div>
  </div>
  <div class="tablewrap"><table>
    <thead><tr><th>Date</th><th>SHA</th><th>Prompt</th><th>Model</th><th class="num">Cases</th>
    <th class="num">Precision</th><th class="num">Recall</th><th class="num">FP rate</th><th class="num">Drop rate</th></tr></thead>
    <tbody>
${rows || '<tr><td colspan="9" style="color:var(--muted)">No runs recorded yet.</td></tr>'}
    </tbody>
  </table></div>
  <footer>Local file — never uploaded. Generated from <code>evals/history.jsonl</code> (${records.length} run${
    records.length === 1 ? "" : "s"
  }).</footer>
</main></body></html>`;
}

/** Read history JSONL and (re)write the local HTML. Returns the output path. */
export function buildHistoryHtml(io = DEFAULT_IO, jsonlPath = HISTORY_JSONL, htmlPath = HISTORY_HTML) {
  const records = readHistory(io, jsonlPath);
  io.write(htmlPath, renderHistoryHtml(records));
  return htmlPath;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("history.mjs")) {
  const cmd = process.argv[2];
  if (cmd === "render") {
    const outArg = process.argv.find((a) => a.startsWith("--out="));
    const out = outArg ? outArg.slice("--out=".length) : HISTORY_HTML;
    const path = buildHistoryHtml(DEFAULT_IO, HISTORY_JSONL, out);
    console.log(`history: wrote ${path} (open it directly in a browser — never uploaded)`);
  } else if (cmd) {
    console.log(`history: unknown command "${cmd}". Use: node evals/history.mjs render [--out=path]`);
  } else {
    console.log("history: usage — node evals/history.mjs render [--out=path]");
  }
}
