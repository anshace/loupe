import { hunkDiff } from "./_util.mjs";

export default {
  name: "clean-docs-only",
  diff: hunkDiff("README.md", {
    lines: [
      ["ctx", "# my-app"],
      ["del", "Run `npm start` to boot."],
      ["add", "Run `npm run dev` to boot with hot reload."],
      ["add", "See docs/setup.md for prerequisites."],
    ],
  }),
  fileContents: {},
  mockResponses: ["[]"],
  expectedFindings: [],
  expectClean: true,
};
