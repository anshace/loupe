/**
 * Enclosing-scope expansion (task 6.1): given a hunk's new-side line span and
 * the full file content at the PR head, find the enclosing function/class and
 * feed it to the prompt as a clearly-labeled read-only context block.
 *
 * The default implementation is a REGEX/BRACE HEURISTIC — deliberately, not
 * tree-sitter: the engine has a zero-runtime-dependency rule and must run on
 * the Workers path (see design decision 5 and the 6.2 note). A tree-sitter
 * (wasm) implementation of the same `ScopeExpander` interface lives in
 * `packages/scope-ts` for fs-capable paths, injected via `RunDeps.scopeExpander`.
 *
 * Known heuristic limitations (accepted): brace counting is line-local (string
 * literals / comments are stripped per line, multi-line templates and block
 * comments can confuse it) and declarations whose parameter list spans lines
 * are not recognized. On any miss the expansion simply returns undefined and
 * the hunk goes to the model without extra context — never an error.
 */

/** 1-based inclusive line span within a file. */
export interface ScopeSpan {
  startLine: number;
  endLine: number;
}

/** Strategy interface — regex heuristic by default, tree-sitter injectable. */
export interface ScopeExpander {
  readonly name: string;
  /**
   * Find the innermost function/class span enclosing [startLine, endLine]
   * (1-based, new side). Returns undefined when no enclosing scope is found.
   */
  expand(content: string, path: string, startLine: number, endLine: number): ScopeSpan | undefined;
}

const BRACE_LANGS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);
const INDENT_LANGS = new Set(["py", "pyi"]);

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/** Strip line-local string literals and comments so brace counting is saner. */
function cleanLine(line: string): string {
  return line
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""')
    .replace(/\/\*.*?\*\//g, "")
    .replace(/\/\/.*$/, "");
}

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n += 1;
  return n;
}

/** Declaration-looking lines that open a block (cleaned + trimmed input). */
const DECL_PATTERNS: readonly RegExp[] = [
  // function foo(...) { / export default async function*...
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?function\b/,
  // class Foo { / export abstract class Foo extends Bar {
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+[\w$]/,
  // const foo = (a, b) => { / let f = async function (...) {
  /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|\()/,
  // class method / getter / setter: name(...) ... {   ({ must end the line)
  /^(?:(?:public|private|protected|static|override|readonly|async|get|set)\s+|\*\s*)*[\w$]+\s*(?:<[^>]*>)?\([^;]*\)?\s*(?::\s*[^{;=]+)?\s*\{$/,
];

function isDeclLine(cleanedTrimmed: string): boolean {
  return DECL_PATTERNS.some((r) => r.test(cleanedTrimmed));
}

function expandBrace(lines: string[], startLine: number, endLine: number): ScopeSpan | undefined {
  const n = lines.length;
  const start = Math.min(startLine, n);
  const end = Math.min(endLine, n);
  const cleaned = lines.map(cleanLine);
  const delta = cleaned.map((l) => count(l, "{") - count(l, "}"));
  // depthBefore[i] = brace depth entering 1-based line i.
  const depthBefore: number[] = new Array<number>(n + 2).fill(0);
  for (let i = 1; i <= n; i++) depthBefore[i + 1] = depthBefore[i] + delta[i - 1];

  // Scan upward from the hunk start: the first declaration line whose block
  // closes at or after the hunk end is the innermost enclosing scope.
  for (let i = start; i >= 1; i--) {
    if (delta[i - 1] <= 0) continue; // must open a block on this line
    if (!isDeclLine(cleaned[i - 1].trim())) continue;
    let depth = depthBefore[i];
    for (let j = i; j <= n; j++) {
      depth += delta[j - 1];
      if (depth <= depthBefore[i]) {
        if (j >= end) return { startLine: i, endLine: j };
        break; // closes before the hunk ends — not enclosing; keep scanning up
      }
    }
  }
  return undefined;
}

const PY_DECL = /^(\s*)(?:async\s+)?(?:def|class)\s/;

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].replace(/\t/g, "    ").length : 0;
}

function isBlank(line: string): boolean {
  return !/\S/.test(line);
}

function pyBlockEnd(lines: string[], declLine: number, declIndent: number): number {
  let end = declLine;
  for (let k = declLine + 1; k <= lines.length; k++) {
    const line = lines[k - 1];
    if (isBlank(line)) continue; // trailing blanks stay outside the span
    if (indentOf(line) <= declIndent) break;
    end = k;
  }
  return end;
}

function expandIndent(lines: string[], startLine: number, endLine: number): ScopeSpan | undefined {
  const n = lines.length;
  const start = Math.min(startLine, n);
  const end = Math.min(endLine, n);

  // Reference indent: minimum indent of non-blank lines within the hunk.
  let hunkIndent = Infinity;
  for (let i = start; i <= end; i++) {
    if (!isBlank(lines[i - 1])) hunkIndent = Math.min(hunkIndent, indentOf(lines[i - 1]));
  }
  if (hunkIndent === Infinity) return undefined;

  // A hunk that BEGINS with a def/class (e.g. adds a new function) is its own scope.
  for (let i = start; i <= end; i++) {
    const line = lines[i - 1];
    if (isBlank(line)) continue;
    if (indentOf(line) === hunkIndent && PY_DECL.test(line)) {
      return { startLine: i, endLine: pyBlockEnd(lines, i, hunkIndent) };
    }
    break; // first non-blank hunk line is not a declaration
  }

  // Otherwise scan upward for the nearest def/class at a shallower indent.
  for (let i = start; i >= 1; i--) {
    const line = lines[i - 1];
    if (isBlank(line)) continue;
    const ind = indentOf(line);
    if (ind < hunkIndent && PY_DECL.test(line)) {
      const blockEnd = pyBlockEnd(lines, i, ind);
      if (blockEnd >= end) return { startLine: i, endLine: blockEnd };
    }
  }
  return undefined;
}

/** The default (and Workers-safe) expander: brace heuristic for TS/JS, indent for Python. */
export class RegexScopeExpander implements ScopeExpander {
  readonly name = "regex-heuristic";

  expand(content: string, path: string, startLine: number, endLine: number): ScopeSpan | undefined {
    const ext = extOf(path);
    if (!BRACE_LANGS.has(ext) && !INDENT_LANGS.has(ext)) return undefined;
    const lines = content.split(/\r?\n/);
    if (startLine < 1 || startLine > lines.length) return undefined;
    const end = Math.max(startLine, endLine);
    return BRACE_LANGS.has(ext)
      ? expandBrace(lines, startLine, end)
      : expandIndent(lines, startLine, end);
  }
}

/** Per-file input to context building: full head content + hunk spans. */
export interface ScopeInput {
  path: string;
  content: string;
  hunks: ReadonlyArray<{ newStart: number; newLines: number }>;
}

export interface BuiltContext {
  /** Concatenated labeled context blocks; empty string when nothing expanded. */
  text: string;
  /** True when the char cap excluded at least one block (disclosed via notice). */
  truncated: boolean;
}

export const DEFAULT_CONTEXT_CAP_CHARS = 12_000;

function mergeSpans(spans: ScopeSpan[]): ScopeSpan[] {
  const sorted = [...spans].sort((a, b) => a.startLine - b.startLine);
  const merged: ScopeSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, span.endLine);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * Build the {{CONTEXT}} prompt block: one labeled, line-numbered section per
 * expanded scope, capped at `maxTotalChars` total. Pure.
 */
export function buildContext(
  inputs: readonly ScopeInput[],
  expander: ScopeExpander,
  opts: { maxTotalChars?: number } = {},
): BuiltContext {
  const cap = opts.maxTotalChars ?? DEFAULT_CONTEXT_CAP_CHARS;
  const blocks: string[] = [];
  let total = 0;
  let truncated = false;

  for (const input of inputs) {
    const lines = input.content.split(/\r?\n/);
    const spans: ScopeSpan[] = [];
    for (const hunk of input.hunks) {
      const endLine = hunk.newStart + Math.max(hunk.newLines - 1, 0);
      const span = expander.expand(input.content, input.path, hunk.newStart, endLine);
      if (span) spans.push(span);
    }
    for (const span of mergeSpans(spans)) {
      const body = lines
        .slice(span.startLine - 1, span.endLine)
        .map((l, k) => `${String(span.startLine + k).padStart(5)}| ${l}`)
        .join("\n");
      const block = `### ${input.path} — enclosing scope, lines ${span.startLine}-${span.endLine}\n\n\`\`\`\n${body}\n\`\`\``;
      if (total + block.length > cap) {
        truncated = true;
        continue; // a smaller later block may still fit
      }
      blocks.push(block);
      total += block.length + 2;
    }
  }
  return { text: blocks.join("\n\n"), truncated };
}
