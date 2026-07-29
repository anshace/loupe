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

/** The engine's default prompt version — M5 ships reviewer-v4 (custom rules + retrieved context). */
export const REVIEWER_PROMPT_FILE = "reviewer-v4.md";

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
