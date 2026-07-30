/**
 * CI / lint / type-checker output ingestion (report item #16).
 *
 * Parses the repo's EXISTING static-analysis output — SARIF, ESLint JSON, or
 * raw `tsc` text — read from an operator-provided local path, filters it to the
 * files touched by this PR, and renders it as CITED, deterministic ground truth
 * the VERIFIER can cross-reference. When a real tool has already flagged (or
 * conspicuously NOT flagged) a touched line, that is far stronger evidence than
 * anything the LLM can infer, so it belongs in the verifier's context.
 *
 * HARD RULES honored:
 *  - Deterministic ground truth: no LLM, no network — pure parsing + one local
 *    file read via injectable io (mirrors the cost ledger / run log).
 *  - Fail-soft: an absent / unreadable / unparseable path yields NO diagnostics
 *    and never throws. Ingestion is additive context; losing it is harmless.
 *  - Zero runtime deps: `JSON.parse` + regex only, no SARIF/eslint libraries.
 *  - No external SAST binary is invoked (non-goal): the engine only READS output
 *    the repo's own CI already produced.
 *
 * SECURITY: the path is an EngineConfig option set by the TRUSTED operator /
 * Action workflow — deliberately NOT read from the attacker-controllable
 * `.aireview.toml` — so a malicious PR cannot point Loupe at an arbitrary local
 * file (e.g. a secret) to have its contents summarized back into a comment.
 */
import { readFileSync } from "node:fs";

/** One normalized diagnostic extracted from a CI/lint/tsc report. */
export interface CiDiagnostic {
  /** Repo-relative file path, normalized to forward slashes. */
  file: string;
  /** 1-based line, when the report carries one. */
  line?: number;
  /** Rule / check id (e.g. "no-unused-vars", "TS2345", a SARIF ruleId). */
  ruleId?: string;
  /** Tool-native severity string (e.g. "error", "warning"). */
  severity?: string;
  message: string;
  /** Which parser produced this ("eslint" | "sarif" | "tsc"). */
  source: string;
}

/** Injectable file IO (tests). Mirrors LedgerIo / RunLogIo. */
export interface CiIo {
  readFile?: (path: string) => string;
}

export type CiFormat = "sarif" | "eslint" | "tsc" | "auto";

/** Normalize a reported path: strip `file://`, backslashes, and `./` prefix. */
function normalizePath(raw: string): string {
  let p = raw.trim();
  if (p.startsWith("file://")) p = p.slice("file://".length);
  p = p.replace(/\\/g, "/");
  p = p.replace(/^\.\//, "");
  return p;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// ── ESLint JSON: [{ filePath, messages:[{ ruleId, severity(1|2), message, line }] }] ──
function parseEslint(json: unknown): CiDiagnostic[] {
  if (!Array.isArray(json)) return [];
  const out: CiDiagnostic[] = [];
  for (const entry of json) {
    if (entry === null || typeof entry !== "object") continue;
    const file = (entry as { filePath?: unknown }).filePath;
    const messages = (entry as { messages?: unknown }).messages;
    if (typeof file !== "string" || !Array.isArray(messages)) continue;
    for (const m of messages) {
      if (m === null || typeof m !== "object") continue;
      const msg = (m as { message?: unknown }).message;
      if (typeof msg !== "string") continue;
      const sevNum = (m as { severity?: unknown }).severity;
      const line = (m as { line?: unknown }).line;
      const ruleId = (m as { ruleId?: unknown }).ruleId;
      out.push({
        file: normalizePath(file),
        line: typeof line === "number" ? line : undefined,
        ruleId: typeof ruleId === "string" ? ruleId : undefined,
        severity: sevNum === 2 ? "error" : sevNum === 1 ? "warning" : undefined,
        message: msg,
        source: "eslint",
      });
    }
  }
  return out;
}

// ── SARIF 2.1.0: { runs:[{ tool.driver.name, results:[{ ruleId, level,
//    message.text, locations:[{ physicalLocation:{ artifactLocation.uri,
//    region.startLine }}]}]}]} ──
function parseSarif(json: unknown): CiDiagnostic[] {
  if (json === null || typeof json !== "object") return [];
  const runs = (json as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return [];
  const out: CiDiagnostic[] = [];
  for (const run of runs) {
    if (run === null || typeof run !== "object") continue;
    const driverName = (run as { tool?: { driver?: { name?: unknown } } })?.tool?.driver?.name;
    const toolName = typeof driverName === "string" ? driverName : "sarif";
    const results = (run as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const r of results) {
      if (r === null || typeof r !== "object") continue;
      const text = (r as { message?: { text?: unknown } })?.message?.text;
      if (typeof text !== "string") continue;
      const ruleId = (r as { ruleId?: unknown }).ruleId;
      const level = (r as { level?: unknown }).level;
      const locations = (r as { locations?: unknown }).locations;
      const loc = Array.isArray(locations) ? locations[0] : undefined;
      const phys = (loc as { physicalLocation?: unknown })?.physicalLocation as
        | { artifactLocation?: { uri?: unknown }; region?: { startLine?: unknown } }
        | undefined;
      const uri = phys?.artifactLocation?.uri;
      const startLine = phys?.region?.startLine;
      if (typeof uri !== "string") continue;
      out.push({
        file: normalizePath(uri),
        line: typeof startLine === "number" ? startLine : undefined,
        ruleId: typeof ruleId === "string" ? ruleId : undefined,
        severity: typeof level === "string" ? level : undefined,
        message: text,
        source: toolName === "sarif" ? "sarif" : `sarif:${toolName}`,
      });
    }
  }
  return out;
}

// ── tsc text: "src/foo.ts(12,5): error TS2345: msg" or
//              "src/foo.ts:12:5 - error TS2345: msg" ──
const TSC_PAREN = /^(.+?)\((\d+),\d+\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
const TSC_COLON = /^(.+?):(\d+):\d+\s+-\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

function parseTsc(text: string): CiDiagnostic[] {
  const out: CiDiagnostic[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const m = TSC_PAREN.exec(line) ?? TSC_COLON.exec(line);
    if (!m) continue;
    out.push({
      file: normalizePath(m[1]),
      line: Number(m[2]),
      ruleId: m[4],
      severity: m[3],
      message: m[5].trim(),
      source: "tsc",
    });
  }
  return out;
}

function sniffAndParse(text: string): CiDiagnostic[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return parseTsc(text); // not JSON after all → maybe tsc text
    }
    if (Array.isArray(json)) return parseEslint(json);
    if (json !== null && typeof json === "object" && "runs" in (json as object)) return parseSarif(json);
    // Some eslint formatters wrap results; otherwise fall through to nothing.
    return [];
  }
  return parseTsc(text);
}

/** Parse CI output text in the given (or auto-detected) format. Pure; never throws. */
export function parseCiOutput(text: string, format: CiFormat = "auto"): CiDiagnostic[] {
  try {
    if (format === "eslint") return parseEslint(JSON.parse(text));
    if (format === "sarif") return parseSarif(JSON.parse(text));
    if (format === "tsc") return parseTsc(text);
    return sniffAndParse(text);
  } catch {
    return [];
  }
}

/**
 * Read + parse CI output from a local path via injectable io. Fail-soft: an
 * unreadable path or unparseable content yields []. Never throws.
 */
export function loadCiDiagnostics(path: string, format: CiFormat = "auto", io: CiIo = {}): CiDiagnostic[] {
  const read = io.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let text: string;
  try {
    text = read(path);
  } catch {
    return [];
  }
  return parseCiOutput(text, format);
}

/**
 * Keep only diagnostics whose file matches one of the touched paths. Matching
 * is path-suffix tolerant (absolute eslint paths, `file://` SARIF uris, and
 * relative tsc paths all reduce to the same repo-relative tail) with a
 * basename fallback. Pure.
 */
export function filterToTouched(
  diags: readonly CiDiagnostic[],
  touchedPaths: readonly string[],
): CiDiagnostic[] {
  const touched = touchedPaths.map(normalizePath);
  const touchedBases = new Set(touched.map(basename));
  return diags.filter((d) => {
    const df = d.file;
    for (const t of touched) {
      if (df === t || df.endsWith(`/${t}`) || t.endsWith(`/${df}`)) return true;
    }
    return touchedBases.has(basename(df));
  });
}

/** Max diagnostics rendered into the ground-truth block, to bound token cost. */
export const CI_RENDER_CAP = 40;

/**
 * Render the CITED static-analysis ground-truth block for the verifier. Pure.
 * "(none)" when there are no diagnostics.
 */
export function renderCiGroundTruth(diags: readonly CiDiagnostic[]): string {
  if (diags.length === 0) return "(none)";
  const shown = diags.slice(0, CI_RENDER_CAP);
  const lines = shown.map((d) => {
    const loc = d.line !== undefined ? `${d.file}:${d.line}` : d.file;
    const sev = d.severity ? `${d.severity} ` : "";
    const rule = d.ruleId ? ` [${d.ruleId}]` : "";
    return `- ${sev}${loc}${rule} — ${d.message} (${d.source})`;
  });
  if (diags.length > shown.length) {
    lines.push(`- …and ${diags.length - shown.length} more diagnostic(s) not shown`);
  }
  return lines.join("\n");
}
