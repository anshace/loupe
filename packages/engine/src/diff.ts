/**
 * Diff fetching and unified-diff parsing.
 *
 * Fetching uses plain `fetch` (no octokit — the engine stays dependency-free
 * and pure). Parsing turns the raw unified diff into files → hunks with
 * new-side (RIGHT) line numbers and the per-file set of commentable lines.
 */
import type { PrIdentity, AuthToken } from "./types";

/**
 * Minimal structural fetch type so tests can inject a mock without pulling in
 * DOM lib types. The global `fetch` is assignable to it.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const GITHUB_API = "https://api.github.com";

/** GET the PR's unified diff via `Accept: application/vnd.github.diff`. */
export async function fetchPrDiff(
  pr: PrIdentity,
  auth: AuthToken,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const url = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}/pulls/${pr.prNumber}`;
  const res = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github.diff",
      authorization: `Bearer ${auth}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "code-review-engine",
    },
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`fetching diff for ${pr.owner}/${pr.repo}#${pr.prNumber} failed: HTTP ${res.status} ${body}`);
  }
  return res.text();
}

export type DiffLineType = "add" | "del" | "context";

export interface DiffLine {
  type: DiffLineType;
  /** Line content without the leading +/-/space marker. */
  content: string;
  /** New-side (RIGHT) line number; absent on deletions. */
  newLine?: number;
  /** Old-side (LEFT) line number; absent on additions. */
  oldLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Trailing text of the @@ header (enclosing-scope hint). */
  header: string;
  lines: DiffLine[];
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export interface DiffFile {
  /** New-side path (old path for deleted files, so filters still apply). */
  path: string;
  oldPath: string;
  status: FileStatus;
  isBinary: boolean;
  hunks: DiffHunk[];
  /**
   * New-side line numbers a review comment may be anchored to (added and
   * context lines shown in the diff). Empty for deleted/binary files.
   */
  commentableLines: number[];
  /** The raw diff text of this file's section (used for size caps & prompt). */
  rawText: string;
}

const FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Parse a unified diff into per-file hunks with RIGHT-side line numbers. */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const lines = diff.split("\n");
  const files: DiffFile[] = [];

  let current: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldLine = 0;
  let newLine = 0;
  let raw: string[] = [];

  const finishFile = (): void => {
    if (!current) return;
    current.rawText = raw.join("\n");
    files.push(current);
    current = undefined;
    hunk = undefined;
    raw = [];
  };

  for (const line of lines) {
    const fileMatch = FILE_HEADER.exec(line);
    if (fileMatch) {
      finishFile();
      current = {
        path: fileMatch[2],
        oldPath: fileMatch[1],
        status: "modified",
        isBinary: false,
        hunks: [],
        commentableLines: [],
        rawText: "",
      };
      raw = [line];
      continue;
    }
    if (!current) continue; // preamble before the first file header
    raw.push(line);

    const inHunk = hunk !== undefined && (oldRemaining > 0 || newRemaining > 0);
    if (inHunk && hunk) {
      // "\ No newline at end of file" markers don't consume line counts.
      if (line.startsWith("\\")) continue;
      const marker = line[0] ?? " "; // an empty line is an empty context line
      const content = line.slice(1);
      if (marker === "+") {
        hunk.lines.push({ type: "add", content, newLine });
        current.commentableLines.push(newLine);
        newLine += 1;
        newRemaining -= 1;
      } else if (marker === "-") {
        hunk.lines.push({ type: "del", content, oldLine });
        oldLine += 1;
        oldRemaining -= 1;
      } else {
        hunk.lines.push({ type: "context", content, newLine, oldLine });
        current.commentableLines.push(newLine);
        newLine += 1;
        oldLine += 1;
        newRemaining -= 1;
        oldRemaining -= 1;
      }
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        header: hunkMatch[5] ?? "",
        lines: [],
      };
      current.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      oldRemaining = hunk.oldLines;
      newRemaining = hunk.newLines;
      continue;
    }

    // File metadata lines.
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      current.status = "renamed";
      current.path = line.slice("rename to ".length);
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.isBinary = true;
    } else if (line.startsWith("+++ b/")) {
      current.path = line.slice("+++ b/".length);
    } else if (line.startsWith("--- a/")) {
      current.oldPath = line.slice("--- a/".length);
    } else if (line === "+++ /dev/null") {
      // Deleted file: keep the old path as the reporting path.
      current.path = current.oldPath;
    }
  }
  finishFile();

  for (const f of files) {
    if (f.status === "deleted" || f.isBinary) f.commentableLines = [];
    f.commentableLines = [...new Set(f.commentableLines)].sort((a, b) => a - b);
  }
  return files;
}
