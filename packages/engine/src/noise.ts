/**
 * Noise-file filter: lockfiles, generated, vendored, and binary files never
 * reach the model. Skipped files are returned with a reason so the summary
 * can disclose them.
 */
import type { DiffFile } from "./diff";
import type { SkippedFile } from "./types";

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "nub.lock",
  "nub-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
]);

const GENERATED_SUFFIXES = [".min.js", ".min.css", ".map", ".pb.go", ".snap"];
const GENERATED_INFIXES = ["_pb2.py", ".generated."];
const GENERATED_DIRS = new Set(["dist", "build", "__generated__", "generated", ".next", "out"]);
const VENDORED_DIRS = new Set(["vendor", "vendors", "node_modules", "third_party", "third-party"]);

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function dirSegments(path: string): string[] {
  const segs = path.split("/");
  return segs.slice(0, -1);
}

export function classifyNoise(file: DiffFile): SkippedFile["reason"] | undefined {
  if (file.isBinary) return "binary";
  const name = basename(file.path).toLowerCase();
  if (LOCKFILE_NAMES.has(name)) return "lockfile";
  const dirs = dirSegments(file.path).map((d) => d.toLowerCase());
  if (dirs.some((d) => VENDORED_DIRS.has(d))) return "vendored";
  if (dirs.some((d) => GENERATED_DIRS.has(d))) return "generated";
  if (GENERATED_SUFFIXES.some((s) => name.endsWith(s))) return "generated";
  if (GENERATED_INFIXES.some((s) => name.includes(s))) return "generated";
  return undefined;
}

export interface NoiseFilterResult {
  kept: DiffFile[];
  skipped: SkippedFile[];
}

export function filterNoise(files: DiffFile[]): NoiseFilterResult {
  const kept: DiffFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const file of files) {
    const reason = classifyNoise(file);
    if (reason) skipped.push({ file: file.path, reason });
    else kept.push(file);
  }
  return { kept, skipped };
}
