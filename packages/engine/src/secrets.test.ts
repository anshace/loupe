import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff";
import { GENERIC_MIN_ENTROPY, redactSecret, scanSecrets, shannonEntropy } from "./secrets";

/** Build a new-file diff (every content line is an added line, 1-indexed). */
function addedDiff(path: string, lines: readonly string[]): ReturnType<typeof parseUnifiedDiff> {
  const diff = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..2222222 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    lines.map((l) => `+${l}`).join("\n"),
  ].join("\n");
  return parseUnifiedDiff(diff);
}

/** Build a modified-file diff from typed [type, text] rows. */
function mixedDiff(path: string, rows: ReadonlyArray<["ctx" | "add" | "del", string]>): ReturnType<typeof parseUnifiedDiff> {
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

describe("shannonEntropy", () => {
  it("is 0 for empty and single-char-repeat strings", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
  });

  it("rises with character diversity", () => {
    expect(shannonEntropy("ab")).toBeCloseTo(1, 5);
    expect(shannonEntropy("R8kZ2wQx7Lp9Nv3Ac6Ty1Bd5Ef0Gh4")).toBeGreaterThan(GENERIC_MIN_ENTROPY);
  });
});

describe("redactSecret", () => {
  it("shows only a 4-char prefix and the length", () => {
    expect(redactSecret("AKIA1234567890ABCDEF")).toBe("AKIA…(20 chars, redacted)");
  });

  it("never leaks the full value", () => {
    const secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
    expect(redactSecret(secret)).not.toContain(secret);
  });
});

describe("scanSecrets — named credential formats", () => {
  const cases: Array<[string, string]> = [
    ["AWS access key ID", 'const cred = "AKIA1234567890ABCDEF";'],
    ["GitHub token", 'const cred = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";'],
    ["GitHub fine-grained token", 'const cred = "github_pat_11ABCDEFG0abcdefghijklmn_opqrstuvwxyz";'],
    ["Slack token", 'const cred = "xoxb-1234567890-abcdefghijklmnop";'],
    ["Stripe secret key", 'const cred = "sk_live_0123456789abcdefABCD";'],
    ["Google API key", `const cred = "AIza${"x".repeat(35)}";`],
    ["private key block", "-----BEGIN RSA PRIVATE KEY-----"],
    [
      "JSON Web Token (JWT)",
      'const t = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";',
    ],
  ];

  it.each(cases)("detects %s as a critical secret finding", (label, line) => {
    const findings = scanSecrets(addedDiff("src/config.ts", [line]));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].category).toBe("secret");
    expect(findings[0].file).toBe("src/config.ts");
    expect(findings[0].line).toBe(1);
    expect(findings[0].title).toContain(label);
  });

  it("redacts the secret value in the finding body", () => {
    const secret = "AKIA1234567890ABCDEF";
    const findings = scanSecrets(addedDiff("src/config.ts", [`const cred = "${secret}";`]));
    expect(findings[0].body).toContain("redacted");
    expect(findings[0].body).not.toContain(secret);
  });
});

describe("scanSecrets — generic high-entropy assignment", () => {
  it("flags a secret-named variable assigned a long high-entropy literal", () => {
    const findings = scanSecrets(addedDiff("src/x.ts", ['const apiKey = "R8kZ2wQx7Lp9Nv3Ac6Ty1Bd5Ef0Gh4";']));
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("hardcoded secret");
    expect(findings[0].severity).toBe("critical");
  });

  it("flags a quoted key form (JSON/YAML style)", () => {
    const findings = scanSecrets(addedDiff("cfg.json", ['  "access_token": "R8kZ2wQx7Lp9Nv3Ac6Ty1Bd5Ef0Gh4",']));
    expect(findings).toHaveLength(1);
  });
});

describe("scanSecrets — false-positive controls", () => {
  it("skips documentation example keys containing EXAMPLE", () => {
    // The canonical AWS docs access key — matches the shape but must not fire.
    expect(scanSecrets(addedDiff("README.md", ['aws_access_key_id = "AKIAIOSFODNN7EXAMPLE"']))).toEqual([]);
  });

  it("does not flag a high-entropy value assigned to a NON-secret variable name", () => {
    expect(scanSecrets(addedDiff("src/x.ts", ['const buildHash = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";']))).toEqual([]);
  });

  it("does not flag placeholder values", () => {
    expect(scanSecrets(addedDiff("src/x.ts", ['const apiKey = "your-api-key-here";']))).toEqual([]);
    expect(scanSecrets(addedDiff("src/x.ts", ['const password = "changeme-please-now";']))).toEqual([]);
  });

  it("does not flag values read from the environment / interpolated", () => {
    expect(scanSecrets(addedDiff("src/x.ts", ['const secret = "${process.env.DB_SECRET}";']))).toEqual([]);
    expect(scanSecrets(addedDiff("src/x.ts", ['const token = "{{ vault_token_value }}";']))).toEqual([]);
  });

  it("does not flag low-entropy repeated strings even under a secret name", () => {
    expect(scanSecrets(addedDiff("src/x.ts", ['const secret = "aaaaaaaaaaaaaaaaaaaa";']))).toEqual([]);
  });

  it("does not flag short values", () => {
    expect(scanSecrets(addedDiff("src/x.ts", ['const password = "hunter2";']))).toEqual([]);
  });
});

describe("scanSecrets — scope", () => {
  it("scans ADDED lines only (context and deleted lines are ignored)", () => {
    const files = mixedDiff("src/x.ts", [
      ["ctx", 'const existing = "AKIA1234567890ABCDEF";'],
      ["del", 'const removed = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";'],
      ["add", "const clean = 1;"],
    ]);
    expect(scanSecrets(files)).toEqual([]);
  });

  it("emits one finding per distinct value (named + generic dedupe on the same line)", () => {
    // `token = "ghp_..."` matches both the GitHub detector and the generic one.
    const findings = scanSecrets(addedDiff("src/x.ts", ['const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";']));
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("GitHub token"); // named wins over generic
  });

  it("skips deleted and binary files", () => {
    const deleted = parseUnifiedDiff(
      [
        "diff --git a/gone.ts b/gone.ts",
        "deleted file mode 100644",
        "--- a/gone.ts",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        '-const cred = "AKIA1234567890ABCDEF";',
      ].join("\n"),
    );
    expect(scanSecrets(deleted)).toEqual([]);
  });
});

describe("scanSecrets — allowlist", () => {
  const line = 'const cred = "AKIA1234567890ABCDEF";';

  it("skips files whose path matches an allowlisted glob", () => {
    const files = addedDiff("test/fixtures/creds.ts", [line]);
    expect(scanSecrets(files)).toHaveLength(1); // fires without allowlist
    expect(scanSecrets(files, { allowPaths: ["test/fixtures/**"] })).toEqual([]);
  });

  it("skips values matching an allowlisted literal substring", () => {
    const files = addedDiff("src/config.ts", [line]);
    expect(scanSecrets(files, { allowPatterns: ["AKIA1234567890ABCDEF"] })).toEqual([]);
  });

  it("allowlist is case-insensitive and matches within the line too", () => {
    const files = addedDiff("src/config.ts", [line]);
    expect(scanSecrets(files, { allowPatterns: ["const cred"] })).toEqual([]);
  });
});
