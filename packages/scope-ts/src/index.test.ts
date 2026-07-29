import { describe, expect, it } from "vitest";
import { createScopeExpander } from "./index";

const TS_FILE = [
  "export function outer(a: number): number {",
  "  const b = a + 1;",
  "  return b * 2;",
  "}",
].join("\n");

describe("createScopeExpander", () => {
  it("falls back to the regex heuristic when web-tree-sitter / grammars are unavailable", async () => {
    // web-tree-sitter is an optional dependency and is NOT installed in this
    // repo (and no grammar .wasm files are vendored) — the factory must fall
    // back silently and still satisfy the ScopeExpander contract.
    const expander = await createScopeExpander({ wasmDir: "Z:/definitely/not/here" });
    expect(expander.name).toBe("regex-heuristic");
    expect(expander.expand(TS_FILE, "a.ts", 2, 2)).toEqual({ startLine: 1, endLine: 4 });
  });

  it("never throws, even with a bogus wasm dir", async () => {
    await expect(createScopeExpander({ wasmDir: "" })).resolves.toBeDefined();
  });
});
