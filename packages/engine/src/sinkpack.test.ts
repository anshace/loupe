import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff";
import { DEFAULT_MAX_SINKS, renderSinkEvidence, scanSinks } from "./sinkpack";

/** New file where every content line is an added line. */
function newFile(path: string, lines: readonly string[]) {
  const diff = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..2222222 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    lines.map((l) => `+${l}`).join("\n"),
  ].join("\n");
  return parseUnifiedDiff(diff);
}

describe("scanSinks — JS/TS", () => {
  it("flags eval, innerHTML, child_process, SQL concat, and dangerouslySetInnerHTML", () => {
    const files = newFile("src/x.ts", [
      "const out = eval(userInput);",
      "el.innerHTML = data;",
      "exec(`rm -rf ${dir}`);",
      'db.query("SELECT * FROM users WHERE id = " + id);',
      "return <div dangerouslySetInnerHTML={{ __html: html }} />;",
      "const safe = 1 + 2;",
    ]);
    const ids = scanSinks(files).map((m) => m.id);
    expect(ids).toContain("js-eval");
    expect(ids).toContain("js-innerhtml");
    expect(ids).toContain("js-child-process");
    expect(ids).toContain("js-sql-concat");
    expect(ids).toContain("react-dangerously-set-inner-html");
  });

  it("reports the correct file and 1-based new-side line", () => {
    const files = newFile("src/x.ts", ["const a = 1;", "eval(x);"]);
    const m = scanSinks(files).find((s) => s.id === "js-eval");
    expect(m?.file).toBe("src/x.ts");
    expect(m?.line).toBe(2);
    expect(m?.text).toBe("eval(x);");
  });

  it("does not apply JS patterns to Python files (extension-scoped)", () => {
    const files = newFile("src/x.py", ["el.innerHTML = data"]);
    expect(scanSinks(files).some((m) => m.id === "js-innerhtml")).toBe(false);
  });
});

describe("scanSinks — Python", () => {
  it("flags shell=True, os.system, pickle.loads, and yaml.load", () => {
    const files = newFile("app.py", [
      "subprocess.run(cmd, shell=True)",
      "os.system(command)",
      "data = pickle.loads(blob)",
      "cfg = yaml.load(text)",
      "cfg2 = yaml.load(text, Loader=yaml.SafeLoader)",
    ]);
    const ids = scanSinks(files).map((m) => m.id);
    expect(ids).toContain("py-subprocess-shell");
    expect(ids).toContain("py-os-system");
    expect(ids).toContain("py-pickle");
    expect(ids).toContain("py-yaml-load");
    // SafeLoader form is NOT flagged.
    expect(scanSinks(files).filter((m) => m.id === "py-yaml-load")).toHaveLength(1);
  });
});

describe("scanSinks — bounds & purity", () => {
  it("only scans added lines, not deleted/context", () => {
    const diff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "index 1111111..2222222 100644",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,2 +1,2 @@",
      " const ctx = eval(a);", // context line — ignored
      "-const del = eval(b);", // deleted — ignored
      "+const add = safe(c);",
    ].join("\n");
    expect(scanSinks(parseUnifiedDiff(diff))).toHaveLength(0);
  });

  it("caps the number of matches", () => {
    const lines = Array.from({ length: 100 }, () => "eval(x);");
    expect(scanSinks(newFile("src/x.ts", lines), { maxSinks: 5 })).toHaveLength(5);
    expect(scanSinks(newFile("src/x.ts", lines)).length).toBeLessThanOrEqual(DEFAULT_MAX_SINKS);
  });
});

describe("renderSinkEvidence", () => {
  it("returns (none) with no matches", () => {
    expect(renderSinkEvidence([])).toBe("(none)");
  });

  it("renders file:line, label, text, and a reachability question", () => {
    const files = newFile("src/x.ts", ["eval(userInput);"]);
    const out = renderSinkEvidence(scanSinks(files));
    expect(out).toContain("src/x.ts:1");
    expect(out).toContain("eval()");
    expect(out).toContain("reachability");
  });
});
