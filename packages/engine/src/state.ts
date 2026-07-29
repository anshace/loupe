/**
 * Durable per-PR state (task 7.1): `{pr → last-reviewed SHA, hunk
 * content-hashes, open findings}` behind a `StateStore` interface with two
 * implementations:
 *   - `KvStateStore`   — App/Worker path, backed by a minimal Cloudflare-KV-
 *     shaped `{get, put}` interface (tests inject a Map-backed fake).
 *   - `FileStateStore` — Action path, a flat JSON file keyed by PR
 *     (injectable fs, mirroring the cost-ledger pattern).
 *
 * The summary-comment marker (summary.ts) remains the stateless FALLBACK
 * source of the last-reviewed SHA when no store is configured; the store is
 * the durable upgrade that additionally enables hunk-hash skipping (7.2) and
 * still-open carry-forward (7.3). Reads are defensive: corrupt/absent state
 * is `null`, never a crash.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { DiffFile, DiffHunk } from "./diff";
import type { Finding, PrIdentity, Severity } from "./types";

/** A finding carried across runs. Same shape as a published Finding. */
export type PersistedFinding = Finding;

export interface PrState {
  lastReviewedSha: string;
  /** Content hashes of hunks already reviewed (see `hashHunk`). */
  hunkHashes: string[];
  /** Findings reported in earlier runs and not yet resolved. */
  openFindings: PersistedFinding[];
}

export interface StateStore {
  get(prKey: string): Promise<PrState | null>;
  set(prKey: string, state: PrState): Promise<void>;
}

/** Stable state key for a PR: "owner/repo#number". */
export function prStateKey(pr: PrIdentity): string {
  return `${pr.owner}/${pr.repo}#${pr.prNumber}`;
}

/** Bounds so a long-lived PR can never grow state without limit. */
export const MAX_TRACKED_HUNK_HASHES = 2000;
export const MAX_OPEN_FINDINGS = 200;

const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low", "nit"];

function parseFinding(value: unknown): PersistedFinding | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const f = value as Record<string, unknown>;
  if (
    typeof f.file !== "string" ||
    typeof f.title !== "string" ||
    typeof f.body !== "string" ||
    typeof f.category !== "string" ||
    typeof f.severity !== "string" ||
    !(SEVERITIES as readonly string[]).includes(f.severity)
  ) {
    return undefined;
  }
  return {
    severity: f.severity as Severity,
    category: f.category,
    file: f.file,
    line: typeof f.line === "number" ? f.line : undefined,
    title: f.title,
    body: f.body,
    suggestion: typeof f.suggestion === "string" ? f.suggestion : undefined,
  };
}

/** Defensive PrState parse: anything malformed → null (treat as no state). */
export function parsePrState(value: unknown): PrState | null {
  if (value === null || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (typeof s.lastReviewedSha !== "string" || s.lastReviewedSha.length === 0) return null;
  const hunkHashes = Array.isArray(s.hunkHashes)
    ? s.hunkHashes.filter((h): h is string => typeof h === "string")
    : [];
  const openFindings = Array.isArray(s.openFindings)
    ? s.openFindings.map(parseFinding).filter((f): f is PersistedFinding => f !== undefined)
    : [];
  return { lastReviewedSha: s.lastReviewedSha, hunkHashes, openFindings };
}

/**
 * Minimal structural slice of a Cloudflare KV namespace binding — only what
 * the store needs, so tests can inject a Map-backed fake and the engine never
 * imports Workers types.
 */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** App/Worker state store on Cloudflare KV (task 7.1a). */
export class KvStateStore implements StateStore {
  constructor(
    private readonly kv: KvLike,
    private readonly prefix: string = "prstate:",
  ) {}

  async get(prKey: string): Promise<PrState | null> {
    const raw = await this.kv.get(this.prefix + prKey);
    if (raw === null) return null;
    try {
      return parsePrState(JSON.parse(raw));
    } catch {
      return null; // corrupt state → no state, never a crash
    }
  }

  async set(prKey: string, state: PrState): Promise<void> {
    await this.kv.put(this.prefix + prKey, JSON.stringify(state));
  }
}

/** Injectable fs for FileStateStore (mirrors the cost ledger's LedgerIo). */
export interface StateFileIo {
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
}

/**
 * Action-path state store: ONE flat JSON file `{ "<prKey>": PrState, ... }`.
 * Reads are defensive; writes merge, preserving other PRs' entries.
 */
export class FileStateStore implements StateStore {
  constructor(
    private readonly path: string,
    private readonly io: StateFileIo = {},
  ) {}

  private readAll(): Record<string, unknown> {
    const read = this.io.readFile ?? ((p: string) => readFileSync(p, "utf8"));
    try {
      const parsed: unknown = JSON.parse(read(this.path));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed as Record<string, unknown>;
    } catch {
      return {}; // absent or corrupt file → empty store
    }
  }

  async get(prKey: string): Promise<PrState | null> {
    return parsePrState(this.readAll()[prKey]);
  }

  async set(prKey: string, state: PrState): Promise<void> {
    const write = this.io.writeFile ?? ((p: string, content: string) => writeFileSync(p, content));
    const all = this.readAll();
    all[prKey] = state;
    write(this.path, JSON.stringify(all, null, 2) + "\n");
  }
}

/** FNV-1a 32-bit over a string, as 8 hex chars. Deterministic, dependency-free. */
function fnv1a(text: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Content hash of a hunk (task 7.2): file path + line types/contents. Line
 * NUMBERS are deliberately excluded so a hunk that merely shifted (code added
 * above it) is still recognized as already reviewed. Two independent FNV-1a
 * passes → 64 bits, plenty for dedupe-style skipping.
 */
export function hashHunk(filePath: string, hunk: DiffHunk): string {
  const body = `${filePath}\n` + hunk.lines.map((l) => l.type[0] + l.content).join("\n");
  return fnv1a(body, 0x811c9dc5) + fnv1a(body, 0x01234567);
}

/** All hunk hashes of the given (already filtered/kept) diff files. */
export function hashHunks(files: readonly DiffFile[]): string[] {
  return files.flatMap((f) => f.hunks.map((h) => hashHunk(f.path, h)));
}

/** Identity key for merging findings across runs: file + line + title. */
export function findingKey(f: Finding): string {
  return `${f.file}|${f.line ?? ""}|${f.title.trim().toLowerCase()}`;
}

/** Concatenate finding lists, dropping later duplicates (by `findingKey`). */
export function mergeFindings(...lists: ReadonlyArray<readonly Finding[]>): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const list of lists) {
    for (const f of list) {
      const key = findingKey(f);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

export interface CarryForwardResult {
  /** Open findings whose code the new range did NOT touch → still open. */
  stillOpen: Finding[];
  /** Open findings whose code changed or disappeared → assumed resolved. */
  resolved: Finding[];
}

/**
 * Still-open carry-forward (task 7.3) — incremental runs only. `changed` is
 * the parsed before..after diff, whose OLD side is the revision the findings
 * were reported against (the last reviewed head), so old-side hunk spans are
 * the correct coordinate system for the persisted finding lines:
 *   - file untouched by the range           → still open
 *   - file deleted                          → resolved
 *   - file-level finding on a touched file  → resolved (re-reviewed)
 *   - line inside a changed hunk's old span → resolved (code changed)
 *   - line outside every changed hunk       → still open
 */
export function carryForwardOpenFindings(
  open: readonly PersistedFinding[],
  changed: readonly DiffFile[],
): CarryForwardResult {
  const byPath = new Map<string, DiffFile>();
  for (const file of changed) {
    byPath.set(file.path, file);
    if (!byPath.has(file.oldPath)) byPath.set(file.oldPath, file);
  }

  const stillOpen: Finding[] = [];
  const resolved: Finding[] = [];
  for (const finding of open) {
    const file = byPath.get(finding.file);
    if (!file) {
      stillOpen.push(finding);
      continue;
    }
    if (file.status === "deleted" || finding.line === undefined) {
      resolved.push(finding);
      continue;
    }
    const line = finding.line;
    const touched = file.hunks.some(
      (h) => line >= h.oldStart && line < h.oldStart + Math.max(h.oldLines, 1),
    );
    (touched ? resolved : stillOpen).push(finding);
  }
  return { stillOpen, resolved };
}
