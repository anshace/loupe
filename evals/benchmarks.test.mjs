import { describe, expect, it } from "vitest";
import {
  adaptRecords,
  addedLines,
  codeReviewerCase,
  isTruthyLabel,
  KNOWN_FORMATS,
  loadDataset,
  normalizeCwe,
  parseJsonl,
  primeVulCase,
  renderBenchmarkCaseModule,
} from "./benchmarks.mjs";

describe("parseJsonl (benchmark adapters)", () => {
  it("parses object-per-line and skips blank/corrupt lines", () => {
    const text = '{"a":1}\n\n{not json}\n{"b":2}\n';
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips non-object JSON values (bare arrays/scalars)", () => {
    expect(parseJsonl('[1,2]\n5\n"x"\n{"ok":true}\n')).toEqual([{ ok: true }]);
  });
});

describe("addedLines (benchmark adapters)", () => {
  it("returns the content of added lines, excluding the +++ header", () => {
    const patch = ["--- a/x", "+++ b/x", "@@ -1,1 +1,2 @@", " ctx", "+new line", "-old"].join("\n");
    expect(addedLines(patch)).toEqual(["new line"]);
  });
});

describe("label + cwe coercion (benchmark adapters)", () => {
  it("isTruthyLabel handles 1 / true / 'yes' / 'vulnerable' and rejects 0 / false", () => {
    expect(isTruthyLabel(1)).toBe(true);
    expect(isTruthyLabel("1")).toBe(true);
    expect(isTruthyLabel(true)).toBe(true);
    expect(isTruthyLabel("vulnerable")).toBe(true);
    expect(isTruthyLabel(0)).toBe(false);
    expect(isTruthyLabel("0")).toBe(false);
    expect(isTruthyLabel(undefined)).toBe(false);
  });

  it("normalizeCwe accepts array / string / number / absent", () => {
    expect(normalizeCwe(["CWE-79", "CWE-89"])).toEqual(["CWE-79", "CWE-89"]);
    expect(normalizeCwe("CWE-79")).toEqual(["CWE-79"]);
    expect(normalizeCwe(89)).toEqual(["89"]);
    expect(normalizeCwe(undefined)).toEqual([]);
    expect(normalizeCwe("")).toEqual([]);
  });
});

describe("codeReviewerCase (benchmark adapters)", () => {
  it("adapts a diff+comment record into a live-mode region-level case", () => {
    const c = codeReviewerCase(
      {
        id: 42,
        lang: "python",
        patch: ["@@ -1,1 +1,2 @@", " def f():", "+    os.system(cmd)  # runs shell"].join("\n"),
        msg: "possible command injection via os.system",
      },
      0,
    );
    expect(c.name).toBe("bench-codereviewer-42");
    expect(c.fileContents["benchmark/codereviewer/42.py"]).toBe("    os.system(cmd)  # runs shell");
    expect(c.expectedFindings[0]).toEqual({
      file: "benchmark/codereviewer/42.py",
      lineRange: [1, 1],
      category: "security",
    });
    expect(c.source).toMatchObject({ benchmark: "codereviewer", id: 42, comment: "possible command injection via os.system" });
    expect("mockResponses" in c).toBe(false); // live-mode only
  });

  it("tolerates alternate field names (diff / comment / idx)", () => {
    const c = codeReviewerCase({ idx: 7, diff: "@@ -1 +1,1 @@\n+x = 1", comment: "nit: name it" }, 0);
    expect(c.name).toBe("bench-codereviewer-7");
    expect(c.expectedFindings[0].file).toBe("benchmark/codereviewer/7.txt"); // no lang → txt
  });

  it("returns undefined for records with no patch or an empty comment", () => {
    expect(codeReviewerCase({ msg: "hi" }, 0)).toBeUndefined();
    expect(codeReviewerCase({ patch: "@@ -1 +1 @@\n+a", msg: "   " }, 0)).toBeUndefined();
    expect(codeReviewerCase({ patch: "@@ -1,1 +1,1 @@\n ctx\n-only removals", msg: "c" }, 0)).toBeUndefined();
  });
});

describe("primeVulCase (benchmark adapters)", () => {
  it("adapts a vulnerable function into a function-grained security case", () => {
    const c = primeVulCase(
      { idx: "p1", target: 1, cwe: "CWE-787", cve: "CVE-2020-1", func: "int f() {\n  gets(buf);\n}\n" },
      0,
    );
    expect(c.name).toBe("bench-primevul-p1");
    expect(c.fileContents["benchmark/primevul/p1.c"]).toBe("int f() {\n  gets(buf);\n}");
    expect(c.expectedFindings[0]).toEqual({ file: "benchmark/primevul/p1.c", lineRange: [1, 3], category: "security" });
    expect(c.source).toMatchObject({ benchmark: "primevul", cwe: ["CWE-787"], cve: "CVE-2020-1" });
    expect("mockResponses" in c).toBe(false);
  });

  it("skips benign (label 0) samples — only vulnerable ones are gold positives", () => {
    expect(primeVulCase({ idx: 2, target: 0, func: "int ok() { return 0; }" }, 0)).toBeUndefined();
  });

  it("returns undefined when the function body is empty/missing", () => {
    expect(primeVulCase({ idx: 3, target: 1, func: "   " }, 0)).toBeUndefined();
    expect(primeVulCase({ idx: 4, target: 1 }, 0)).toBeUndefined();
  });
});

describe("adaptRecords (benchmark adapters)", () => {
  it("adapts many records, counts skips, and disambiguates name collisions", () => {
    const records = [
      { id: 1, patch: "@@ -1 +1,1 @@\n+a", msg: "x" },
      { id: 1, patch: "@@ -1 +1,1 @@\n+b", msg: "y" }, // duplicate id → name collision
      { msg: "no patch" }, // skipped
    ];
    const { cases, skipped } = adaptRecords(records, "codereviewer");
    expect(skipped).toBe(1);
    expect(cases.map((c) => c.name)).toEqual(["bench-codereviewer-1", "bench-codereviewer-1-1"]);
  });

  it("honors the limit", () => {
    const records = Array.from({ length: 5 }, (_, i) => ({ id: i, patch: "@@ -1 +1,1 @@\n+x", msg: "c" }));
    const { cases } = adaptRecords(records, "codereviewer", { limit: 2 });
    expect(cases).toHaveLength(2);
  });

  it("throws on an unknown format", () => {
    expect(() => adaptRecords([], "nope")).toThrow(/unknown benchmark format/);
    expect(KNOWN_FORMATS).toContain("codereviewer");
    expect(KNOWN_FORMATS).toContain("primevul");
  });
});

describe("renderBenchmarkCaseModule (benchmark adapters)", () => {
  it("emits a valid ES module whose default export round-trips", () => {
    const c = codeReviewerCase({ id: 9, patch: "@@ -1 +1,1 @@\n+z", msg: "c" }, 0);
    const src = renderBenchmarkCaseModule(c);
    expect(src).toContain("export default {");
    const json = JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1));
    expect(json.name).toBe("bench-codereviewer-9");
  });
});

describe("loadDataset (benchmark adapters) — LOCAL, injected IO", () => {
  it("no-ops with reason 'absent' when the path is empty or missing (no network)", () => {
    const io = { exists: () => false, read: () => { throw new Error("must not read"); } };
    expect(loadDataset("", io)).toEqual({ records: [], reason: "absent" });
    expect(loadDataset("/nope.jsonl", io)).toEqual({ records: [], reason: "absent" });
  });

  it("reads and parses an existing local file", () => {
    const io = { exists: () => true, read: () => '{"a":1}\n{"b":2}\n' };
    expect(loadDataset("/ds.jsonl", io)).toEqual({ records: [{ a: 1 }, { b: 2 }], reason: "ok" });
  });

  it("returns reason 'unreadable' on an IO error rather than throwing", () => {
    const io = { exists: () => true, read: () => { throw new Error("EACCES"); } };
    const r = loadDataset("/ds.jsonl", io);
    expect(r.reason).toBe("unreadable");
    expect(r.records).toEqual([]);
  });
});
