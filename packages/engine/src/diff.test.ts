import { describe, expect, it } from "vitest";
import { fetchPrDiff, parseUnifiedDiff, type FetchLike } from "./diff";
import {
  BINARY_FILE_DIFF,
  DELETED_FILE_DIFF,
  MODIFIED_FILE_DIFF,
  MULTI_FILE_DIFF,
  NEW_FILE_DIFF,
  PURE_RENAME_DIFF,
  RENAMED_FILE_DIFF,
} from "./fixtures";

const pr = { owner: "anshace", repo: "demo", prNumber: 7 };

describe("fetchPrDiff", () => {
  it("requests the PR with the diff media type and returns the body", async () => {
    const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
    const fake: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => "diff --git a/x b/x" };
    };
    const diff = await fetchPrDiff(pr, "tok", fake);
    expect(diff).toBe("diff --git a/x b/x");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/anshace/demo/pulls/7");
    expect(calls[0].init?.headers?.accept).toBe("application/vnd.github.diff");
    expect(calls[0].init?.headers?.authorization).toBe("Bearer tok");
  });

  it("throws with status and body snippet on a non-ok response", async () => {
    const fake: FetchLike = async () => ({ ok: false, status: 404, text: async () => "Not Found" });
    await expect(fetchPrDiff(pr, "tok", fake)).rejects.toThrow(/HTTP 404 Not Found/);
  });
});

describe("parseUnifiedDiff", () => {
  it("parses a modified file with correct new-side line numbers", () => {
    const [file] = parseUnifiedDiff(MODIFIED_FILE_DIFF);
    expect(file.path).toBe("src/app.ts");
    expect(file.status).toBe("modified");
    expect(file.isBinary).toBe(false);
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0];
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 5, newStart: 1, newLines: 7 });
    expect(file.commentableLines).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const adds = hunk.lines.filter((l) => l.type === "add");
    expect(adds.map((l) => l.newLine)).toEqual([3, 4, 6, 7]);
    const dels = hunk.lines.filter((l) => l.type === "del");
    expect(dels.map((l) => l.oldLine)).toEqual([3, 4]);
    expect(dels.every((l) => l.newLine === undefined)).toBe(true);
  });

  it("handles renames, keeping old and new paths", () => {
    const [file] = parseUnifiedDiff(RENAMED_FILE_DIFF);
    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("old-name.ts");
    expect(file.path).toBe("new-name.ts");
    expect(file.commentableLines).toEqual([10, 11, 12]);
    expect(file.hunks[0].header).toBe("export function f() {");
  });

  it("handles a pure rename with no hunks", () => {
    const [file] = parseUnifiedDiff(PURE_RENAME_DIFF);
    expect(file.status).toBe("renamed");
    expect(file.path).toBe("is.ts");
    expect(file.hunks).toHaveLength(0);
    expect(file.commentableLines).toEqual([]);
  });

  it("handles new files (all lines commentable) and no-newline markers", () => {
    const [file] = parseUnifiedDiff(NEW_FILE_DIFF);
    expect(file.status).toBe("added");
    expect(file.path).toBe("added.txt");
    expect(file.commentableLines).toEqual([1, 2]);
  });

  it("handles deleted files with zero commentable lines and the old path", () => {
    const [file] = parseUnifiedDiff(DELETED_FILE_DIFF);
    expect(file.status).toBe("deleted");
    expect(file.path).toBe("gone.txt");
    expect(file.commentableLines).toEqual([]);
  });

  it("flags binary files and gives them no commentable lines", () => {
    const [file] = parseUnifiedDiff(BINARY_FILE_DIFF);
    expect(file.isBinary).toBe(true);
    expect(file.path).toBe("logo.png");
    expect(file.commentableLines).toEqual([]);
  });

  it("parses a multi-file diff into separate files with their own raw text", () => {
    const files = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(files.map((f) => f.path)).toEqual([
      "src/app.ts",
      "added.txt",
      "gone.txt",
      "logo.png",
      "package-lock.json",
    ]);
    for (const f of files) {
      expect(f.rawText.startsWith("diff --git ")).toBe(true);
      expect(f.rawText).toContain(f.path);
    }
  });

  it("returns an empty list for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
