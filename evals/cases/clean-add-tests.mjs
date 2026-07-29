import { newFileDiff } from "./_util.mjs";

const LINES = [
  'import { describe, expect, it } from "vitest";',
  'import { slugify } from "../src/slugify";',
  "",
  'describe("slugify", () => {',
  '  it("lowercases and dashes", () => {',
  '    expect(slugify("Hello World")).toBe("hello-world");',
  "  });",
  "});",
];

export default {
  name: "clean-add-tests",
  diff: newFileDiff("test/slugify.test.js", LINES),
  fileContents: { "test/slugify.test.js": LINES.join("\n") },
  mockResponses: ["[]"],
  expectedFindings: [],
  expectClean: true,
};
