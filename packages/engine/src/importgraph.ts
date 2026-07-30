/**
 * Cross-file recall (report item #8): catch bugs where a changed export breaks
 * its callers in OTHER files — the class of regression diff-only review is
 * structurally blind to.
 *
 * Two capabilities, both built from the SAME substrate the agentic loop already
 * has (`RepoReader.listTree` + `readFile`) and both TS/JS-focused with graceful
 * degradation to "nothing found" for other languages:
 *
 *   1. `find_importers(path)` — a reverse-import scan exposed as an agentic tool
 *      (see agentic.ts / guardrail.ts). Regex import/require matching, relative
 *      specifiers resolved against the importing file's directory, capped by the
 *      same hop/byte budgets as the rest of the agentic loop (AgenticCaps +
 *      AgenticUsage).
 *
 *   2. Forced signature-change caller injection — DETERMINISTICALLY detect when
 *      the diff changes an exported function/method signature (name kept,
 *      params/return changed) and FORCE-inject its call sites as labeled context
 *      into the reviewer prompt, rather than hoping the model greps for them.
 *      Wired into run.ts context assembly; capped in count and size, truncation
 *      disclosed in the summary.
 *
 * Pure + injectable: everything takes a RepoReader, caps, and a shared usage
 * counter, so it is fully testable offline with a mock reader. Never throws on
 * repo I/O — a missing/unreadable file is simply skipped.
 */
import type { DiffFile } from "./diff";
import type { RepoReader } from "./agentic";
import type { AgenticCaps, AgenticUsage } from "./types";

/** A sensible standalone budget for the deterministic whole-repo import scan.
 *  More generous on file reads than the agentic tool defaults (the scan must
 *  visit many files to find importers) but still hard-bounded by total bytes. */
export const DEFAULT_IMPORT_SCAN_CAPS: Required<AgenticCaps> = {
  maxHops: 1,
  maxFileReads: 400,
  maxTotalBytes: 1024 * 1024,
};

/** Cap on total call sites force-injected into the reviewer prompt. */
export const MAX_INJECTED_CALL_SITES = 15;
/** Cap on total characters of the injected cross-file-callers block. */
export const MAX_INJECTED_CHARS = 4000;
/** Cap on call-site lines collected per importing file. */
const MAX_CALL_SITES_PER_FILE = 5;

const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/i;

function isCodeFile(path: string): boolean {
  return CODE_EXT.test(path);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Resolve a relative import `spec` against `fromDir` (posix, no fs). */
function resolveRelative(fromDir: string, spec: string): string {
  const parts = fromDir ? fromDir.split("/") : [];
  const out = [...parts];
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** Normalize a path to a module key: strip a code extension and a trailing
 *  `/index`, so `src/a.ts`, `src/a`, and `src/a/index.ts` all compare equal. */
export function moduleKey(path: string): string {
  return path.replace(CODE_EXT, "").replace(/\/index$/, "");
}

const IMPORT_REGEXES: readonly RegExp[] = [
  // import ... from '...'  /  export ... from '...'
  /\b(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // side-effect import '...'
  /\bimport\s*['"]([^'"]+)['"]/g,
  // require('...')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // dynamic import('...')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** All RELATIVE import specifiers in a TS/JS source file (bare/npm specifiers,
 *  which cannot resolve to a repo file, are ignored). */
export function parseImportSpecifiers(content: string): string[] {
  const specs = new Set<string>();
  for (const re of IMPORT_REGEXES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      if (spec.startsWith(".")) specs.add(spec);
    }
  }
  return [...specs];
}

/** The module key a relative `spec` in `importerPath` resolves to, or undefined
 *  for non-relative (npm) specifiers. */
export function resolveSpecToModuleKey(importerPath: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  return moduleKey(resolveRelative(dirname(importerPath), spec));
}

/** A whole-repo import scan: which module keys each file imports, plus a content
 *  cache (bounded by the byte cap) reused for call-site extraction. */
export interface RepoImportScan {
  /** importerPath → module keys it imports (relative imports only). */
  importsByFile: Map<string, string[]>;
  /** content of every code file read, for call-site extraction. */
  contents: Map<string, string>;
  /** True when a read/byte cap stopped the scan (result may be incomplete). */
  cappedOut: boolean;
}

/** Scan the whole repo tree ONCE, recording each code file's relative imports.
 *  Budgeted via the shared usage counter; never throws on I/O. */
export async function scanRepoImports(
  reader: RepoReader,
  caps: Required<AgenticCaps>,
  usage: AgenticUsage,
): Promise<RepoImportScan> {
  const importsByFile = new Map<string, string[]>();
  const contents = new Map<string, string>();
  let tree: string[];
  try {
    tree = await reader.listTree();
  } catch {
    tree = [];
  }
  for (const path of tree) {
    if (!isCodeFile(path)) continue;
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
    contents.set(path, content);
    const keys: string[] = [];
    for (const spec of parseImportSpecifiers(content)) {
      const key = resolveSpecToModuleKey(path, spec);
      if (key !== undefined) keys.push(key);
    }
    importsByFile.set(path, keys);
  }
  return { importsByFile, contents, cappedOut: usage.cappedOut };
}

/** A call-site-like reference to a changed symbol in an importing file. */
export interface CallSite {
  file: string;
  /** 1-based line number. */
  line: number;
  /** Trimmed line text (capped). */
  text: string;
}

/** A file that imports the target, with any call sites of the changed symbol. */
export interface Importer {
  path: string;
  /** True when the file textually references (calls or names) a changed symbol. */
  referencesSymbol: boolean;
  /** Call-site lines matching a changed symbol (empty unless symbols supplied). */
  callSites: CallSite[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractCallSites(file: string, content: string, symbols: readonly string[]): CallSite[] {
  const alt = symbols.map(escapeRe).join("|");
  const callRe = new RegExp(`\\b(?:${alt})\\s*\\(`);
  const sites: CallSite[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && sites.length < MAX_CALL_SITES_PER_FILE; i++) {
    if (callRe.test(lines[i])) sites.push({ file, line: i + 1, text: lines[i].trim().slice(0, 200) });
  }
  return sites;
}

/** Filter a completed scan to the files importing `targetPath` (pure). */
export function importersFromScan(
  scan: RepoImportScan,
  targetPath: string,
  symbols?: readonly string[],
): Importer[] {
  const targetKey = moduleKey(targetPath);
  const nameRe =
    symbols && symbols.length > 0
      ? new RegExp(`\\b(?:${symbols.map(escapeRe).join("|")})\\b`)
      : undefined;
  const out: Importer[] = [];
  for (const [file, keys] of scan.importsByFile) {
    if (file === targetPath) continue;
    if (!keys.includes(targetKey)) continue;
    const content = scan.contents.get(file) ?? "";
    const callSites = symbols && symbols.length > 0 ? extractCallSites(file, content, symbols) : [];
    const referencesSymbol = callSites.length > 0 || (nameRe ? nameRe.test(content) : false);
    out.push({ path: file, referencesSymbol, callSites });
  }
  out.sort(
    (a, b) => Number(b.referencesSymbol) - Number(a.referencesSymbol) || a.path.localeCompare(b.path),
  );
  return out;
}

/**
 * Blast-radius counts (report item #19): for each target path, how many OTHER
 * files in a completed scan import it. Pure — the caller runs the scan once and
 * reuses it. Feeds escalate.highBlastRadiusPaths.
 */
export function countImporters(
  scan: RepoImportScan,
  targetPaths: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of targetPaths) {
    counts.set(path, importersFromScan(scan, path).length);
  }
  return counts;
}

/**
 * Reverse-import lookup for the `find_importers` agentic tool: which files
 * import `targetPath`. Scans the whole tree under the shared caps/usage. When
 * `symbols` are given, importers referencing those symbols are ranked first and
 * carry their call sites.
 */
export async function findImporters(
  targetPath: string,
  reader: RepoReader,
  caps: Required<AgenticCaps>,
  usage: AgenticUsage,
  symbols?: readonly string[],
): Promise<Importer[]> {
  const scan = await scanRepoImports(reader, caps, usage);
  return importersFromScan(scan, targetPath, symbols);
}

// ── Signature-change detection ──────────────────────────────────────────────

/** An exported/declared symbol whose signature changed in the diff. */
export interface SignatureChange {
  file: string;
  symbol: string;
  /** Normalized signature before the change (params + optional return type). */
  before: string;
  /** Normalized signature after the change. */
  after: string;
}

const METHOD_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "await",
  "typeof",
  "new",
  "do",
  "else",
]);

interface DeclSig {
  name: string;
  sig: string;
}

/** Keep only the parameter/return portion of a declaration tail: cut at the
 *  body opener (`{`) or arrow (`=>`), then collapse whitespace. */
function normalizeSig(tail: string): string {
  const arrow = tail.indexOf("=>");
  const brace = tail.indexOf("{");
  let cut = tail.length;
  if (arrow !== -1) cut = Math.min(cut, arrow);
  if (brace !== -1) cut = Math.min(cut, brace);
  return tail.slice(0, cut).replace(/\s+/g, " ").trim();
}

const FN_DECL = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(\(.*)$/;
const VAR_DECL = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(.+)$/;
const VAR_RHS_FN = /^(?:async\s+)?(?:function\b\s*\*?\s*[A-Za-z_$]*\s*)?(\(.*)$/;
// Guarded method form: requires at least one modifier keyword so a plain
// function CALL (`foo(1)`) can never be mistaken for a declaration.
const METHOD_DECL = /^(?:(?:public|private|protected|static|override|abstract|readonly|async|get|set)\s+)+([A-Za-z_$][\w$]*)\s*(\(.*)$/;

/** Parse a single (trimmed) source line as a signature declaration, or undefined. */
export function extractDecl(rawLine: string): DeclSig | undefined {
  const line = rawLine.trim();

  const fn = FN_DECL.exec(line);
  if (fn) return { name: fn[1], sig: normalizeSig(fn[2]) };

  const varm = VAR_DECL.exec(line);
  if (varm) {
    const rhs = varm[2];
    const rhsFn = VAR_RHS_FN.exec(rhs);
    if (rhsFn && (rhs.includes("=>") || /^(?:async\s+)?function\b/.test(rhs))) {
      return { name: varm[1], sig: normalizeSig(rhsFn[1]) };
    }
    return undefined;
  }

  const method = METHOD_DECL.exec(line);
  if (method && !METHOD_KEYWORDS.has(method[1])) {
    return { name: method[1], sig: normalizeSig(method[2]) };
  }
  return undefined;
}

/**
 * Detect exported/declared function or method signatures whose SHAPE changed in
 * the diff (same name present on both a removed and an added line, but different
 * normalized signature). TS/JS only; other files yield nothing.
 *
 * Known limitation (accepted): a declaration whose parameter list spans multiple
 * lines is only detected when the change lands on the declaration's first line.
 */
export function detectSignatureChanges(files: readonly DiffFile[]): SignatureChange[] {
  const out: SignatureChange[] = [];
  for (const file of files) {
    if (!isCodeFile(file.path) || file.isBinary || file.status === "deleted") continue;
    const removed = new Map<string, string>();
    const added = new Map<string, string>();
    for (const hunk of file.hunks) {
      for (const l of hunk.lines) {
        if (l.type === "del") {
          const d = extractDecl(l.content);
          if (d && !removed.has(d.name)) removed.set(d.name, d.sig);
        } else if (l.type === "add") {
          const d = extractDecl(l.content);
          if (d && !added.has(d.name)) added.set(d.name, d.sig);
        }
      }
    }
    for (const [name, beforeSig] of removed) {
      const afterSig = added.get(name);
      if (afterSig !== undefined && afterSig !== beforeSig) {
        out.push({ file: file.path, symbol: name, before: beforeSig, after: afterSig });
      }
    }
  }
  return out;
}

// ── Forced caller injection ─────────────────────────────────────────────────

/** The result of the deterministic caller-injection pass. */
export interface InjectedCallers {
  /** Labeled prompt block, or "" when nothing was found. */
  text: string;
  /** True when a cap (scan budget, site count, or char size) truncated output. */
  truncated: boolean;
  /** Signature changes that actually produced injected call sites. */
  changes: SignatureChange[];
}

const CROSS_FILE_HEADER =
  "### Cross-file callers of changed signatures (deterministic import-graph scan)\n\n" +
  "An exported function/method signature changed in this PR. Below are its call\n" +
  "sites in OTHER files that import it. Check whether each caller still matches the\n" +
  "NEW signature; if a caller was not updated, report it as a finding anchored to\n" +
  "the changed signature line in the diff.";

function renderChangeBlock(change: SignatureChange, sites: readonly CallSite[]): string {
  const lines = [
    `**\`${change.symbol}\` in \`${change.file}\`** — signature changed:`,
    `- before: \`${change.before}\``,
    `- after:  \`${change.after}\``,
    "",
    "Call sites in other files:",
    ...sites.map((s) => `- \`${s.file}:${s.line}\`: \`${s.text}\``),
  ];
  return lines.join("\n");
}

/**
 * Detect signature changes, find their call sites across the repo, and render a
 * labeled context block for the reviewer prompt — capped and truncation-aware.
 * Uses one whole-repo scan for all changes. Never throws.
 */
export async function collectSignatureChangeCallers(
  files: readonly DiffFile[],
  reader: RepoReader,
  caps: Required<AgenticCaps>,
  usage: AgenticUsage,
  opts: { maxCallSites?: number; maxChars?: number } = {},
): Promise<InjectedCallers> {
  const changes = detectSignatureChanges(files);
  if (changes.length === 0) return { text: "", truncated: false, changes: [] };

  const maxSites = opts.maxCallSites ?? MAX_INJECTED_CALL_SITES;
  const maxChars = opts.maxChars ?? MAX_INJECTED_CHARS;
  const scan = await scanRepoImports(reader, caps, usage);
  const changedPaths = new Set(files.map((f) => f.path));

  const blocks: string[] = [];
  const used: SignatureChange[] = [];
  let siteCount = 0;
  let chars = 0;
  let truncated = scan.cappedOut;

  for (const change of changes) {
    if (siteCount >= maxSites) {
      truncated = true;
      break;
    }
    const importers = importersFromScan(scan, change.file, [change.symbol]).filter(
      (i) => i.referencesSymbol && !changedPaths.has(i.path),
    );
    const sites: CallSite[] = [];
    let cappedThisChange = false;
    for (const imp of importers) {
      for (const s of imp.callSites) {
        if (siteCount >= maxSites) {
          cappedThisChange = true;
          break;
        }
        sites.push(s);
        siteCount += 1;
      }
      if (cappedThisChange) break;
    }
    if (cappedThisChange) truncated = true;
    if (sites.length === 0) continue;
    const block = renderChangeBlock(change, sites);
    if (chars + block.length > maxChars) {
      truncated = true;
      continue;
    }
    blocks.push(block);
    chars += block.length + 2;
    used.push(change);
  }

  const text = blocks.length > 0 ? [CROSS_FILE_HEADER, ...blocks].join("\n\n") : "";
  return { text, truncated, changes: used };
}
