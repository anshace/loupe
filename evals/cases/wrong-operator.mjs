import { finding, hunkDiff } from "./_util.mjs";

// Seeded from the testbed's src/pricing.ts subtotalCents.
const FILE = [
  "export interface LineItem { unitPriceCents: number; quantity: number }",
  "",
  "export function subtotalCents(items: LineItem[]): number {",
  "  return items.reduce((sum, item) => sum - item.unitPriceCents * item.quantity, 0);",
  "}",
];

export default {
  name: "wrong-operator",
  diff: hunkDiff("src/pricing.ts", {
    oldStart: 1,
    newStart: 1,
    lines: [
      ["ctx", FILE[0]],
      ["ctx", FILE[1]],
      ["ctx", FILE[2]],
      ["del", "  return items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);"],
      ["add", FILE[3]],
      ["ctx", FILE[4]],
    ],
  }),
  fileContents: { "src/pricing.ts": FILE.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/pricing.ts",
        4,
        "Subtotal subtracts item prices",
        "The reducer was changed from sum + ... to sum - ..., so subtotals are negative.",
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/pricing.ts", lineRange: [4, 4], mustMatch: "subtract|negative|sum -" }],
};
