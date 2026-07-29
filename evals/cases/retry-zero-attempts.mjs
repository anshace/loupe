import { finding, hunkDiff } from "./_util.mjs";

// Seeded from the testbed's src/retry.ts: a guard on attempts was removed.
const FILE = [
  "export async function withRetry(operation, { attempts, baseDelayMs }) {",
  "  let lastError;",
  "  for (let attempt = 0; attempt < attempts; attempt++) {",
  "    try {",
  "      return await operation();",
  "    } catch (err) {",
  "      lastError = err;",
  "    }",
  "  }",
  "  throw lastError;",
  "}",
];

export default {
  name: "retry-zero-attempts",
  diff: hunkDiff("src/retry.ts", {
    oldStart: 1,
    newStart: 1,
    lines: [
      ["ctx", FILE[0]],
      ["del", '  if (attempts < 1) throw new RangeError("attempts must be >= 1");'],
      ["ctx", FILE[1]],
      ["ctx", FILE[2]],
      ["ctx", FILE[3]],
      ["add", FILE[4]],
      ["del", "      return operation();"],
      ["ctx", FILE[5]],
      ["ctx", FILE[6]],
      ["ctx", FILE[7]],
      ["ctx", FILE[8]],
      ["ctx", FILE[9]],
      ["ctx", FILE[10]],
    ],
  }),
  fileContents: { "src/retry.ts": FILE.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/retry.ts",
        5,
        "attempts=0 now throws undefined",
        "With the attempts guard removed, attempts <= 0 skips the loop entirely and `throw lastError` throws undefined.",
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/retry.ts", lineRange: [1, 10], mustMatch: "attempts|undefined" }],
};
