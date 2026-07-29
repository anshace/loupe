/**
 * Diff size caps with deterministic truncation — never silent.
 *
 * Strategy (whole-file granularity, deterministic):
 *   1. Any single file whose raw diff exceeds the per-file cap is excluded
 *      entirely (a partially-shown file invites findings on unseen code).
 *   2. If the remaining total still exceeds the total cap, whole files are
 *      dropped largest-first (ties broken by path, descending, so the result
 *      is fully deterministic) until the total fits.
 * Every exclusion is returned as a machine-readable record for the summary.
 */
import type { DiffFile } from "./diff";
import type { Exclusion, SizeCapConfig } from "./types";

export const DEFAULT_SIZE_CAPS: Required<SizeCapConfig> = {
  maxTotalChars: 100_000,
  maxTotalLines: 4_000,
  maxFileChars: 30_000,
  maxFileLines: 1_500,
};

export interface SizeCapResult {
  kept: DiffFile[];
  exclusions: Exclusion[];
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

export function applySizeCap(files: DiffFile[], config: SizeCapConfig = {}): SizeCapResult {
  const caps = { ...DEFAULT_SIZE_CAPS, ...config };
  const exclusions: Exclusion[] = [];

  // Step 1: per-file cap.
  const withinFileCap: DiffFile[] = [];
  for (const file of files) {
    const chars = file.rawText.length;
    const lines = lineCount(file.rawText);
    if (chars > caps.maxFileChars || lines > caps.maxFileLines) {
      exclusions.push({
        file: file.path,
        whatWasExcluded: `entire file diff (${chars} chars, ${lines} lines) exceeded the per-file cap (${caps.maxFileChars} chars / ${caps.maxFileLines} lines)`,
      });
    } else {
      withinFileCap.push(file);
    }
  }

  // Step 2: total cap — drop largest files first.
  const kept = [...withinFileCap];
  const total = (): { chars: number; lines: number } => ({
    chars: kept.reduce((n, f) => n + f.rawText.length, 0),
    lines: kept.reduce((n, f) => n + lineCount(f.rawText), 0),
  });
  while (kept.length > 0) {
    const { chars, lines } = total();
    if (chars <= caps.maxTotalChars && lines <= caps.maxTotalLines) break;
    let largest = 0;
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i];
      const b = kept[largest];
      if (a.rawText.length > b.rawText.length || (a.rawText.length === b.rawText.length && a.path > b.path)) {
        largest = i;
      }
    }
    const dropped = kept.splice(largest, 1)[0];
    exclusions.push({
      file: dropped.path,
      whatWasExcluded: `entire file diff (${dropped.rawText.length} chars) dropped to fit the total diff cap (${caps.maxTotalChars} chars / ${caps.maxTotalLines} lines)`,
    });
  }

  return { kept, exclusions };
}
