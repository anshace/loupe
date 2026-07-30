import { describe, expect, it } from "vitest";
import {
  buildKeepRateTable,
  lowKeepRateShapes,
  preSuppressByCalibration,
  shapeKey,
  tallyShapes,
} from "./calibration";
import type { RunLogRecord } from "./runlog";
import type { Finding } from "./types";

function finding(over: Partial<Finding> = {}): Finding {
  return { severity: "high", category: "bug", file: "a.ts", line: 1, title: "t", body: "b", ...over };
}

function record(over: Partial<RunLogRecord> = {}): RunLogRecord {
  return {
    pr: "o/r#1",
    timestamp: "2026-07-30T00:00:00.000Z",
    inputTokens: 0,
    outputTokens: 0,
    estCostUsd: 0,
    findingsKept: 0,
    findingsDropped: 0,
    dropReasons: {},
    verifierDropped: 0,
    abstained: 0,
    verifierUngrounded: 0,
    escalated: false,
    incremental: false,
    ...over,
  };
}

describe("shapeKey / tallyShapes (#29)", () => {
  it("keys a finding by category|severity", () => {
    expect(shapeKey("security", "critical")).toBe("security|critical");
  });

  it("counts findings per shape", () => {
    const tally = tallyShapes([
      finding({ category: "style", severity: "nit" }),
      finding({ category: "style", severity: "nit" }),
      finding({ category: "bug", severity: "high" }),
    ]);
    expect(tally).toEqual({ "style|nit": 2, "bug|high": 1 });
  });
});

describe("buildKeepRateTable (#29)", () => {
  it("aggregates kept vs dropped shape tallies across records", () => {
    const records = [
      record({ verifierShapes: { kept: { "bug|high": 1 }, dropped: { "style|nit": 3 } } }),
      record({ verifierShapes: { kept: { "bug|high": 1 }, dropped: { "style|nit": 2 } } }),
    ];
    const table = buildKeepRateTable(records);
    expect(table["bug|high"]).toEqual({ kept: 2, dropped: 0, total: 2, keepRate: 1 });
    expect(table["style|nit"]).toEqual({ kept: 0, dropped: 5, total: 5, keepRate: 0 });
  });

  it("ignores records without verifier-shape data", () => {
    expect(buildKeepRateTable([record(), record()])).toEqual({});
  });
});

describe("lowKeepRateShapes (#29)", () => {
  const table = {
    "style|nit": { kept: 1, dropped: 9, total: 10, keepRate: 0.1 }, // low, enough samples
    "bug|high": { kept: 8, dropped: 2, total: 10, keepRate: 0.8 }, // high keep-rate
    "perf|low": { kept: 0, dropped: 2, total: 2, keepRate: 0 }, // low but too few samples
  };

  it("flags only shapes that are low AND have enough samples", () => {
    const low = lowKeepRateShapes(table, { threshold: 0.2, minSamples: 5 });
    expect([...low]).toEqual(["style|nit"]);
  });

  it("a lower sample floor lets the sparse shape through", () => {
    const low = lowKeepRateShapes(table, { threshold: 0.2, minSamples: 2 });
    expect(low.has("perf|low")).toBe(true);
    expect(low.has("bug|high")).toBe(false);
  });

  it("defaults suppress nothing on a cold history", () => {
    expect(lowKeepRateShapes({}).size).toBe(0);
  });
});

describe("preSuppressByCalibration (#29)", () => {
  it("moves low-keep-rate shapes to suppressed and keeps the rest, order preserved", () => {
    const findings = [
      finding({ category: "bug", severity: "high", title: "keep me" }),
      finding({ category: "style", severity: "nit", title: "drop me" }),
      finding({ category: "bug", severity: "high", title: "keep me 2" }),
    ];
    const split = preSuppressByCalibration(findings, new Set(["style|nit"]));
    expect(split.kept.map((f) => f.title)).toEqual(["keep me", "keep me 2"]);
    expect(split.suppressed).toEqual([{ finding: findings[1], reason: "low-keep-rate" }]);
  });

  it("does not mutate the input and keeps everything when nothing matches", () => {
    const findings = [finding()];
    const split = preSuppressByCalibration(findings, new Set());
    expect(split.suppressed).toEqual([]);
    expect(split.kept).toEqual(findings);
  });
});
