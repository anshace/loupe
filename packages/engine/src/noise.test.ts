import { describe, expect, it } from "vitest";
import type { DiffFile } from "./diff";
import { classifyNoise, filterNoise } from "./noise";

function file(path: string, isBinary = false): DiffFile {
  return {
    path,
    oldPath: path,
    status: "modified",
    isBinary,
    hunks: [],
    commentableLines: [],
    rawText: "",
  };
}

describe("classifyNoise", () => {
  it.each([
    "package-lock.json",
    "nub.lock",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "Cargo.lock",
    "Gemfile.lock",
    "poetry.lock",
    "go.sum",
    "sub/dir/package-lock.json",
  ])("classifies %s as lockfile", (p) => {
    expect(classifyNoise(file(p))).toBe("lockfile");
  });

  it.each([
    "app.min.js",
    "styles.min.css",
    "bundle.js.map",
    "api.pb.go",
    "service_pb2.py",
    "dist/index.js",
    "build/output.js",
    "src/__generated__/types.ts",
  ])("classifies %s as generated", (p) => {
    expect(classifyNoise(file(p))).toBe("generated");
  });

  it.each(["vendor/lib/x.go", "node_modules/pkg/index.js", "third_party/x.c"])(
    "classifies %s as vendored",
    (p) => {
      expect(classifyNoise(file(p))).toBe("vendored");
    },
  );

  it("classifies binary diff markers as binary", () => {
    expect(classifyNoise(file("logo.png", true))).toBe("binary");
  });

  it("keeps ordinary source files", () => {
    expect(classifyNoise(file("src/app.ts"))).toBeUndefined();
    expect(classifyNoise(file("README.md"))).toBeUndefined();
    // Names that merely contain noise words must not match.
    expect(classifyNoise(file("src/distance.ts"))).toBeUndefined();
    expect(classifyNoise(file("src/builder.ts"))).toBeUndefined();
  });
});

describe("filterNoise", () => {
  it("splits kept and skipped with reasons", () => {
    const files = [file("src/app.ts"), file("yarn.lock"), file("img.png", true)];
    const { kept, skipped } = filterNoise(files);
    expect(kept.map((f) => f.path)).toEqual(["src/app.ts"]);
    expect(skipped).toEqual([
      { file: "yarn.lock", reason: "lockfile" },
      { file: "img.png", reason: "binary" },
    ]);
  });
});
