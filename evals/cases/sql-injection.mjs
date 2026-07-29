import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  "export async function findUser(db, username) {",
  "  const query = `SELECT * FROM users WHERE name = '${username}'`;",
  "  return db.raw(query);",
  "}",
];

export default {
  name: "sql-injection",
  diff: newFileDiff("src/db/find-user.js", LINES),
  fileContents: { "src/db/find-user.js": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/db/find-user.js",
        2,
        "SQL injection via string interpolation",
        "username is interpolated directly into the SQL string; use a parameterized query.",
        { severity: "critical", category: "security" },
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/db/find-user.js", lineRange: [2, 3], mustMatch: "injection|parameteri" }],
};
