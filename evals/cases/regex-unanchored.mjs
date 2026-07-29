import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  "export function isValidUsername(name) {",
  "  return /[a-z0-9_]{3,16}/.test(name);",
  "}",
];

export default {
  name: "regex-unanchored",
  diff: newFileDiff("src/validate.js", LINES),
  fileContents: { "src/validate.js": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/validate.js",
        2,
        "Validation regex is not anchored",
        'Without ^ and $ the test passes for any string CONTAINING a valid run, e.g. "!!admin!!"; anchor the pattern.',
        { severity: "high", category: "security" },
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/validate.js", lineRange: [2, 2], mustMatch: "anchor|\\^" }],
};
