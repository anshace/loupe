/**
 * TS language-service interface (report item #33) — the engine-side CONTRACT the
 * agentic tool loop and the optional semantic-diagnostics pre-pass consume,
 * with ZERO runtime dependency on `typescript`.
 *
 * WHY THIS LIVES IN THE ENGINE (as an interface, not an implementation): the
 * engine has a hard zero-runtime-dependency rule and must run on the Cloudflare
 * Workers path, where `typescript` (a multi-MB dependency that reads lib.d.ts
 * from a filesystem) cannot go. So the real, in-memory `ts.LanguageService`
 * implementation lives OUTSIDE the engine in `packages/ts-symbols` (which alone
 * declares `typescript`) and is injected via `RunDeps.symbolService`, exactly
 * like `packages/scope-ts`'s tree-sitter `ScopeExpander`. The engine only ever
 * sees this interface; tests inject a mock; absence (no service injected, e.g.
 * on the Worker path or when `typescript` is not installed) is a clean no-op —
 * the symbol tools are simply not offered and no diagnostics are produced.
 *
 * Two capabilities, both TS/JS-focused and fail-soft:
 *   1. `findDefinition` / `findReferences` / `hover` — real language-service
 *      queries exposed as capped agentic tools (see agentic.ts / guardrail.ts),
 *      gated behind the `tsSymbols` flag. Higher-signal than a regex grep: a
 *      rename/overload resolves to the true declaration and its real callers.
 *   2. Semantic diagnostics as ZERO-HALLUCINATION findings — a `tsc --noEmit`-
 *      style pass whose compiler-verified errors (filtered to the PR's ADDED
 *      lines, and stripped of program-incompleteness artifacts because there is
 *      no node_modules on the no-checkout path) become deterministic findings,
 *      gated behind the `tsDiagnostics` flag.
 */
import type { Finding, Severity } from "./types";

/**
 * Where in a file to run a symbol query. The model supplies a `symbol` NAME
 * (and optionally the 1-based `line` to disambiguate which occurrence) rather
 * than a raw character offset — line:column is error-prone for an LLM, so the
 * implementation resolves the name to a position itself.
 */
export interface SymbolQuery {
  /** Repo-relative path of the file the symbol appears in. */
  path: string;
  /** Identifier name to locate (first occurrence, optionally on `line`). */
  symbol: string;
  /** Optional 1-based line to disambiguate which occurrence of `symbol`. */
  line?: number;
}

/** A resolved code location (definition site, reference, etc.). */
export interface SymbolRef {
  /** Repo-relative path when the location is an in-repo file; otherwise a label
   *  such as "lib.es2022.d.ts (external)" for standard-library targets. */
  path: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** Trimmed source line text at the location (capped). */
  text: string;
}

/** One compiler diagnostic, provider-neutral. */
export interface SymbolDiagnostic {
  /** Repo-relative path of the diagnostic's file. */
  path: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  category: "error" | "warning" | "suggestion" | "message";
  /** The TS diagnostic code (e.g. 2554 for an arg-count mismatch). */
  code: number;
  /** Flattened human-readable message. */
  message: string;
}

/**
 * The injected language-service contract. Every method is async (the real
 * implementation lazily loads the PR-head file set via a RepoReader on first
 * use) and must NEVER throw — a failure returns an empty result so the engine
 * is unaffected.
 */
export interface SymbolService {
  /** Definition location(s) of the queried symbol; [] when unresolved. */
  findDefinition(query: SymbolQuery): Promise<SymbolRef[]>;
  /** Reference location(s) across files of the queried symbol; [] when none. */
  findReferences(query: SymbolQuery): Promise<SymbolRef[]>;
  /** Hover / quick-info text for the queried symbol; undefined when none. */
  hover(query: SymbolQuery): Promise<string | undefined>;
  /**
   * Semantic + syntactic diagnostics for the given repo-relative paths (or all
   * loaded files when omitted). Raw — the engine applies the noise/added-line
   * filtering in `diagnosticsToFindings`.
   */
  getDiagnostics(paths?: readonly string[]): Promise<SymbolDiagnostic[]>;
}

/** A do-nothing SymbolService: every query is empty. Used when no real service
 *  is available so callers never branch on undefined. Never throws. */
export const NOOP_SYMBOL_SERVICE: SymbolService = {
  findDefinition: async () => [],
  findReferences: async () => [],
  hover: async () => undefined,
  getDiagnostics: async () => [],
};

/**
 * TS diagnostic codes that are ARTIFACTS of the no-checkout / no-node_modules
 * in-memory program rather than real defects in the PR: unresolved third-party
 * modules, missing ambient globals, absent @types, implicit-any from a missing
 * declaration file. Surfacing these would cry wolf (there is no node_modules to
 * resolve against), so `diagnosticsToFindings` drops them. Genuinely local
 * errors — arg-count/type mismatches, unknown properties on in-repo types — are
 * kept: those are exactly the cross-file breakage this feature exists to catch.
 */
export const PROGRAM_INCOMPLETE_DIAGNOSTIC_CODES: ReadonlySet<number> = new Set([
  2304, // Cannot find name 'X' (missing ambient global / lib)
  2307, // Cannot find module 'X' or its type declarations
  2503, // Cannot find namespace 'X'
  2580, // Cannot find name 'require'/'module'/'process' (@types/node not present)
  2591, // Cannot use 'import' outside a module (config-dependent)
  2688, // Cannot find type definition file for 'X'
  2691, // An import path cannot end with a '.ts' extension
  2792, // Cannot find module 'X'. Did you mean to set 'moduleResolution'?
  7016, // Could not find a declaration file for module 'X' (implicit any)
  7026, // JSX element implicitly has type 'any' (missing JSX types)
]);

const DIAGNOSTIC_SEVERITY: Record<SymbolDiagnostic["category"], Severity> = {
  error: "high",
  warning: "medium",
  suggestion: "low",
  message: "low",
};

/** Options for turning diagnostics into findings. */
export interface DiagnosticsToFindingsOptions {
  /**
   * Only diagnostics on ADDED lines are surfaced (this is the PR's change; a
   * pre-existing type error elsewhere is not this PR's concern and would be
   * noise). Keyed by repo-relative path → the set/list of added new-side lines.
   */
  addedLines: Record<string, readonly number[]>;
  /** Lowest category kept. Default "warning" (drops suggestion/message noise). */
  minCategory?: SymbolDiagnostic["category"];
}

const CATEGORY_RANK: Record<SymbolDiagnostic["category"], number> = {
  error: 3,
  warning: 2,
  suggestion: 1,
  message: 0,
};

/**
 * Map compiler diagnostics to deterministic, zero-hallucination Findings: keep
 * only diagnostics that land on an ADDED line, are not program-incompleteness
 * artifacts, and meet the minimum category; dedupe by (file, line, code). Pure.
 */
export function diagnosticsToFindings(
  diagnostics: readonly SymbolDiagnostic[],
  opts: DiagnosticsToFindingsOptions,
): Finding[] {
  const addedByPath = new Map<string, Set<number>>();
  for (const [path, lines] of Object.entries(opts.addedLines)) {
    addedByPath.set(path, new Set(lines));
  }
  const minRank = CATEGORY_RANK[opts.minCategory ?? "warning"];
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const d of diagnostics) {
    if (CATEGORY_RANK[d.category] < minRank) continue;
    if (PROGRAM_INCOMPLETE_DIAGNOSTIC_CODES.has(d.code)) continue;
    const added = addedByPath.get(d.path);
    if (!added || !added.has(d.line)) continue;
    const key = `${d.path}:${d.line}:${d.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const firstLine = d.message.split("\n")[0].slice(0, 120);
    findings.push({
      severity: DIAGNOSTIC_SEVERITY[d.category],
      category: "type-error",
      file: d.path,
      line: d.line,
      title: `TS${d.code}: ${firstLine}`,
      body:
        `The TypeScript compiler reports this on the changed line ` +
        `(\`${d.path}:${d.line}\`): ${d.message}\n\n` +
        `This is a compiler-verified diagnostic from an in-memory \`tsc --noEmit\` ` +
        `over the PR-head files (no third-party \`node_modules\`), so treat it as ground truth.`,
    });
  }
  return findings;
}
