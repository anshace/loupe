/**
 * Prompt loading and rendering (design decision 7: prompts are versioned
 * markdown files in-repo, never inline strings).
 *
 * File format: the line `<!-- USER -->` splits the file into the system
 * prompt (above) and the user-message template (below). `{{PLACEHOLDER}}`
 * tokens are substituted by `renderPrompt`.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { DiffFile } from "./diff";

/** The engine's default prompt version — reviewer-v7 (splits fixes into committable `suggestedLine` + prose `suggestion`, report item #7). */
export const REVIEWER_PROMPT_FILE = "reviewer-v7.md";

const USER_MARKER = /^<!--\s*USER\s*-->\s*$/m;

function candidatePaths(fileName: string): string[] {
  const candidates: string[] = [];
  // Compiled layout: <root>/packages/engine/dist → three levels up to <root>.
  // Source layout under vitest: <root>/packages/engine/src → same depth.
  const moduleDir = typeof __dirname === "string" ? __dirname : undefined;
  if (moduleDir) candidates.push(path.resolve(moduleDir, "..", "..", "..", "prompts", fileName));
  candidates.push(path.resolve(process.cwd(), "prompts", fileName));
  return candidates;
}

/** Load a prompt template, either from an explicit path or from `prompts/`. */
export function loadPromptTemplate(explicitPath?: string, fileName: string = REVIEWER_PROMPT_FILE): string {
  const candidates = explicitPath ? [explicitPath] : candidatePaths(fileName);
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`prompt file ${fileName} not found; looked in: ${candidates.join(", ")}`);
}

export interface RenderedPrompt {
  system: string;
  user: string;
}

/** Split on the USER marker and substitute {{KEY}} placeholders in both parts. */
export function renderPrompt(template: string, vars: Record<string, string>): RenderedPrompt {
  const match = USER_MARKER.exec(template);
  if (!match) throw new Error("prompt template has no <!-- USER --> marker");
  let system = template.slice(0, match.index);
  let user = template.slice(match.index + match[0].length);
  for (const [key, value] of Object.entries(vars)) {
    const token = `{{${key}}}`;
    system = system.split(token).join(value);
    user = user.split(token).join(value);
  }
  return { system: system.trim(), user: user.trim() };
}

// ── Per-language CWE / input-validation checklist (feature #5) ──────────────
//
// A static file-extension → language map plus a SHORT curated checklist drawn
// from the 2025 CWE Top 25 (CISA/MITRE) and the OWASP ASVS validation chapter.
// Only the languages actually present in the diff are appended to the reviewer
// system prompt — this is a recall lever (directs the model's attention at the
// bug classes that dominate real CVEs for that language) kept deliberately
// terse to avoid token bloat.

const EXT_LANGUAGE: Record<string, string> = {
  ts: "TypeScript/JavaScript",
  tsx: "TypeScript/JavaScript",
  mts: "TypeScript/JavaScript",
  cts: "TypeScript/JavaScript",
  js: "TypeScript/JavaScript",
  jsx: "TypeScript/JavaScript",
  mjs: "TypeScript/JavaScript",
  cjs: "TypeScript/JavaScript",
  py: "Python",
  go: "Go",
  java: "Java",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  c: "C/C++",
  h: "C/C++",
  cc: "C/C++",
  cpp: "C/C++",
  cxx: "C/C++",
  hpp: "C/C++",
  rs: "Rust",
  sql: "SQL",
};

const LANGUAGE_CHECKLIST: Record<string, string[]> = {
  "TypeScript/JavaScript": [
    "CWE-79 XSS: request data reaching innerHTML / dangerouslySetInnerHTML / document.write without escaping.",
    "CWE-89 SQL injection: string-concatenated queries instead of parameterized/prepared statements.",
    "CWE-94 code injection: eval / new Function / child_process fed request-derived input.",
    "CWE-639 broken access control: an id/owner from the request used in a lookup without checking it belongs to the caller.",
    "Input validation: prefer allow-lists; anchor regexes with ^…$; never rely on client-only validation.",
  ],
  Python: [
    "CWE-89 SQL injection: f-string / % / .format queries instead of parameterized ones.",
    "CWE-78 OS command injection: os.system / subprocess with shell=True on user input.",
    "CWE-94/502 code & deserialization: eval / exec / pickle / yaml.load on untrusted data.",
    "CWE-22 path traversal: request-derived paths joined without validation.",
    "Input validation: prefer allow-lists; anchor regexes with ^…$.",
  ],
  Go: [
    "CWE-89 SQL injection: fmt.Sprintf-built queries instead of parameterized db calls.",
    "CWE-78 command injection: exec.Command via a shell with untrusted args.",
    "CWE-22 path traversal: filepath.Join on request input without filepath.Clean + prefix check.",
    "CWE-703: ignored errors (`_ =`) and unchecked type assertions hiding failures.",
  ],
  Java: [
    "CWE-89 SQL injection: Statement string concatenation instead of PreparedStatement.",
    "CWE-611 XXE: XML parsers without external-entity resolution disabled.",
    "CWE-502 deserialization: readObject / ObjectInputStream on untrusted data.",
    "CWE-22 path traversal: File/Paths built from request input without canonicalization.",
  ],
  Ruby: [
    "CWE-89 SQL injection: string-interpolated where/find_by_sql instead of parameter binding.",
    "CWE-78 command injection: system / backticks / %x on user input.",
    "CWE-94: eval / send with request-derived method names.",
  ],
  PHP: [
    "CWE-89 SQL injection: interpolated queries instead of prepared statements (PDO/mysqli).",
    "CWE-79 XSS: echoing request data without htmlspecialchars.",
    "CWE-78 command injection: system / exec / shell_exec on user input.",
    "CWE-98 file inclusion: include/require built from request input.",
  ],
  "C#": [
    "CWE-89 SQL injection: string-concatenated SqlCommand instead of parameters.",
    "CWE-502 deserialization: BinaryFormatter / unsafe type resolution on untrusted data.",
    "CWE-22 path traversal: Path.Combine on request input without validation.",
  ],
  "C/C++": [
    "CWE-787/125 out-of-bounds write/read: unchecked indices, memcpy/strcpy without bounds.",
    "CWE-416 use-after-free / CWE-415 double-free: freed pointers reused or freed twice.",
    "CWE-190 integer overflow feeding an allocation or length.",
  ],
  Rust: [
    "CWE-676: unnecessary `unsafe` blocks; raw-pointer deref invariants.",
    "CWE-248: `.unwrap()` / `.expect()` on request-derived Option/Result (panic = DoS).",
    "CWE-190 integer overflow in release builds (use checked_/saturating_ arithmetic).",
  ],
  SQL: [
    "CWE-89: dynamic SQL built by concatenation; ensure parameterization at the call site.",
    "Least privilege: DDL/GRANT changes widening access beyond what the change needs.",
  ],
};

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/**
 * Build the {{SECURITY_CHECKLIST}} block: curated CWE / input-validation lines
 * for exactly the languages present in the diff, or "(none)". Pure.
 */
export function buildSecurityChecklist(files: ReadonlyArray<{ path: string }>): string {
  const langs = new Set<string>();
  for (const f of files) {
    const lang = EXT_LANGUAGE[extOf(f.path)];
    if (lang) langs.add(lang);
  }
  const blocks: string[] = [];
  for (const lang of langs) {
    const items = LANGUAGE_CHECKLIST[lang];
    if (items) blocks.push(`**${lang}**\n` + items.map((i) => `- ${i}`).join("\n"));
  }
  return blocks.length > 0 ? blocks.join("\n\n") : "(none)";
}

/** Compact "file: 1-4, 9, 12-13" rendering of commentable lines per file. */
export function formatCommentableLines(files: DiffFile[]): string {
  const lines: string[] = [];
  for (const file of files) {
    if (file.commentableLines.length === 0) continue;
    lines.push(`- ${file.path}: ${compressRanges(file.commentableLines)}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(no commentable lines)";
}

function compressRanges(sorted: number[]): string {
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    if (n !== undefined) {
      start = n;
      prev = n;
    }
  }
  return parts.join(", ");
}
