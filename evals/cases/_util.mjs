/** Shared helpers for eval case fixtures. Files starting with "_" are not cases. */

/**
 * Build a single-hunk unified diff for a modified file.
 * `lines` is an array of [type, text] with type "ctx" | "add" | "del".
 * Old/new counts in the @@ header are computed so the engine's parser
 * consumes every line.
 */
export function hunkDiff(path, { oldStart = 1, newStart = 1, lines }) {
  const oldCount = lines.filter(([t]) => t !== "add").length;
  const newCount = lines.filter(([t]) => t !== "del").length;
  const body = lines
    .map(([t, s]) => (t === "add" ? "+" : t === "del" ? "-" : " ") + s)
    .join("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    body,
  ].join("\n");
}

/** Build a new-file diff; every content line is an added line (line N = index N+1). */
export function newFileDiff(path, contentLines) {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..2222222 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${contentLines.length} @@`,
    contentLines.map((l) => `+${l}`).join("\n"),
  ].join("\n");
}

/** Shorthand for a mock reviewer finding. */
export function finding(file, line, title, body, { severity = "high", category = "bug" } = {}) {
  return { severity, category, file, line, title, body };
}
