import { describe, expect, it } from "vitest";
import { appendRunLog, readRunLog, summarizeRunLog } from "./runlog";
import type { RunLogRecord } from "./runlog";

const record = (over: Partial<RunLogRecord> = {}): RunLogRecord => ({
  pr: "anshace/demo#7",
  timestamp: "2026-07-29T00:00:00.000Z",
  model: "mock",
  inputTokens: 100,
  outputTokens: 20,
  estCostUsd: 0.001,
  findingsKept: 2,
  findingsDropped: 3,
  dropReasons: { "style-nit": 2, duplicate: 1 },
  verifierDropped: 0,
  escalated: false,
  incremental: true,
  ...over,
});

describe("appendRunLog (7.5)", () => {
  it("appends exactly one JSONL line with the caller-supplied timestamp", () => {
    const lines: string[] = [];
    appendRunLog("run.log", record(), { appendFile: (_p, line) => lines.push(line) });
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0])).toMatchObject({ pr: "anshace/demo#7", timestamp: "2026-07-29T00:00:00.000Z" });
  });

  it("is best-effort: an IO failure never throws", () => {
    expect(() =>
      appendRunLog("run.log", record(), {
        appendFile: () => {
          throw new Error("read-only fs");
        },
      }),
    ).not.toThrow();
  });
});

describe("readRunLog", () => {
  it("reads records back, skipping corrupt and foreign lines", () => {
    const text = [JSON.stringify(record()), "{corrupt", JSON.stringify({ noPr: true }), "", JSON.stringify(record({ pr: "x/y#1" }))].join("\n");
    const records = readRunLog("run.log", { readFile: () => text });
    expect(records.map((r) => r.pr)).toEqual(["anshace/demo#7", "x/y#1"]);
  });

  it("absent file → empty list", () => {
    expect(
      readRunLog("run.log", {
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toEqual([]);
  });
});

describe("summarizeRunLog", () => {
  it("rolls up totals, histograms, and per-model counts", () => {
    const summary = summarizeRunLog([
      record(),
      record({ model: "claude-haiku-4-5", escalated: true, incremental: false, dropReasons: { duplicate: 2 }, verifierDropped: 1, estCostUsd: 0.01 }),
    ]);
    expect(summary.runs).toBe(2);
    expect(summary.totalInputTokens).toBe(200);
    expect(summary.totalOutputTokens).toBe(40);
    expect(summary.totalEstCostUsd).toBeCloseTo(0.011);
    expect(summary.findingsKept).toBe(4);
    expect(summary.findingsDropped).toBe(6);
    expect(summary.dropReasons).toEqual({ "style-nit": 2, duplicate: 3 });
    expect(summary.verifierDropped).toBe(1);
    expect(summary.escalatedRuns).toBe(1);
    expect(summary.incrementalRuns).toBe(1);
    expect(summary.byModel).toEqual({ mock: 1, "claude-haiku-4-5": 1 });
  });
});
