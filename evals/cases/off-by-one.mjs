import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  "export function sum(values: number[]): number {",
  "  let total = 0;",
  "  for (let i = 0; i <= values.length; i++) {",
  "    total += values[i];",
  "  }",
  "  return total;",
  "}",
];

export default {
  name: "off-by-one",
  diff: newFileDiff("src/sum.ts", LINES),
  fileContents: { "src/sum.ts": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/sum.ts",
        3,
        "Off-by-one loop bound",
        "The loop uses i <= values.length, so the last iteration reads values[values.length] (undefined) and total becomes NaN.",
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/sum.ts", lineRange: [3, 4], mustMatch: "off-by-one|<=|out of bounds" }],
};
