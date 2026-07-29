import { describe, expect, it } from "vitest";
import { ESCALATION_MODEL, isRiskyPath, shouldEscalate } from "./escalate";

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
