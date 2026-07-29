import { hunkDiff } from "./_util.mjs";

const NEW = [
  "export function formatCents(cents) {",
  "  const dollars = Math.trunc(cents / 100);",
  "  const remainder = Math.abs(cents % 100);",
  '  return `$${dollars}.${String(remainder).padStart(2, "0")}`;',
  "}",
];

export default {
  name: "clean-refactor",
  diff: hunkDiff("src/format.js", {
    lines: [
      ["ctx", NEW[0]],
      ["del", "  const dollars = Math.trunc(cents / 100), remainder = Math.abs(cents % 100);"],
      ["add", NEW[1]],
      ["add", NEW[2]],
      ["ctx", NEW[3]],
      ["ctx", NEW[4]],
    ],
  }),
  fileContents: { "src/format.js": NEW.join("\n") },
  mockResponses: ["[]"],
  expectedFindings: [],
  expectClean: true,
};
