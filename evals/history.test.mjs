import { describe, expect, it } from "vitest";
import {
  appendHistory,
  buildHistoryHtml,
  computeMetrics,
  makeHistoryRecord,
  readHistory,
  renderHistoryHtml,
} from "./history.mjs";

/** In-memory IO so tests never touch the filesystem. */
function memIo() {
  const files = new Map();
  return {
    files,
    append: (p, line) => files.set(p, (files.get(p) ?? "") + line),
    read: (p) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p);
    },
    write: (p, text) => files.set(p, text),
  };
}

describe("computeMetrics (#11)", () => {
  it("computes precision/recall/fpRate/dropRate from aggregate counts", () => {
    const m = computeMetrics({ expectedFound: 3, expectedMissed: 1, unexpected: 1, verifierDropped: 1 });
    expect(m.precision).toBe(0.75); // 3/(3+1)
    expect(m.recall).toBe(0.75); // 3/(3+1)
    expect(m.fpRate).toBe(0.25); // 1/(3+1)
    expect(m.dropRate).toBe(0.2); // 1/(3+1+1)
  });

  it("is zero-safe with no data (never divides by zero)", () => {
    expect(computeMetrics({})).toEqual({ precision: 0, recall: 0, fpRate: 0, dropRate: 0 });
  });

  it("rounds to 4 decimals for stable comparisons across runs", () => {
    const m = computeMetrics({ expectedFound: 1, expectedMissed: 2, unexpected: 0, verifierDropped: 0 });
    expect(m.recall).toBe(0.3333); // 1/3 rounded
  });
});

describe("makeHistoryRecord (#11)", () => {
  it("passes date/sha through verbatim (never reads the clock) and folds in metrics", () => {
    const rec = makeHistoryRecord({
      date: "2026-07-30",
      sha: "deadbeef",
      promptVersion: "reviewer-v9",
      model: "mock",
      cases: 22,
      totals: { expectedFound: 2, expectedMissed: 0, unexpected: 0, verifierDropped: 0 },
    });
    expect(rec.date).toBe("2026-07-30");
    expect(rec.sha).toBe("deadbeef");
    expect(rec.promptVersion).toBe("reviewer-v9");
    expect(rec.cases).toBe(22);
    expect(rec.precision).toBe(1);
    expect(rec.recall).toBe(1);
  });

  it("fills sensible defaults for missing identity fields", () => {
    const rec = makeHistoryRecord({ totals: {} });
    expect(rec.date).toBe("unknown");
    expect(rec.sha).toBe("unknown");
    expect(rec.model).toBe("mock");
  });
});

describe("appendHistory / readHistory (#11)", () => {
  it("appends JSONL and reads it back in order", () => {
    const io = memIo();
    const p = "hist.jsonl";
    appendHistory({ date: "2026-07-01", sha: "a", precision: 0.5 }, io, p);
    appendHistory({ date: "2026-07-02", sha: "b", precision: 0.9 }, io, p);
    const recs = readHistory(io, p);
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.sha)).toEqual(["a", "b"]);
  });

  it("returns [] for a missing file and skips corrupt lines", () => {
    const io = memIo();
    expect(readHistory(io, "nope.jsonl")).toEqual([]);
    io.write("h.jsonl", '{"date":"2026-07-01","sha":"a"}\nnot json\n{"no date":true}\n');
    const recs = readHistory(io, "h.jsonl");
    expect(recs).toHaveLength(1); // only the well-formed, date-bearing line
  });
});

describe("renderHistoryHtml (#11) — self-contained, never uploaded", () => {
  const records = [
    makeHistoryRecord({
      date: "2026-07-29",
      sha: "aaa1111",
      promptVersion: "reviewer-v9",
      model: "mock",
      cases: 22,
      totals: { expectedFound: 18, expectedMissed: 4, unexpected: 2, verifierDropped: 1 },
    }),
    makeHistoryRecord({
      date: "2026-07-30",
      sha: "bbb2222",
      promptVersion: "reviewer-v9",
      model: "mock",
      cases: 22,
      totals: { expectedFound: 20, expectedMissed: 2, unexpected: 1, verifierDropped: 1 },
    }),
  ];

  it("produces a complete HTML document with the run rows", () => {
    const html = renderHistoryHtml(records);
    expect(html.startsWith("<!doctype html")).toBe(true);
    expect(html).toContain("aaa1111");
    expect(html).toContain("bbb2222");
    expect(html).toContain("reviewer-v9");
  });

  it("embeds everything inline — no external requests (works offline)", () => {
    const html = renderHistoryHtml(records);
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("<script");
    expect(/\ssrc=|\shref=/.test(html)).toBe(false); // no external CSS/JS/img
  });

  it("renders a valid empty state with no records", () => {
    const html = renderHistoryHtml([]);
    expect(html).toContain("No runs recorded yet");
  });
});

describe("buildHistoryHtml (#11)", () => {
  it("reads the JSONL and writes an HTML file via injected IO", () => {
    const io = memIo();
    appendHistory({ date: "2026-07-30", sha: "z1", precision: 1, recall: 1, fpRate: 0, dropRate: 0, cases: 1 }, io, "h.jsonl");
    const out = buildHistoryHtml(io, "h.jsonl", "h.html");
    expect(out).toBe("h.html");
    expect(io.files.get("h.html").startsWith("<!doctype html")).toBe(true);
    expect(io.files.get("h.html")).toContain("z1");
  });
});
