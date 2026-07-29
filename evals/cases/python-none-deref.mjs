import { finding, newFileDiff } from "./_util.mjs";

const LINES = [
  "def find_item(items, name):",
  "    for item in items:",
  "        if item.name == name:",
  "            return item",
  "    return None",
  "",
  "def item_price(items, name):",
  "    return find_item(items, name).price",
];

export default {
  name: "python-none-deref",
  diff: newFileDiff("src/store.py", LINES),
  fileContents: { "src/store.py": LINES.join("\n") },
  mockResponses: [
    JSON.stringify([
      finding(
        "src/store.py",
        8,
        "AttributeError when the item is missing",
        "find_item returns None for unknown names; .price on None raises AttributeError.",
      ),
    ]),
  ],
  expectedFindings: [{ file: "src/store.py", lineRange: [7, 8], mustMatch: "None|AttributeError" }],
};
