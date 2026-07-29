/**
 * Cost caps (task 4.11): a per-run token cap enforced with REAL provider
 * token counts, and a monthly USD budget backed by a flat-JSON spend ledger
 * (injectable path/fs — on the Action path the ledger may be absent, which
 * simply means per-run caps only). When the monthly budget is exceeded, the
 * run degrades to the free-tier provider. When the per-run cap is hit
 * mid-run, no further model calls are made and what exists is published with
 * an early-stop notice. Kept deliberately simple.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { TokenCapConfig } from "./types";

/** USD per million tokens, per model. Free tiers are $0. */
export const PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  // Claude Haiku 4.5 — the M2 quality default.
  "claude-haiku-4-5": { input: 1, output: 5 },
  // Gemini 2.5 Flash free tier (dev/free mode).
  "gemini-2.5-flash": { input: 0, output: 0 },
  // Groq Llama free tier fallback.
  "llama-3.3-70b-versatile": { input: 0, output: 0 },
};

/** Cost of a call in USD. Unknown models cost $0 (mock/test providers). */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES_USD_PER_MTOK[model];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export const DEFAULT_TOKEN_CAPS: Required<TokenCapConfig> = {
  maxInputTokens: 200_000,
  maxOutputTokens: 20_000,
};

/** Tracks real per-run token usage against the caps. */
export class CostTracker {
  private readonly caps: Required<TokenCapConfig>;
  inputTokens = 0;
  outputTokens = 0;
  spentUsd = 0;

  constructor(caps: TokenCapConfig = {}) {
    this.caps = { ...DEFAULT_TOKEN_CAPS, ...caps };
  }

  /** False once the cap is reached — no further model calls this run. */
  canProceed(): boolean {
    return this.inputTokens < this.caps.maxInputTokens && this.outputTokens < this.caps.maxOutputTokens;
  }

  /** Record real usage from a provider response. Returns true when now over cap. */
  record(model: string, inputTokens: number, outputTokens: number): boolean {
    this.inputTokens += inputTokens;
    this.outputTokens += outputTokens;
    this.spentUsd += costUsd(model, inputTokens, outputTokens);
    return !this.canProceed();
  }
}

/** "2026-07"-style key for the spend ledger. */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface LedgerIo {
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
}

/** Read the flat-JSON ledger ({"2026-07": usd, ...}). Absent/corrupt → {}. */
export function readLedger(path: string, io: LedgerIo = {}): Record<string, number> {
  const read = io.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    const parsed: unknown = JSON.parse(read(path));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Add a run's spend to the ledger. Best-effort; never crashes the run. */
export function recordSpend(path: string, month: string, usd: number, io: LedgerIo = {}): void {
  const write = io.writeFile ?? ((p: string, content: string) => writeFileSync(p, content));
  const ledger = readLedger(path, io);
  ledger[month] = (ledger[month] ?? 0) + usd;
  try {
    write(path, JSON.stringify(ledger, null, 2) + "\n");
  } catch {
    // Ledger writes are best-effort (e.g. read-only Action filesystem).
  }
}

/**
 * True when REVIEW_MONTHLY_BUDGET_USD is set and this month's ledger spend
 * meets or exceeds it. No budget or no ledger path → false (no ledger → treat
 * as unknowable, cap per-run only).
 */
export function isOverMonthlyBudget(
  env: Record<string, string | undefined>,
  ledgerPath: string | undefined,
  now: Date,
  io: LedgerIo = {},
): boolean {
  const raw = env.REVIEW_MONTHLY_BUDGET_USD;
  if (raw === undefined || ledgerPath === undefined) return false;
  const budget = Number(raw);
  if (!Number.isFinite(budget)) return false;
  const spent = readLedger(ledgerPath, io)[monthKey(now)] ?? 0;
  return spent >= budget;
}
