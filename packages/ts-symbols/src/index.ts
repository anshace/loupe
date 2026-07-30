/**
 * @code-review/ts-symbols — a real, in-memory `ts.LanguageService` over the
 * PR-head TypeScript/JavaScript files, behind the engine's `SymbolService`
 * interface (report item #33).
 *
 * WHY THIS LIVES OUTSIDE THE ENGINE: the engine has a zero-runtime-dependency
 * rule and must run on the Cloudflare Workers path. `typescript` is a multi-MB
 * dependency that reads `lib.d.ts` from a filesystem, so it cannot go in the
 * engine. This package alone declares `typescript`; the Action adapter builds a
 * service over a `RepoReader` and injects it via `RunDeps.symbolService`,
 * exactly like packages/scope-ts's tree-sitter `ScopeExpander`. The engine only
 * ever sees the interface; the Worker path simply injects nothing.
 *
 * NO CHECKOUT, NO EXECUTION: files are fetched read-only through the injected
 * `RepoReader` (the same contents/tree API the agentic loop uses) into an
 * in-memory `LanguageServiceHost`. PR code is never written to disk or run. The
 * only disk reads are TypeScript's own bundled `lib.*.d.ts` (falling back to
 * `ts.sys`). Because there is no `node_modules`, third-party imports do not
 * resolve — the engine's `diagnosticsToFindings` strips those program-
 * incompleteness diagnostics so only genuinely local errors surface.
 *
 * Everything is fail-soft: any query error returns an empty result, so a broken
 * lookup never breaks a review run.
 */
import * as ts from "typescript";
import type {
  RepoReader,
  SymbolDiagnostic,
  SymbolQuery,
  SymbolRef,
  SymbolService,
} from "@code-review/engine";

/** TS/JS extensions loaded into the in-memory program. */
const CODE_EXT = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i;

export interface TsSymbolOptions {
  /** Max number of code files loaded into the program. Default 2000. */
  maxFiles?: number;
  /** Max total bytes of source loaded. Default 12 MiB. */
  maxTotalBytes?: number;
  /** Compiler-option overrides merged onto the lenient defaults. */
  compilerOptions?: ts.CompilerOptions;
}

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_TOTAL_BYTES = 12 * 1024 * 1024;

/** Lenient defaults: allow JS, don't type-check JS (avoids noise), don't emit. */
const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10 ?? ts.ModuleResolutionKind.NodeJs,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  jsx: ts.JsxEmit.Preserve,
};

/** Repo-relative → internal absolute-ish path (single leading slash, posix). */
function toInternal(p: string): string {
  return "/" + p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mapCategory(c: ts.DiagnosticCategory): SymbolDiagnostic["category"] {
  switch (c) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    default:
      return "message";
  }
}

interface Entry {
  text: string;
  version: string;
}

/**
 * Build a `SymbolService` backed by an in-memory `ts.LanguageService`. The file
 * set is loaded lazily from `reader` on the first query and cached. Never
 * throws from its query methods.
 */
export function createSymbolService(reader: RepoReader, opts: TsSymbolOptions = {}): SymbolService {
  const compilerOptions: ts.CompilerOptions = { ...DEFAULT_COMPILER_OPTIONS, ...opts.compilerOptions };
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const files = new Map<string, Entry>(); // key: internal path
  // Virtual directories that "exist" so module resolution walks the in-memory
  // tree (ts.sys would report our virtual /src etc. as absent on the real disk,
  // aborting relative-import resolution).
  const virtualDirs = new Set<string>(["/"]);
  let service: ts.LanguageService | undefined;
  let loadPromise: Promise<void> | undefined;

  function addAncestorDirs(internalPath: string): void {
    let d = internalPath;
    for (;;) {
      const i = d.lastIndexOf("/");
      if (i <= 0) {
        virtualDirs.add("/");
        return;
      }
      d = d.slice(0, i);
      virtualDirs.add(d);
    }
  }

  function normDir(d: string): string {
    return d.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  }

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (f) => files.get(f)?.version ?? "1",
    getScriptSnapshot: (f) => {
      const e = files.get(f);
      if (e) return ts.ScriptSnapshot.fromString(e.text);
      // lib.*.d.ts and other TypeScript-bundled files resolve from disk.
      const disk = ts.sys.readFile(f);
      return disk !== undefined ? ts.ScriptSnapshot.fromString(disk) : undefined;
    },
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    useCaseSensitiveFileNames: () => true,
    realpath: (p) => p,
    fileExists: (f) => files.has(f) || ts.sys.fileExists(f),
    readFile: (f) => files.get(f)?.text ?? ts.sys.readFile(f),
    readDirectory: ts.sys.readDirectory,
    directoryExists: (d) => virtualDirs.has(normDir(d)) || ts.sys.directoryExists(d),
    getDirectories: (d) => {
      try {
        return ts.sys.getDirectories(d);
      } catch {
        return [];
      }
    },
  };

  async function load(): Promise<void> {
    let tree: string[];
    try {
      tree = await reader.listTree();
    } catch {
      tree = [];
    }
    let bytes = 0;
    for (const p of tree) {
      if (!CODE_EXT.test(p)) continue;
      if (files.size >= maxFiles || bytes >= maxTotalBytes) break;
      let content: string | undefined;
      try {
        content = await reader.readFile(p);
      } catch {
        content = undefined;
      }
      if (content === undefined) continue;
      bytes += content.length;
      const internal = toInternal(p);
      files.set(internal, { text: content, version: "1" });
      addAncestorDirs(internal);
    }
    service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  function ensureLoaded(): Promise<void> {
    if (!loadPromise) loadPromise = load();
    return loadPromise;
  }

  function sourceText(internalPath: string): string | undefined {
    const e = files.get(internalPath);
    if (e) return e.text;
    return service?.getProgram()?.getSourceFile(internalPath)?.text;
  }

  /** Offset of the `symbol` identifier in `text` (optionally on 1-based `line`). */
  function offsetOfSymbol(text: string, symbol: string, line?: number): number | undefined {
    const re = new RegExp(`\\b${escapeRe(symbol)}\\b`);
    if (line !== undefined) {
      const starts = lineStarts(text);
      const idx = line - 1;
      if (idx < 0 || idx >= starts.length) return undefined;
      const start = starts[idx];
      const end = idx + 1 < starts.length ? starts[idx + 1] : text.length;
      const m = re.exec(text.slice(start, end));
      return m ? start + m.index : undefined;
    }
    const m = re.exec(text);
    return m ? m.index : undefined;
  }

  /** How a returned file location is shown: repo-relative for in-repo files,
   *  a "(external)" basename label for standard-library / disk files. */
  function displayPath(fileName: string): string {
    if (files.has(fileName)) return fileName.replace(/^\/+/, "");
    const base = fileName.split(/[\\/]/).pop() ?? fileName;
    return `${base} (external)`;
  }

  function toRef(fileName: string, start: number): SymbolRef {
    const text = sourceText(fileName) ?? "";
    const starts = lineStarts(text);
    const line = lineOfOffset(starts, start);
    const column = start - starts[line];
    const lineText = text
      .slice(starts[line], line + 1 < starts.length ? starts[line + 1] : text.length)
      .replace(/\r?\n$/, "");
    return {
      path: displayPath(fileName),
      line: line + 1,
      column: column + 1,
      text: lineText.trim().slice(0, 200),
    };
  }

  function resolve(query: SymbolQuery): { file: string; pos: number } | undefined {
    const file = toInternal(query.path);
    const text = sourceText(file);
    if (text === undefined) return undefined;
    const pos = offsetOfSymbol(text, query.symbol, query.line);
    if (pos === undefined) return undefined;
    return { file, pos };
  }

  return {
    async findDefinition(query: SymbolQuery): Promise<SymbolRef[]> {
      try {
        await ensureLoaded();
        const r = resolve(query);
        if (!r || !service) return [];
        const defs = service.getDefinitionAtPosition(r.file, r.pos) ?? [];
        return defs.map((d) => toRef(d.fileName, d.textSpan.start));
      } catch {
        return [];
      }
    },

    async findReferences(query: SymbolQuery): Promise<SymbolRef[]> {
      try {
        await ensureLoaded();
        const r = resolve(query);
        if (!r || !service) return [];
        const refs = service.getReferencesAtPosition(r.file, r.pos) ?? [];
        return refs.map((e) => toRef(e.fileName, e.textSpan.start));
      } catch {
        return [];
      }
    },

    async hover(query: SymbolQuery): Promise<string | undefined> {
      try {
        await ensureLoaded();
        const r = resolve(query);
        if (!r || !service) return undefined;
        const info = service.getQuickInfoAtPosition(r.file, r.pos);
        if (!info) return undefined;
        const sig = ts.displayPartsToString(info.displayParts);
        const doc = info.documentation?.length ? ts.displayPartsToString(info.documentation) : "";
        const out = doc ? `${sig}\n\n${doc}` : sig;
        return out.trim().length > 0 ? out : undefined;
      } catch {
        return undefined;
      }
    },

    async getDiagnostics(paths?: readonly string[]): Promise<SymbolDiagnostic[]> {
      try {
        await ensureLoaded();
        if (!service) return [];
        const targets =
          paths && paths.length > 0
            ? paths.map(toInternal).filter((p) => files.has(p))
            : [...files.keys()];
        const out: SymbolDiagnostic[] = [];
        for (const fileName of targets) {
          const diags = [
            ...service.getSyntacticDiagnostics(fileName),
            ...service.getSemanticDiagnostics(fileName),
          ];
          for (const d of diags) {
            let line = 1;
            let column = 1;
            if (d.file && typeof d.start === "number") {
              const lc = d.file.getLineAndCharacterOfPosition(d.start);
              line = lc.line + 1;
              column = lc.character + 1;
            }
            out.push({
              path: displayPath(fileName),
              line,
              column,
              category: mapCategory(d.category),
              code: d.code,
              message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
            });
          }
        }
        return out;
      } catch {
        return [];
      }
    },
  };
}

// ── Small pure line helpers (avoid depending on a SourceFile just for math) ──

/** Offsets at which each line starts (index 0 = offset 0). */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 0-based line index containing `offset`, given precomputed line starts. */
function lineOfOffset(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
