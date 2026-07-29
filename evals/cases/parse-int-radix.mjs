import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  "export function parsePort(raw) {",
  "  const port = parseInt(raw);",
  "  return port;",
  "}",
];

export default {
  name: "parse-int-radix",
  diff: newFileDiff("src/port.js", LINES),
  fileContents: { "src/port.js": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/port.js",
        2,
        "parseInt result is not validated",
        "parseInt returns NaN for non-numeric input (and honors legacy octal-ish prefixes without a radix); the value is returned unchecked.",
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/port.js", lineRange: [2, 3], mustMatch: "NaN|radix" }],
};
