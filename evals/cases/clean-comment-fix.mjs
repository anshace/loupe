import { hunkDiff } from "./_util.mjs";

export default {
  name: "clean-comment-fix",
  diff: hunkDiff("src/retry.ts", {
    lines: [
      ["del", "/** Retry an async operation with linear backoff. */"],
      ["add", "/** Retry an async operation with exponential backoff. */"],
      ["ctx", "export async function withRetry(operation, opts) {"],
    ],
  }),
  fileContents: {},
  mockResponses: ["[]"],
  expectedFindings: [],
  expectClean: true,
};
