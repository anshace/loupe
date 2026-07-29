import { finding, newFileDiff } from "./_util.mjs";

// The reviewer emits one real bug and one false positive (it claims the
// discount is unvalidated although the range check is right there). The
// verifier must keep the real one and drop the false claim with evidence.
const LINES = [
  "export function applyDiscount(totalCents: number, discountPercent: number): number {",
  "  if (discountPercent < 0 || discountPercent > 100) {",
  "    throw new RangeError(`discountPercent out of range: ${discountPercent}`);",
  "  }",
  "  return Math.round(totalCents * (1 - discountPercent));",
  "}",
];

export default {
  name: "verifier-drops-false-positive",
  config: { verify: true },
  diff: newFileDiff("src/discount.ts", LINES),
  fileContents: { "src/discount.ts": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/discount.ts",
        5,
        "Percentage not divided by 100",
        "discountPercent is a 0-100 percentage but is used as a fraction; a 10% discount charges -900%.",
      ),
      finding(
        "src/discount.ts",
        2,
        "discountPercent is not validated",
        "The discount percentage is used without any range validation.",
      ),
    ]),
    JSON.stringify([
      { id: 1, verdict: "keep", evidence: "src/discount.ts:5 — Math.round(totalCents * (1 - discountPercent))" },
      {
        id: 2,
        verdict: "drop",
        reason: "false-claim",
        // Verbatim quote of the guard that proves the "not validated" claim false
        // (feature #1 requires a grounded quote, not prose, for a drop to stick).
        evidence: "src/discount.ts:2 — if (discountPercent < 0 || discountPercent > 100) {",
      },
    ]),
  ],
  expectedFindings: [{ file: "src/discount.ts", lineRange: [5, 5], mustMatch: "fraction|divided|percentage" }],
};
