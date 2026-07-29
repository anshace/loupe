import { finding, hunkDiff } from "./_util.mjs";

// Seeded from the testbed's src/slugify.js truncateSlug.
const FILE = [
  "/** Truncate a slug to maxLength without cutting mid-word where possible. */",
  "function truncateSlug(slug, maxLength = 60) {",
  "  if (slug.length < maxLength) return slug;",
  "  const cut = slug.slice(0, maxLength);",
  '  const lastDash = cut.lastIndexOf("-");',
  "  return lastDash > 0 ? cut.slice(0, lastDash) : cut;",
  "}",
];

export default {
  name: "slug-truncate-off-by-one",
  diff: hunkDiff("src/slugify.js", {
    oldStart: 10,
    newStart: 10,
    lines: [
      ["ctx", FILE[0]],
      ["ctx", FILE[1]],
      ["del", "  if (slug.length <= maxLength) return slug;"],
      ["add", FILE[2]],
      ["ctx", FILE[3]],
      ["ctx", FILE[4]],
      ["ctx", FILE[5]],
      ["ctx", FILE[6]],
    ],
  }),
  fileContents: {
    "src/slugify.js": Array(9).fill("// header").concat(FILE).join("\n"),
  },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/slugify.js",
        12,
        "Boundary change truncates slugs that exactly fit",
        "Changing <= to < makes a slug of exactly maxLength go through truncation and lose its last word.",
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/slugify.js", lineRange: [12, 12], mustMatch: "exact|boundary|maxLength" }],
};
