import { describe, expect, it } from "vitest";
import type { DiffFile } from "./diff";
import { applySizeCap } from "./sizeCap";

function file(path: string, rawText: string): DiffFile {
  return {
    path,
    oldPath: path,
    status: "modified",
    isBinary: false,
    hunks: [],
    commentableLines: [],
    rawText,
  };
}

describe("applySizeCap", () => {
  it("keeps everything when under all caps", () => {
    const { kept, exclusions } = applySizeCap([file("a.ts", "x".repeat(100))]);
    expect(kept).toHaveLength(1);
    expect(exclusions).toEqual([]);
  });

  it("excludes a file over the per-file char cap with a disclosure record", () => {
    const big = file("big.ts", "x".repeat(500));
    const small = file("small.ts", "y".repeat(50));
    const { kept, exclusions } = applySizeCap([big, small], { maxFileChars: 100 });
    expect(kept.map((f) => f.path)).toEqual(["small.ts"]);
    expect(exclusions).toHaveLength(1);
    expect(exclusions[0].file).toBe("big.ts");
    expect(exclusions[0].whatWasExcluded).toMatch(/per-file cap/);
  });

  it("excludes a file over the per-file line cap", () => {
    const tall = file("tall.ts", Array(20).fill("line").join("\n"));
    const { kept, exclusions } = applySizeCap([tall], { maxFileLines: 10 });
    expect(kept).toEqual([]);
    expect(exclusions[0].whatWasExcluded).toMatch(/20 lines/);
  });

  it("drops largest files first to fit the total cap, deterministically", () => {
    const files = [
      file("a.ts", "x".repeat(40)),
      file("b.ts", "x".repeat(90)),
      file("c.ts", "x".repeat(60)),
    ];
    const { kept, exclusions } = applySizeCap(files, { maxTotalChars: 100 });
    expect(kept.map((f) => f.path)).toEqual(["a.ts", "c.ts"]); // original order preserved
    expect(exclusions.map((e) => e.file)).toEqual(["b.ts"]);
    expect(exclusions[0].whatWasExcluded).toMatch(/total diff cap/);
  });

  it("breaks size ties by path so truncation is reproducible", () => {
    const files = [file("a.ts", "x".repeat(80)), file("b.ts", "x".repeat(80))];
    const first = applySizeCap(files, { maxTotalChars: 100 });
    const second = applySizeCap([...files].reverse(), { maxTotalChars: 100 });
    expect(first.exclusions.map((e) => e.file)).toEqual(["b.ts"]);
    expect(second.exclusions.map((e) => e.file)).toEqual(["b.ts"]);
  });

  it("never excludes silently — every removed file has a record", () => {
    const files = [file("a.ts", "x".repeat(300)), file("b.ts", "x".repeat(300))];
    const { kept, exclusions } = applySizeCap(files, { maxTotalChars: 100 });
    expect(kept.length + exclusions.length).toBe(files.length);
  });
});
