/**
 * Related-tests discovery (report item #17).
 *
 * For each changed SOURCE file, deterministically find its sibling test file(s)
 * — `foo.test.ts`, `foo.spec.ts`, `__tests__/foo.*`, a mirrored `test(s)/`
 * path, or Python's `test_foo.py` — by string-matching the repo tree
 * (RepoReader.listTree(), already fetched once per run) rather than probing
 * candidate paths one 404 at a time. Matched test files are read once (capped)
 * and grepped for the names of the symbols the diff changed, so the block can
 * say "references bar()" rather than just "found".
 *
 * The result feeds the reviewer's {{RELATED_TESTS}} block: it lets the model
 * judge whether changed behavior is covered and — per the rubric line — note a
 * coverage gap FACTUALLY (not as an "add tests" nag). Deterministic, no LLM.
 *
 * Fail-soft: a failed tree/read yields fewer (or no) results and never throws.
 * May default ON: with no matches it renders "(none)", adding no prompt noise.
 */
import type { RepoReader } from "./agentic";

/** A changed source file plus the symbol names the diff added/changed in it. */
export interface RelatedTestsInput {
  /** Source file path (new side). */
  path: string;
  /** Changed/added symbol names, for a light "references X" check. */
  symbols: string[];
}

/** A source file's discovered sibling tests. */
export interface RelatedTestFinding {
  source: string;
  tests: Array<{ path: string; referencedSymbols: string[] }>;
  /** True when the file changed real symbols but no sibling test was found. */
  coverageGap: boolean;
}

// A path that looks like a test file: a `.test`/`.spec` suffix, a `__tests__` /
// `test(s)` / `spec` directory, or a leading `test_` (Python).
const TEST_PATH_RE =
  /(^|\/)(?:__tests__|tests?|spec)\/|[._-](?:test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]*\.py$/i;

const CODE_EXT_RE = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|py|go|rb)$/i;

/** True when the path is itself a test file (so we don't seek tests for tests). */
export function isTestFile(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

/**
 * The comparison stem of a path: basename minus extension, minus a trailing
 * `.test`/`.spec` and a leading `test_`. `foo.test.ts` → "foo",
 * `test_foo.py` → "foo", `foo.ts` → "foo". Lower-cased for tolerant matching.
 */
export function testStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  let stem = base.replace(/\.[^.]+$/, ""); // drop the final extension
  stem = stem.replace(/[._-](?:test|spec)$/i, ""); // drop a .test / .spec suffix
  stem = stem.replace(/^test_/i, ""); // drop a Python test_ prefix
  return stem.toLowerCase();
}

// Identifier-declaring patterns across the supported languages; each captures
// the declared name in group 1.
const SYMBOL_RES: readonly RegExp[] = [
  /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /(?:^|\s)def\s+([A-Za-z_][\w]*)/, // Python
  /(?:^|\s)func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, // Go
];

const MAX_SYMBOLS = 12;

/** Extract declared symbol names from added source lines. Pure; capped + deduped. */
export function extractChangedSymbols(addedLines: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of addedLines) {
    const line = raw.trim();
    for (const re of SYMBOL_RES) {
      const m = re.exec(line);
      if (m && m[1] && m[1].length > 1) seen.add(m[1]);
      if (seen.size >= MAX_SYMBOLS) return [...seen];
    }
  }
  return [...seen];
}

const DEFAULT_MAX_TEST_READS = 6;
const MAX_TEST_BYTES = 40 * 1024;

/**
 * Discover sibling tests for the given source files against the repo tree.
 * Reads at most `maxTestReads` matched test files (fail-soft per read) to grep
 * for the changed symbols. Skips inputs that are themselves test files.
 */
export async function discoverRelatedTests(
  inputs: readonly RelatedTestsInput[],
  reader: RepoReader,
  opts: { maxTestReads?: number } = {},
): Promise<RelatedTestFinding[]> {
  const sources = inputs.filter((i) => CODE_EXT_RE.test(i.path) && !isTestFile(i.path));
  if (sources.length === 0) return [];

  let tree: string[];
  try {
    tree = await reader.listTree();
  } catch {
    return [];
  }
  const testPaths = tree.filter((p) => isTestFile(p) && CODE_EXT_RE.test(p));
  if (testPaths.length === 0 && sources.every((s) => s.symbols.length === 0)) return [];

  // Index test paths by their comparison stem for O(1) lookup per source.
  const byStem = new Map<string, string[]>();
  for (const t of testPaths) {
    const stem = testStem(t);
    const list = byStem.get(stem);
    if (list) list.push(t);
    else byStem.set(stem, [t]);
  }

  const maxReads = opts.maxTestReads ?? DEFAULT_MAX_TEST_READS;
  const contentCache = new Map<string, string | undefined>();
  let reads = 0;
  const readTest = async (path: string): Promise<string | undefined> => {
    if (contentCache.has(path)) return contentCache.get(path);
    if (reads >= maxReads) return undefined;
    reads += 1;
    let content: string | undefined;
    try {
      content = await reader.readFile(path);
    } catch {
      content = undefined;
    }
    const sliced = content?.slice(0, MAX_TEST_BYTES);
    contentCache.set(path, sliced);
    return sliced;
  };

  const findings: RelatedTestFinding[] = [];
  for (const source of sources) {
    const matches = byStem.get(testStem(source.path)) ?? [];
    const tests: RelatedTestFinding["tests"] = [];
    for (const testPath of matches) {
      if (testPath === source.path) continue;
      const content = await readTest(testPath);
      const referenced =
        content && source.symbols.length > 0
          ? source.symbols.filter((s) => new RegExp(`\\b${escapeRe(s)}\\b`).test(content))
          : [];
      tests.push({ path: testPath, referencedSymbols: referenced });
    }
    const coverageGap = tests.length === 0 && source.symbols.length > 0;
    if (tests.length > 0 || coverageGap) {
      findings.push({ source: source.path, tests, coverageGap });
    }
  }
  return findings;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Render the {{RELATED_TESTS}} block from discovery findings. Pure. */
export function renderRelatedTests(findings: readonly RelatedTestFinding[]): string {
  if (findings.length === 0) return "(none)";
  const lines: string[] = [];
  for (const f of findings) {
    if (f.tests.length === 0) {
      lines.push(`- ${f.source}: no sibling test file found`);
      continue;
    }
    for (const t of f.tests) {
      const refs =
        t.referencedSymbols.length > 0 ? ` (references ${t.referencedSymbols.join(", ")})` : " (found)";
      lines.push(`- ${f.source} → ${t.path}${refs}`);
    }
  }
  return lines.join("\n");
}
