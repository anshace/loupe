import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  "export function addDays(base, days) {",
  "  base.setDate(base.getDate() + days);",
  "  return base;",
  "}",
];

export default {
  name: "shared-date-mutation",
  diff: newFileDiff("src/dates.js", LINES),
  fileContents: { "src/dates.js": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/dates.js",
        2,
        "Caller's Date object is mutated",
        "setDate mutates the argument in place, corrupting the caller's date; construct a new Date instead.",
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/dates.js", lineRange: [2, 2], mustMatch: "mutat|new Date" }],
};
