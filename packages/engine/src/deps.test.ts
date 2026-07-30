import { describe, expect, it } from "vitest";
import { auditDependencies, scanDependencyChanges } from "./deps";
import type { NewDependency } from "./deps";
import type { FetchLike } from "./diff";
import { parseUnifiedDiff } from "./diff";

/** A modified file from typed [type, text] rows. */
function fileDiff(path: string, rows: ReadonlyArray<["ctx" | "add" | "del", string]>) {
  const oldCount = rows.filter(([t]) => t !== "add").length;
  const newCount = rows.filter(([t]) => t !== "del").length;
  const body = rows.map(([t, s]) => (t === "add" ? "+" : t === "del" ? "-" : " ") + s).join("\n");
  const diff = [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    body,
  ].join("\n");
  return parseUnifiedDiff(diff);
}

describe("scanDependencyChanges — new deps", () => {
  it("flags newly-added manifest dependencies as one heads-up finding", () => {
    const files = fileDiff("package.json", [
      ["ctx", '  "dependencies": {'],
      ["ctx", '    "react": "^18.0.0",'],
      ["add", '    "left-pad": "^1.3.0",'],
      ["add", '    "lodash": "4.17.21"'],
      ["ctx", "  }"],
    ]);
    const { findings, newDeps } = scanDependencyChanges(files);
    expect(newDeps.map((d) => d.name).sort()).toEqual(["left-pad", "lodash"]);
    const headsUp = findings.find((f) => f.category === "dependency");
    expect(headsUp).toBeDefined();
    expect(headsUp?.title).toContain("2");
    expect(headsUp?.body).toContain("left-pad");
  });

  it("ignores non-dependency string fields (name/version/license) and non-version values", () => {
    const files = fileDiff("package.json", [
      ["add", '  "name": "my-pkg",'],
      ["add", '  "license": "MIT",'],
      ["add", '  "description": "a thing",'],
    ]);
    expect(scanDependencyChanges(files).newDeps).toHaveLength(0);
  });

  it("does not scan non-manifest JSON files", () => {
    const files = fileDiff("config.json", [["add", '    "lodash": "^4.17.21",']]);
    expect(scanDependencyChanges(files).newDeps).toHaveLength(0);
  });
});

describe("scanDependencyChanges — install scripts", () => {
  it("flags a new dep whose lockfile entry declares hasInstallScript", () => {
    const manifest = fileDiff("package.json", [["add", '    "sharp": "^0.33.0",']]);
    const lock = fileDiff("package-lock.json", [
      ["add", '    "node_modules/sharp": {'],
      ["add", '      "version": "0.33.0",'],
      ["add", '      "hasInstallScript": true,'],
      ["add", "    }"],
    ]);
    const files = [...manifest, ...lock];
    const { findings, newDeps } = scanDependencyChanges(files);
    expect(newDeps.find((d) => d.name === "sharp")?.hasInstallScript).toBe(true);
    const supply = findings.find((f) => f.category === "supply-chain");
    expect(supply?.severity).toBe("high");
    expect(supply?.title).toContain("sharp");
  });
});

describe("auditDependencies", () => {
  const dep: NewDependency = {
    name: "left-pad",
    version: "^1.3.0",
    file: "package.json",
    line: 3,
    hasInstallScript: false,
  };

  function fetchStub(osvVulns: string[][], license?: string): FetchLike {
    return async (url: string) => {
      if (url.includes("osv.dev")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ results: osvVulns.map((ids) => ({ vulns: ids.map((id) => ({ id })) })) }),
        };
      }
      // npm registry
      return { ok: true, status: 200, text: async () => JSON.stringify({ license: license ?? "MIT" }) };
    };
  }

  it("emits a supply-chain finding for a dep with a known CVE", async () => {
    const { findings, notices } = await auditDependencies([dep], fetchStub([["CVE-2020-1234", "GHSA-xxxx"]]), {
      checkLicenses: false,
    });
    const cve = findings.find((f) => f.title.includes("Known vulnerability"));
    expect(cve?.severity).toBe("high");
    expect(cve?.body).toContain("CVE-2020-1234");
    expect(notices.join(" ")).toContain("CVE");
  });

  it("flags a copyleft license as a low heads-up", async () => {
    const { findings } = await auditDependencies([dep], fetchStub([[]], "GPL-3.0"));
    const lic = findings.find((f) => f.title.includes("Copyleft"));
    expect(lic?.severity).toBe("low");
    expect(lic?.title).toContain("GPL-3.0");
  });

  it("does not flag a permissive license", async () => {
    const { findings } = await auditDependencies([dep], fetchStub([[]], "MIT"));
    expect(findings.some((f) => f.title.includes("Copyleft"))).toBe(false);
  });

  it("is fail-soft when OSV throws", async () => {
    const boom: FetchLike = async () => {
      throw new Error("network down");
    };
    const res = await auditDependencies([dep], boom, { checkLicenses: false });
    expect(res.findings).toEqual([]);
  });
});
