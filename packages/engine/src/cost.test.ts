import { describe, expect, it } from "vitest";
import {
  CostTracker,
  DEFAULT_TOKEN_CAPS,
  costUsd,
  isOverMonthlyBudget,
  monthKey,
  readLedger,
  recordSpend,
} from "./cost";

describe("costUsd", () => {
  it("prices Haiku 4.5 at $1/$5 per Mtok", () => {
    expect(costUsd("claude-haiku-4-5", 1_000_000, 1_000_000)).toBeCloseTo(6);
    expect(costUsd("claude-haiku-4-5", 10_000, 2_000)).toBeCloseTo(0.02);
  });

  it("prices free tiers and unknown models at $0", () => {
    expect(costUsd("gemini-2.5-flash", 1_000_000, 1_000_000)).toBe(0);
    expect(costUsd("llama-3.3-70b-versatile", 1_000_000, 1_000_000)).toBe(0);
    expect(costUsd("mock", 1_000_000, 1_000_000)).toBe(0);
  });
});

describe("CostTracker", () => {
  it("has sensible defaults (200k in / 20k out)", () => {
    expect(DEFAULT_TOKEN_CAPS).toEqual({ maxInputTokens: 200_000, maxOutputTokens: 20_000 });
    expect(new CostTracker().canProceed()).toBe(true);
  });

  it("blocks further calls once real usage reaches a cap", () => {
    const tracker = new CostTracker({ maxInputTokens: 1000, maxOutputTokens: 100 });
    expect(tracker.record("claude-haiku-4-5", 400, 10)).toBe(false);
    expect(tracker.canProceed()).toBe(true);
    expect(tracker.record("claude-haiku-4-5", 700, 10)).toBe(true); // 1100 > 1000
    expect(tracker.canProceed()).toBe(false);
  });

  it("the output cap alone also trips it", () => {
    const tracker = new CostTracker({ maxOutputTokens: 50 });
    expect(tracker.record("claude-haiku-4-5", 10, 60)).toBe(true);
  });

  it("accumulates real spend in USD", () => {
    const tracker = new CostTracker();
    tracker.record("claude-haiku-4-5", 1_000_000, 0);
    tracker.record("claude-haiku-4-5", 0, 1_000_000);
    expect(tracker.spentUsd).toBeCloseTo(6);
  });
});

describe("monthly budget ledger", () => {
  const now = new Date("2026-07-29T12:00:00Z");

  function memoryFs(initial: Record<string, string> = {}) {
    const files = { ...initial };
    return {
      files,
      io: {
        readFile: (p: string) => {
          if (!(p in files)) throw new Error("ENOENT");
          return files[p];
        },
        writeFile: (p: string, content: string) => {
          files[p] = content;
        },
      },
    };
  }

  it("monthKey formats UTC year-month", () => {
    expect(monthKey(now)).toBe("2026-07");
  });

  it("readLedger returns {} for absent or corrupt files", () => {
    const { io } = memoryFs({ "bad.json": "not json" });
    expect(readLedger("missing.json", io)).toEqual({});
    expect(readLedger("bad.json", io)).toEqual({});
  });

  it("recordSpend accumulates per month", () => {
    const { io, files } = memoryFs();
    recordSpend("ledger.json", "2026-07", 0.01, io);
    recordSpend("ledger.json", "2026-07", 0.02, io);
    expect(JSON.parse(files["ledger.json"])["2026-07"]).toBeCloseTo(0.03);
  });

  it("isOverMonthlyBudget compares this month's spend to the env budget", () => {
    const { io } = memoryFs({ "ledger.json": JSON.stringify({ "2026-07": 5.5, "2026-06": 100 }) });
    expect(isOverMonthlyBudget({ REVIEW_MONTHLY_BUDGET_USD: "5" }, "ledger.json", now, io)).toBe(true);
    expect(isOverMonthlyBudget({ REVIEW_MONTHLY_BUDGET_USD: "10" }, "ledger.json", now, io)).toBe(false);
  });

  it("no budget, no ledger path, or a garbage budget → never over", () => {
    const { io } = memoryFs();
    expect(isOverMonthlyBudget({}, "ledger.json", now, io)).toBe(false);
    expect(isOverMonthlyBudget({ REVIEW_MONTHLY_BUDGET_USD: "5" }, undefined, now, io)).toBe(false);
    expect(isOverMonthlyBudget({ REVIEW_MONTHLY_BUDGET_USD: "lots" }, "ledger.json", now, io)).toBe(false);
    // Absent ledger file → treat as no spend, per-run caps only.
    expect(isOverMonthlyBudget({ REVIEW_MONTHLY_BUDGET_USD: "5" }, "ledger.json", now, io)).toBe(false);
  });
});
