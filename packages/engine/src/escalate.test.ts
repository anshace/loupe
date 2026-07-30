import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLAST_RADIUS_THRESHOLD,
  ESCALATION_MODEL,
  computeEscalation,
  highBlastRadiusPaths,
  isChurnMessage,
  isRiskyPath,
  shouldEscalate,
} from "./escalate";

describe("isRiskyPath", () => {
  it.each([
    "src/auth/login.ts",
    "lib/payments/charge.ts",
    "billing/invoice.py",
    "db/migrations/0042_add_users.sql",
    "src/crypto/hash.ts",
    "config/secrets.ts",
    "src/encryption.ts", // "crypt" substring
    "utils/decrypt.ts",
  ])("flags %s as risky", (path) => {
    expect(isRiskyPath(path)).toBe(true);
  });

  it.each(["src/author.ts", "docs/README.md", "src/pricing.ts", "test/formatting.test.ts"])(
    "does not flag %s",
    (path) => {
      expect(isRiskyPath(path)).toBe(false);
    },
  );
});

describe("shouldEscalate", () => {
  it("escalates when any changed path is risky", () => {
    expect(shouldEscalate(["docs/a.md", "src/auth/session.ts"])).toBe(true);
  });

  it("does not escalate for safe paths or empty diffs", () => {
    expect(shouldEscalate(["docs/a.md", "src/pricing.ts"])).toBe(false);
    expect(shouldEscalate([])).toBe(false);
  });
});

describe("ESCALATION_MODEL", () => {
  it("targets Sonnet 5", () => {
    expect(ESCALATION_MODEL).toBe("claude-sonnet-5");
  });
});

describe("isChurnMessage", () => {
  it.each([
    "Revert \"add caching layer\"",
    "reverts #123",
    "hotfix: null deref in checkout",
    "hot-fix for prod crash",
    "rollback the migration",
    "rolled back the risky change",
    "fix regression introduced in v2",
    "emergency fix for auth outage",
  ])("flags %s as churn", (m) => {
    expect(isChurnMessage(m)).toBe(true);
  });

  it.each([
    "add feature",
    "refactor overtime tracker", // 'overt' must not match 'revert'
    "covert channel docs",
    "improve performance",
  ])("does not flag %s", (m) => {
    expect(isChurnMessage(m)).toBe(false);
  });

  it("is safe on non-strings", () => {
    expect(isChurnMessage(undefined as unknown as string)).toBe(false);
  });
});

describe("highBlastRadiusPaths", () => {
  it("returns paths at or above the threshold, most-imported first", () => {
    const counts = new Map([
      ["src/a.ts", 12],
      ["src/b.ts", 5],
      ["src/c.ts", 4],
    ]);
    expect(highBlastRadiusPaths(counts)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(DEFAULT_BLAST_RADIUS_THRESHOLD).toBe(5);
  });

  it("honors a custom threshold", () => {
    const counts = new Map([["src/a.ts", 3]]);
    expect(highBlastRadiusPaths(counts, 3)).toEqual(["src/a.ts"]);
    expect(highBlastRadiusPaths(counts, 4)).toEqual([]);
  });
});

describe("computeEscalation", () => {
  it("escalates on risky paths alone (no extra signals)", () => {
    const d = computeEscalation({ paths: ["src/auth/login.ts", "docs/x.md"] });
    expect(d.escalate).toBe(true);
    expect(d.riskyPaths).toEqual(["src/auth/login.ts"]);
    expect(d.reasons.some((r) => r.includes("risky paths"))).toBe(true);
  });

  it("escalates on blast radius even when no path is risky", () => {
    const d = computeEscalation({
      paths: ["src/util.ts"],
      importerCounts: new Map([["src/util.ts", 9]]),
    });
    expect(d.escalate).toBe(true);
    expect(d.highBlastRadiusPaths).toEqual(["src/util.ts"]);
    expect(d.reasons.some((r) => r.includes("blast radius"))).toBe(true);
  });

  it("escalates on churn, but only for paths actually changed", () => {
    const d = computeEscalation({
      paths: ["src/util.ts"],
      churnyPaths: ["src/util.ts", "src/other.ts"],
    });
    expect(d.escalate).toBe(true);
    expect(d.churnyPaths).toEqual(["src/util.ts"]); // src/other.ts filtered out
  });

  it("does not escalate when no signal fires", () => {
    const d = computeEscalation({
      paths: ["src/pricing.ts"],
      importerCounts: new Map([["src/pricing.ts", 1]]),
      churnyPaths: [],
    });
    expect(d.escalate).toBe(false);
    expect(d.reasons).toEqual([]);
  });
});
