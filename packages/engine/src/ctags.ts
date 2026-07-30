/**
 * ctags-lite symbol index (rounding-out context item; research
 * context-retrieval.md §7).
 *
 * A lightweight, in-memory, regex/heuristic definition index over TS/JS/Python —
 * built ONCE per run from the same `RepoReader` substrate the agentic loop and
 * the import graph already use. It is a deliberately cheap ALTERNATIVE context
 * source: where `packages/ts-symbols` gives real type-aware
 * definition/reference resolution (heavy, `typescript`-backed, Action-path only),
 * this gives an 80%-value "where is this symbol declared" map for any repo, with
 * ZERO runtime dependency, and works on the Worker path too.
 *
 * It never parses — it scans lines for declaration-shaped patterns and records
 * `{ name, file, line, kind, exported }`. That is enough to answer, for the
 * symbols a diff touches, "here is where each is defined across the repo" as a
 * read-only prompt block. Flag-gated (`ctagsIndex`), default OFF (a whole-repo
 * scan costs read calls), and fully injectable/pure for offline tests.
 *
 * Never throws on repo I/O — a missing/unreadable file is skipped; bounded by
 * the same `AgenticCaps` + `AgenticUsage` budget as the import scan.
 */
import type { RepoReader } from "./agentic";
import type { AgenticCaps, AgenticUsage } from "./types";

/** A generous standalone budget for the whole-repo symbol scan (mirrors the
 *  import-scan caps: many small reads, hard-bounded by total bytes). */
export const DEFAULT_CTAGS_CAPS: Required<AgenticCaps> = {
  maxHops: 1,
  maxFileReads: 400,
  maxTotalBytes: 1024 * 1024,
};

export type SymbolKind = "function" | "class" | "method" | "const" | "interface" | "type" | "enum";

/** A single declaration the scan located. */
export interface SymbolDef {
  name: string;
  file: string;
  /** 1-based line of the declaration. */
  line: number;
  kind: SymbolKind;
  /** True when the declaration is visible outside its file (heuristic). */
  exported: boolean;
}

/** name → every place it is declared across the scanned tree. */
export type SymbolIndex = Map<string, SymbolDef[]>;

const TS_EXT = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i;
const PY_EXT = /\.py$/i;

/** True when the path is a language ctags-lite understands. */
export function isIndexableFile(path: string): boolean {
  return TS_EXT.test(path) || PY_EXT.test(path);
}

// ── TS/JS declaration patterns (each captures the declared name in group 1) ──
interface KindPattern {
  re: RegExp;
  kind: SymbolKind;
}

const TS_PATTERNS: readonly KindPattern[] = [
  { re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
  { re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  { re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
  { re: /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/, kind: "const" },
];

const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)/;
const PY_CLASS = /^(\s*)class\s+([A-Za-z_][\w]*)/;

function extractTsDefs(content: string, path: string): SymbolDef[] {
  const out: SymbolDef[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    for (const { re, kind } of TS_PATTERNS) {
      const m = re.exec(trimmed);
      if (m && m[1] && m[1].length > 1) {
        out.push({ name: m[1], file: path, line: i + 1, kind, exported: /^export\b/.test(trimmed) });
        break; // one declaration per line
      }
    }
  }
  return out;
}

function extractPyDefs(content: string, path: string): SymbolDef[] {
  const out: SymbolDef[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const def = PY_DEF.exec(line);
    if (def) {
      const indent = def[1].length;
      out.push({
        name: def[2],
        file: path,
        line: i + 1,
        // A def at column 0 is a module function; an indented one is a method.
        kind: indent === 0 ? "function" : "method",
        exported: indent === 0 && !def[2].startsWith("_"),
      });
      continue;
    }
    const cls = PY_CLASS.exec(line);
    if (cls) {
      out.push({
        name: cls[2],
        file: path,
        line: i + 1,
        kind: "class",
        exported: cls[1].length === 0 && !cls[2].startsWith("_"),
      });
    }
  }
  return out;
}

/** Extract declaration-shaped symbols from one file's content. Pure. */
export function extractSymbolDefs(content: string, path: string): SymbolDef[] {
  if (TS_EXT.test(path)) return extractTsDefs(content, path);
  if (PY_EXT.test(path)) return extractPyDefs(content, path);
  return [];
}

/**
 * Scan the whole repo tree ONCE, building a name → declarations index over
 * TS/JS/Python files. Budgeted via the shared usage counter (same contract as
 * `scanRepoImports`); never throws on I/O.
 */
export async function buildSymbolIndex(
  reader: RepoReader,
  caps: Required<AgenticCaps> = DEFAULT_CTAGS_CAPS,
  usage: AgenticUsage,
): Promise<SymbolIndex> {
  const index: SymbolIndex = new Map();
  let tree: string[];
  try {
    tree = await reader.listTree();
  } catch {
    tree = [];
  }
  for (const path of tree) {
    if (!isIndexableFile(path)) continue;
    if (usage.fileReads >= caps.maxFileReads || usage.bytesRead >= caps.maxTotalBytes) {
      usage.cappedOut = true;
      break;
    }
    let content: string | undefined;
    try {
      content = await reader.readFile(path);
    } catch {
      content = undefined;
    }
    if (content === undefined) continue;
    usage.fileReads += 1;
    usage.bytesRead += content.length;
    for (const def of extractSymbolDefs(content, path)) {
      const list = index.get(def.name);
      if (list) list.push(def);
      else index.set(def.name, [def]);
    }
  }
  return index;
}

/** Cap on definitions rendered into the {{SYMBOL_INDEX}} block. */
export const MAX_RENDERED_DEFS = 40;
/** Cap on definitions shown for any single symbol (avoid a common-name blowup). */
const MAX_DEFS_PER_SYMBOL = 4;
/** Default char cap on the rendered block. */
export const DEFAULT_SYMBOL_INDEX_MAX_CHARS = 2500;

/**
 * Render the {{SYMBOL_INDEX}} block: for each changed symbol NAME, where it is
 * declared across the repo, most-relevant kinds first. Read-only background —
 * NOT grounds for a finding. "(none)" when no changed name resolves. Pure.
 */
export function renderChangedSymbolDefs(
  index: SymbolIndex,
  names: readonly string[],
  opts: { maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? DEFAULT_SYMBOL_INDEX_MAX_CHARS;
  const seenName = new Set<string>();
  const lines: string[] = [];
  let chars = 0;
  let rendered = 0;
  let truncated = false;

  for (const name of names) {
    if (seenName.has(name)) continue;
    seenName.add(name);
    const defs = index.get(name);
    if (!defs || defs.length === 0) continue;
    const shown = defs.slice(0, MAX_DEFS_PER_SYMBOL);
    const locations = shown.map((d) => `${d.file}:${d.line} (${d.kind})`).join(", ");
    const more = defs.length > shown.length ? `, +${defs.length - shown.length} more` : "";
    const line = `- \`${name}\` — defined at ${locations}${more}`;
    if (rendered >= MAX_RENDERED_DEFS || chars + line.length > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    chars += line.length + 1;
    rendered += 1;
  }

  if (lines.length === 0) return "(none)";
  if (truncated) lines.push("- … (symbol index truncated at the cap)");
  return lines.join("\n");
}
