import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  'import { exec } from "node:child_process";',
  "",
  "export function convert(userPath) {",
  "  exec(`convert ${userPath} out.png`);",
  "}",
];

export default {
  name: "command-injection",
  diff: newFileDiff("src/convert.js", LINES),
  fileContents: { "src/convert.js": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/convert.js",
        4,
        "Command injection via user-controlled path",
        "userPath is interpolated into a shell command; use execFile with an argument array.",
        { severity: "critical", category: "security" },
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/convert.js", lineRange: [4, 4], mustMatch: "injection|execFile|shell" }],
};
