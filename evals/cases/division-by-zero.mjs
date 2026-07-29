import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  "export function averageCents(totals: number[]): number {",
  "  const sum = totals.reduce((a, b) => a + b, 0);",
  "  return Math.round(sum / totals.length);",
  "}",
];

export default {
  name: "division-by-zero",
  diff: newFileDiff("src/average.ts", LINES),
  fileContents: { "src/average.ts": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/average.ts",
        3,
        "Division by zero for an empty array",
        "totals.length can be 0, making the result NaN; guard the empty case.",
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/average.ts", lineRange: [3, 3], mustMatch: "zero|empty|NaN" }],
};
