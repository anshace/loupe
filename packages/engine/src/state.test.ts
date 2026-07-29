import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff";
import {
  FileStateStore,
  KvStateStore,
  carryForwardOpenFindings,
  findingKey,
  hashHunk,
  hashHunks,
  mergeFindings,
  parsePrState,
  prStateKey,
} from "./state";
import type { KvLike, PrState } from "./state";
import type { Finding } from "./types";

const finding = (over: Partial<Finding> = {}): Finding => ({
  severity: "high",
  category: "bug",
  file: "src/a.ts",
  line: 10,
  title: "Bug",
  body: "b",
  ...over,
});

const STATE: PrState = {
  lastReviewedSha: "abc123",
  hunkHashes: ["h1", "h2"],
  openFindings: [finding()],
};

describe("prStateKey", () => {
  it("is owner/repo#number", () => {
    expect(prStateKey({ owner: "anshace", repo: "demo", prNumber: 7 })).toBe("anshace/demo#7");
  });
});

describe("parsePrState", () => {
  it("round-trips a valid state", () => {
    expect(parsePrState(JSON.parse(JSON.stringify(STATE)))).toEqual(STATE);
  });

  it("rejects junk shapes", () => {
    expect(parsePrState(null)).toBeNull();
    expect(parsePrState("nope")).toBeNull();
    expect(parsePrState({})).toBeNull();
    expect(parsePrState({ lastReviewedSha: "" })).toBeNull();
  });

  it("drops malformed hashes and findings but keeps the rest", () => {
    const parsed = parsePrState({
      lastReviewedSha: "abc",
      hunkHashes: ["ok", 42, null],
      openFindings: [finding(), { file: "x" }, "junk"],
    });
    expect(parsed).toEqual({ lastReviewedSha: "abc", hunkHashes: ["ok"], openFindings: [finding()] });
  });
});

function mapKv(): KvLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key) => map.get(key) ?? null,
    put: async (key, value) => {
      map.set(key, value);
    },
  };
}

describe("KvStateStore (7.1a)", () => {
  it("round-trips state through a Map-backed KV", async () => {
    const kv = mapKv();
    const store = new KvStateStore(kv);
    await store.set("anshace/demo#7", STATE);
    expect(kv.map.has("prstate:anshace/demo#7")).toBe(true);
    expect(await store.get("anshace/demo#7")).toEqual(STATE);
  });

  it("returns null for missing or corrupt entries", async () => {
    const kv = mapKv();
    const store = new KvStateStore(kv);
    expect(await store.get("nothing")).toBeNull();
    kv.map.set("prstate:bad", "{not json");
    expect(await store.get("bad")).toBeNull();
  });
});

describe("FileStateStore (7.1b)", () => {
  function memFs(initial?: string): { io: { readFile: (p: string) => string; writeFile: (p: string, c: string) => void }; content: () => string | undefined } {
    let file = initial;
    return {
      io: {
        readFile: () => {
          if (file === undefined) throw new Error("ENOENT");
          return file;
        },
        writeFile: (_p, content) => {
          file = content;
        },
      },
      content: () => file,
    };
  }

  it("round-trips state through a flat JSON file", async () => {
    const fs = memFs();
    const store = new FileStateStore("state.json", fs.io);
    expect(await store.get("anshace/demo#7")).toBeNull(); // absent file
    await store.set("anshace/demo#7", STATE);
    expect(await store.get("anshace/demo#7")).toEqual(STATE);
  });

  it("preserves other PRs' entries on write", async () => {
    const fs = memFs(JSON.stringify({ "anshace/demo#1": { ...STATE, lastReviewedSha: "old1" } }));
    const store = new FileStateStore("state.json", fs.io);
    await store.set("anshace/demo#2", STATE);
    expect(await store.get("anshace/demo#1")).toEqual({ ...STATE, lastReviewedSha: "old1" });
    expect(await store.get("anshace/demo#2")).toEqual(STATE);
  });

  it("treats a corrupt file as empty instead of crashing", async () => {
    const fs = memFs("{{{{");
    const store = new FileStateStore("state.json", fs.io);
    expect(await store.get("anything")).toBeNull();
    await store.set("k", STATE); // still writable
    expect(await store.get("k")).toEqual(STATE);
  });
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,3 @@ function f() {
 context
-old
+new
 tail
@@ -30,2 +30,3 @@ function g() {
 keep
+added
 end`;

describe("hashHunk / hashHunks (7.2)", () => {
  const files = parseUnifiedDiff(DIFF);

  it("is deterministic and distinct per hunk content", () => {
    const [h1, h2] = files[0].hunks;
    expect(hashHunk("src/a.ts", h1)).toBe(hashHunk("src/a.ts", h1));
    expect(hashHunk("src/a.ts", h1)).not.toBe(hashHunk("src/a.ts", h2));
    expect(hashHunk("src/a.ts", h1)).not.toBe(hashHunk("src/OTHER.ts", h1));
    expect(hashHunk("src/a.ts", h1)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores line-number shifts (same content, moved hunk)", () => {
    const shifted = parseUnifiedDiff(DIFF.replace("@@ -10,3 +10,3 @@", "@@ -50,3 +52,3 @@"));
    expect(hashHunk("src/a.ts", shifted[0].hunks[0])).toBe(hashHunk("src/a.ts", files[0].hunks[0]));
  });

  it("hashHunks flattens all files' hunks", () => {
    expect(hashHunks(files)).toHaveLength(2);
  });
});

describe("mergeFindings", () => {
  it("dedupes by file+line+title, keeping first occurrence order", () => {
    const a = finding({ title: "One" });
    const b = finding({ title: "Two", line: 20 });
    const merged = mergeFindings([a, b], [finding({ title: "one" }), finding({ title: "Three" })]);
    expect(merged.map((f) => f.title)).toEqual(["One", "Two", "Three"]);
    expect(findingKey(a)).toBe(findingKey(finding({ title: " ONE " })));
  });
});

describe("carryForwardOpenFindings (7.3)", () => {
  const changed = parseUnifiedDiff(DIFF);

  it("keeps findings in files the range never touched", () => {
    const open = [finding({ file: "src/untouched.ts", line: 3 })];
    const result = carryForwardOpenFindings(open, changed);
    expect(result.stillOpen).toEqual(open);
    expect(result.resolved).toEqual([]);
  });

  it("resolves findings whose old-side lines a hunk changed", () => {
    const hit = finding({ file: "src/a.ts", line: 11 }); // inside @@ -10,3
    const miss = finding({ file: "src/a.ts", line: 20, title: "Elsewhere" });
    const result = carryForwardOpenFindings([hit, miss], changed);
    expect(result.resolved).toEqual([hit]);
    expect(result.stillOpen).toEqual([miss]);
  });

  it("resolves findings on deleted files and file-level findings on touched files", () => {
    const deleted = parseUnifiedDiff(`diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b`);
    const onDeleted = finding({ file: "gone.ts", line: 1 });
    expect(carryForwardOpenFindings([onDeleted], deleted).resolved).toEqual([onDeleted]);

    const fileLevel = finding({ file: "src/a.ts", line: undefined });
    expect(carryForwardOpenFindings([fileLevel], changed).resolved).toEqual([fileLevel]);
  });
});
