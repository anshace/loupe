import { hunkDiff } from "./_util.mjs";

const NEW = [
  "export function subtotalCents(items) {",
  "  return items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0);",
  "}",
];

export default {
  name: "clean-rename-local",
  diff: hunkDiff("src/pricing.ts", {
    lines: [
      ["ctx", NEW[0]],
      ["del", "  return items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);"],
      ["add", NEW[1]],
      ["ctx", NEW[2]],
    ],
  }),
  fileContents: { "src/pricing.ts": NEW.join("\n") },
  mockResponses: ["[]"],
  expectedFindings: [],
  expectClean: true,
};
