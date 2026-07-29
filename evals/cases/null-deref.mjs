import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  "export interface User { name?: { first: string } }",
  "",
  "export function greet(user: User): string {",
  "  return `Hello ${user.name.first}`;",
  "}",
];

export default {
  name: "null-deref",
  diff: newFileDiff("src/user.ts", LINES),
  fileContents: { "src/user.ts": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/user.ts",
        4,
        "Possible null dereference of user.name",
        "user.name is optional but is dereferenced without a check; greet crashes when name is undefined.",
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/user.ts", lineRange: [3, 5], mustMatch: "null|undefined|optional" }],
};
