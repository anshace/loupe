import { finding, hunkDiff } from "./_util.mjs";

// Seeded from the testbed's src/pricing.ts: applyDiscount gains a required
// `roundUp` parameter, but the caller in src/checkout.ts still passes two
// arguments. Finding the break REQUIRES looking outside the diff (agentic).
const PRICING = [
  "/** Applies a percentage discount (0-100) and rounds to whole cents. */",
  "export function applyDiscount(totalCents: number, discountPercent: number, roundUp: boolean): number {",
  "  if (discountPercent < 0 || discountPercent > 100) {",
  "    throw new RangeError(`discountPercent out of range: ${discountPercent}`);",
  "  }",
  "  const raw = totalCents * (1 - discountPercent / 100);",
  "  return roundUp ? Math.ceil(raw) : Math.floor(raw);",
  "}",
];

const CHECKOUT = [
  'import { applyDiscount } from "./pricing";',
  "",
  "export function checkoutTotal(totalCents: number): number {",
  "  return applyDiscount(totalCents, 10);",
  "}",
];

export default {
  name: "cross-file-signature-break",
  config: { agentic: true },
  diff: hunkDiff("src/pricing.ts", {
    oldStart: 1,
    newStart: 1,
    lines: [
      ["ctx", PRICING[0]],
      ["del", "export function applyDiscount(totalCents: number, discountPercent: number): number {"],
      ["add", PRICING[1]],
      ["ctx", PRICING[2]],
      ["ctx", PRICING[3]],
      ["ctx", PRICING[4]],
      ["del", "  return Math.round(totalCents * (1 - discountPercent / 100));"],
      ["add", PRICING[5]],
      ["add", PRICING[6]],
      ["ctx", PRICING[7]],
    ],
  }),
  fileContents: {
    "src/pricing.ts": PRICING.join("\n"),
    "src/checkout.ts": CHECKOUT.join("\n"),
  },
  mockResponses: [
    JSON.stringify({ tool_calls: [{ tool: "grep", pattern: "applyDiscount" }] }),
    JSON.stringify({ tool_calls: [{ tool: "read_file", path: "src/checkout.ts" }] }),
    JSON.stringify([
      finding(
        "src/pricing.ts",
        2,
        "Caller not updated for the new required parameter",
        "applyDiscount now requires roundUp, but src/checkout.ts:4 still calls applyDiscount(totalCents, 10) with two arguments — this no longer compiles.",
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/pricing.ts", lineRange: [2, 2], mustMatch: "caller|checkout" }],
};
