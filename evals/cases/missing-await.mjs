import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  "export async function saveAll(records, store) {",
  "  for (const record of records) {",
  "    store.save(record);",
  "  }",
  "  return records.length;",
  "}",
];

export default {
  name: "missing-await",
  diff: newFileDiff("src/save-all.js", LINES),
  fileContents: { "src/save-all.js": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/save-all.js",
        3,
        "Async save is not awaited",
        "store.save returns a promise that is discarded; failures are swallowed and callers see success before writes finish.",
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/save-all.js", lineRange: [3, 3], mustMatch: "await|promise" }],
};
