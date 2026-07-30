/**
 * Ranked repo-map priming (rounding-out context item; research
 * context-retrieval.md §10, Aider's repo map scoped WAY down).
 *
 * A concise, ambient "what does this repository look like and what does the
 * changed code expose" block, injected as {{REPO_MAP}} so a large or
 * unfamiliar-to-the-model PR has a structural frame before it starts reasoning.
 * Deliberately smaller than Aider's PageRank-over-the-whole-repo map — the
 * project already rejected building a persistent index — this is:
 *
 *   1. top directories by file count (a one-line structural sketch from the
 *      already-cached `RepoReader.listTree()`), and
 *   2. the KEY EXPORTED symbols declared in the CHANGED files (extracted with
 *      the same ctags-lite primitive, so no extra repo scan is needed — the
 *      changed files' head content is already fetched for enclosing-scope).
 *
 * Read-only background, never grounds for a finding. Flag-gated (`repoMap`),
 * default OFF, and hard-capped in size. Pure + fully offline-testable.
 */
import { extractSymbolDefs } from "./ctags";

export const DEFAULT_REPO_MAP_MAX_CHARS = 2000;
/** How many top directories to list. */
const DEFAULT_TOP_DIRS = 8;
/** Cap on exported symbols shown per changed file. */
const MAX_EXPORTS_PER_FILE = 10;

export interface DirEntry {
  /** Top-level directory name, or "(root)" for files at the repo root. */
  dir: string;
  /** Number of blobs under it. */
  count: number;
}

export interface ChangedFileContent {
  path: string;
  content: string;
}

export interface RepoMap {
  dirs: DirEntry[];
  exported: Array<{ file: string; symbols: string[] }>;
}

/**
 * Count blobs per top-level directory, ranked by count desc (name asc on ties).
 * Files at the repo root are bucketed under "(root)". Pure.
 */
export function topDirectories(tree: readonly string[], opts: { top?: number } = {}): DirEntry[] {
  const counts = new Map<string, number>();
  for (const path of tree) {
    const slash = path.indexOf("/");
    const dir = slash === -1 ? "(root)" : path.slice(0, slash);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
    .slice(0, opts.top ?? DEFAULT_TOP_DIRS);
}

/** Exported symbol names declared in one changed file (deduped, capped). Pure. */
export function exportedSymbolsOf(file: ChangedFileContent): string[] {
  const seen = new Set<string>();
  for (const def of extractSymbolDefs(file.content, file.path)) {
    if (def.exported) seen.add(def.name);
    if (seen.size >= MAX_EXPORTS_PER_FILE) break;
  }
  return [...seen];
}

/** Build the repo map from the tree + the changed files' head content. Pure. */
export function buildRepoMap(
  input: { tree: readonly string[]; changedFiles: readonly ChangedFileContent[] },
  opts: { topDirs?: number } = {},
): RepoMap {
  const exported: RepoMap["exported"] = [];
  for (const file of input.changedFiles) {
    const symbols = exportedSymbolsOf(file);
    if (symbols.length > 0) exported.push({ file: file.path, symbols });
  }
  return { dirs: topDirectories(input.tree, { top: opts.topDirs }), exported };
}

/**
 * Render the {{REPO_MAP}} block, hard-capped at `maxChars`. "(none)" when the
 * map has neither structure nor exported symbols to show. Pure.
 */
export function renderRepoMap(map: RepoMap, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_REPO_MAP_MAX_CHARS;
  const sections: string[] = [];

  if (map.dirs.length > 0) {
    const rows = map.dirs.map((d) => `- ${d.dir === "(root)" ? d.dir : `${d.dir}/`} (${d.count} file(s))`);
    sections.push(`Top-level structure:\n${rows.join("\n")}`);
  }
  if (map.exported.length > 0) {
    const rows = map.exported.map((e) => `- ${e.file}: ${e.symbols.join(", ")}`);
    sections.push(`Key exported symbols in changed files:\n${rows.join("\n")}`);
  }

  if (sections.length === 0) return "(none)";
  let out = sections.join("\n\n");
  if (out.length > maxChars) {
    out = out.slice(0, maxChars).replace(/\n[^\n]*$/, "") + "\n- … (repo map truncated at the cap)";
  }
  return out;
}
