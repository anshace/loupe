import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  "export const config = {",
  '  endpoint: "https://api.example.com",',
  '  apiKey: "sk-live-8f2b1c9d4e5a6b7c8d9e0f1a2b3c4d5e",',
  "};",
];

export default {
  name: "secret-in-code",
  diff: newFileDiff("src/config.ts", LINES),
  fileContents: { "src/config.ts": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/config.ts",
        3,
        "Hardcoded live API key committed to the repo",
        "A production secret is committed in source; move it to an environment variable and rotate the key.",
        { severity: "critical", category: "security" },
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/config.ts", lineRange: [3, 3], mustMatch: "secret|api key|hardcoded" }],
};
