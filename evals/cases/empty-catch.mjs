import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  "export async function chargeCard(gateway, order) {",
  "  try {",
  "    await gateway.charge(order.totalCents);",
  "  } catch (err) {",
  "    // ignore",
  "  }",
  "  order.status = \"paid\";",
  "}",
];

export default {
  name: "empty-catch",
  diff: newFileDiff("src/charge.js", LINES),
  fileContents: { "src/charge.js": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/charge.js",
        4,
        "Failed charge is swallowed and order still marked paid",
        "The catch block discards gateway errors, then the order is unconditionally marked paid — payment failures ship goods for free.",
        { severity: "critical" },
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/charge.js", lineRange: [4, 7], mustMatch: "swallow|paid|catch" }],
};
