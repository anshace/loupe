/**
 * @code-review/scope-ts — tree-sitter (wasm) enclosing-scope expansion
 * behind the SAME `ScopeExpander` interface as the engine's regex heuristic
 * (task 6.2).
 *
 * WHY THIS LIVES OUTSIDE THE ENGINE: the engine has a zero-runtime-dependency
 * rule and must run on the Cloudflare Workers path; web-tree-sitter plus
 * per-language grammar .wasm files add real weight and need wasm loading from
 * a filesystem/bundle. So this package is used only where fs is available
 * (the Action path) and is injected via `RunDeps.scopeExpander`; the engine's
 * `RegexScopeExpander` remains the default everywhere.
 *
 * HONEST STATUS (task 6.2): this is the interface + loader + node-walk
 * implementation, with the regex heuristic as the guaranteed fallback. What
 * is intentionally NOT shipped:
 *   - `web-tree-sitter` itself is an OPTIONAL dependency and is loaded via
 *     dynamic import — if it is not installed, `createScopeExpander` returns
 *     the regex fallback.
 *   - Grammar .wasm files (tree-sitter-typescript.wasm / -tsx.wasm /
 *     -javascript.wasm) are NOT vendored into this repo. Distribution of
 *     prebuilt grammar wasm is the disproportionate part: they must either be
 *     built with emscripten via the tree-sitter CLI or pulled from the
 *     `tree-sitter-wasms` npm package, and either way they are multi-MB
 *     binaries this local-only project does not want checked in. To activate:
 *       1. `nub add web-tree-sitter` (already declared optional)
 *       2. `nub add -D tree-sitter-wasms` and pass
 *          `wasmDir: "node_modules/tree-sitter-wasms/out"` (files are named
 *          tree-sitter-<lang>.wasm) to `createScopeExpander`.
 *     With both present, `createScopeExpander` returns the tree-sitter
 *     expander; with either missing it silently returns the regex fallback,
 *     so callers never need to care.
 */
import { RegexScopeExpander } from "@code-review/engine";
import type { ScopeExpander, ScopeSpan } from "@code-review/engine";
import { existsSync } from "node:fs";
import * as path from "node:path";

/** Node types that constitute an enclosing scope, per grammar. */
const SCOPE_NODE_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "generator_function_declaration",
  "arrow_function",
  "method_definition",
  "class_declaration",
  "abstract_class_declaration",
  "class",
]);

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
};

export interface TreeSitterOptions {
  /** Directory containing tree-sitter-<lang>.wasm grammar files. */
  wasmDir: string;
}

interface ParserModule {
  Parser: typeof import("web-tree-sitter").Parser;
  Language: typeof import("web-tree-sitter").Language;
}

type LanguageInstance = import("web-tree-sitter").Language;

/** Tree-sitter implementation of the engine's ScopeExpander interface. */
export class TreeSitterScopeExpander implements ScopeExpander {
  readonly name = "tree-sitter";

  private constructor(
    private readonly mod: ParserModule,
    private readonly languages: Map<string, LanguageInstance>,
  ) {}

  /**
   * Load web-tree-sitter and the TS/JS grammars. Throws when the module or
   * every grammar is unavailable — use `createScopeExpander` for the
   * fall-back-to-regex behavior.
   */
  static async create(opts: TreeSitterOptions): Promise<TreeSitterScopeExpander> {
    const mod = (await import("web-tree-sitter")) as unknown as ParserModule;
    await mod.Parser.init();
    const languages = new Map<string, LanguageInstance>();
    for (const lang of new Set(Object.values(LANG_BY_EXT))) {
      const wasmPath = path.join(opts.wasmDir, `tree-sitter-${lang}.wasm`);
      if (!existsSync(wasmPath)) continue;
      languages.set(lang, await mod.Language.load(wasmPath));
    }
    if (languages.size === 0) {
      throw new Error(`no grammar .wasm files found in ${opts.wasmDir}`);
    }
    return new TreeSitterScopeExpander(mod, languages);
  }

  expand(content: string, filePath: string, startLine: number, endLine: number): ScopeSpan | undefined {
    const dot = filePath.lastIndexOf(".");
    const ext = dot === -1 ? "" : filePath.slice(dot + 1).toLowerCase();
    const language = this.languages.get(LANG_BY_EXT[ext] ?? "");
    if (!language) return undefined;

    try {
      const parser = new this.mod.Parser();
      parser.setLanguage(language);
      const tree = parser.parse(content);
      if (!tree) return undefined;
      // Rows are 0-based; span lines are 1-based inclusive.
      let node = tree.rootNode.namedDescendantForPosition(
        { row: startLine - 1, column: 0 },
        { row: Math.max(startLine, endLine) - 1, column: 0 },
      );
      for (let cur: typeof node | null = node; cur; cur = cur.parent) {
        if (SCOPE_NODE_TYPES.has(cur.type)) {
          return { startLine: cur.startPosition.row + 1, endLine: cur.endPosition.row + 1 };
        }
      }
      return undefined;
    } catch {
      return undefined; // parse failures must never break a review run
    }
  }
}

/**
 * The entry point adapters should use: tree-sitter when the optional module
 * and at least one grammar .wasm are available, otherwise the engine's regex
 * heuristic. Never throws.
 */
export async function createScopeExpander(opts?: Partial<TreeSitterOptions>): Promise<ScopeExpander> {
  try {
    return await TreeSitterScopeExpander.create({
      wasmDir: opts?.wasmDir ?? path.join("node_modules", "tree-sitter-wasms", "out"),
    });
  } catch {
    return new RegexScopeExpander();
  }
}
