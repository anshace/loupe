import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  'import { open } from "node:fs/promises";',
  "",
  "export async function firstLine(path) {",
  "  const handle = await open(path);",
  "  const content = await handle.readFile({ encoding: \"utf8\" });",
  '  return content.split("\\n")[0];',
  "}",
];

export default {
  name: "resource-leak",
  diff: newFileDiff("src/first-line.js", LINES),
  fileContents: { "src/first-line.js": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/first-line.js",
        4,
        "File handle is never closed",
        "The handle from open() leaks on every call (and on readFile errors); close it in a finally block.",
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/first-line.js", lineRange: [4, 6], mustMatch: "close|leak" }],
};
