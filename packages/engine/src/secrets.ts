/**
 * Deterministic secret / credential pre-pass (feature #2, report item #2).
 *
 * A zero-dependency regex (+ Shannon-entropy) scanner run over the ADDED lines
 * of the diff ONLY, BEFORE the LLM call — same deterministic-filter spirit as
 * noise.ts. It emits `critical` / `secret` Findings with the secret VALUE
 * redacted (only a short prefix is shown), so a leaked credential is caught
 * even when the model skims past this "boring" kind of line, and WITHOUT an
 * LLM round-trip (these findings skip the reviewer + verifier entirely).
 *
 * Precision controls (this pass must not cry wolf — it feeds the same publish
 * path as every other finding, so a false positive is a real posted comment):
 *   - named formats (AWS / GitHub / Slack / Stripe / Google / PEM / JWT) are
 *     matched by shape and are near-zero-false-positive on their own;
 *   - the generic "secret-like variable = long string" detector additionally
 *     requires a minimum length, high Shannon entropy, no interpolation, and
 *     rejects obvious placeholders;
 *   - any value containing "EXAMPLE" (the AWS/GitHub docs convention) is skipped;
 *   - a per-repo allowlist (path globs + literal substrings) silences known-safe
 *     matches such as test fixtures / documented example keys — see
 *     `secret_allow_paths` / `secret_allow_patterns` in .aireview.toml.
 */
import { globMatch } from "./config";
import type { DiffFile } from "./diff";
import type { Finding } from "./types";

/** Known-safe exemptions from the secret scan (from .aireview.toml). */
export interface SecretAllowlist {
  /** Path globs whose files are exempt entirely (test fixtures, examples). */
  allowPaths?: readonly string[];
  /** Literal substrings (case-insensitive) that mark a matched value/line safe. */
  allowPatterns?: readonly string[];
}

/** Minimum Shannon entropy (bits/char) for the generic assignment detector. */
export const GENERIC_MIN_ENTROPY = 3.0;
/** Minimum value length for the generic assignment detector. */
export const GENERIC_MIN_LENGTH = 16;

interface NamedDetector {
  label: string;
  regex: RegExp;
}

/**
 * High-signal named-credential formats. Each regex is global; the whole match
 * is the sensitive value. Ordered most-specific first — the per-line dedupe
 * keeps only the first detector to claim a given value.
 */
const NAMED: readonly NamedDetector[] = [
  { label: "AWS access key ID", regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g },
  { label: "GitHub fine-grained token", regex: /\bgithub_pat_[0-9A-Za-z_]{22,}\b/g },
  { label: "GitHub token", regex: /\bgh[opsur]_[0-9A-Za-z]{36,}\b/g },
  { label: "Slack token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { label: "Stripe secret key", regex: /\b[sr]k_live_[0-9A-Za-z]{16,}\b/g },
  { label: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "private key block", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { label: "JSON Web Token (JWT)", regex: /eyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{6,}\.[0-9A-Za-z_-]{6,}/g },
];

/**
 * Generic "credential-shaped assignment": a variable whose name reads like a
 * secret, assigned a quoted literal. Group 1 = name, group 2 = value.
 */
const GENERIC =
  /["'`]?([A-Za-z0-9_]*(?:passwd|password|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token))["'`]?\s*[:=]>?\s*["'`]([^"'`]{12,})["'`]/gi;

/** Interpolation / env-lookup markers — a value that reads from elsewhere is not a literal secret. */
const INTERPOLATION = /\$\{|\{\{|%\(|<[^>]{0,60}>|process\.env|os\.environ|import\.meta\.env|getenv\(/;
/** Obvious placeholder words — distinctive enough that a real secret rarely contains them. */
const PLACEHOLDER =
  /example|changeme|change[_-]?me|placeholder|redacted|dummy|sample|your[_-]?(?:key|token|secret|password|api)|yourkey|xxxxx|fixme|todo|foobar|lorem|replace[_-]?me/i;

interface SecretMatch {
  label: string;
  value: string;
}

/** Shannon entropy of a string, in bits per character. Pure. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of text) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Redact a secret value: keep only a 4-char prefix, disclose the length. */
export function redactSecret(value: string): string {
  const keep = value.slice(0, Math.min(4, value.length));
  return `${keep}…(${value.length} chars, redacted)`;
}

/** All distinct credential matches on a single (already marker-stripped) line. */
export function detectSecretsInLine(line: string): SecretMatch[] {
  const out: SecretMatch[] = [];
  const seen = new Set<string>();
  const push = (label: string, value: string): void => {
    if (value.length === 0 || seen.has(value)) return;
    seen.add(value);
    out.push({ label, value });
  };

  for (const detector of NAMED) {
    detector.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = detector.regex.exec(line)) !== null) {
      push(detector.label, m[0]);
      if (m.index === detector.regex.lastIndex) detector.regex.lastIndex += 1;
    }
  }

  GENERIC.lastIndex = 0;
  let g: RegExpExecArray | null;
  while ((g = GENERIC.exec(line)) !== null) {
    const value = g[2];
    if (
      value.length >= GENERIC_MIN_LENGTH &&
      !INTERPOLATION.test(value) &&
      !PLACEHOLDER.test(value) &&
      shannonEntropy(value) >= GENERIC_MIN_ENTROPY
    ) {
      push("hardcoded secret", value);
    }
    if (g.index === GENERIC.lastIndex) GENERIC.lastIndex += 1;
  }

  return out;
}

function isAllowedValue(value: string, line: string, allow: SecretAllowlist): boolean {
  const patterns = allow.allowPatterns ?? [];
  const v = value.toLowerCase();
  const l = line.toLowerCase();
  return patterns.some((p) => {
    const needle = p.toLowerCase();
    return needle.length > 0 && (v.includes(needle) || l.includes(needle));
  });
}

function makeFinding(file: string, line: number, match: SecretMatch): Finding {
  return {
    severity: "critical",
    category: "secret",
    file,
    line,
    title: `Possible ${match.label} committed`,
    body:
      `A value matching the ${match.label} pattern was found on this added line ` +
      `(\`${redactSecret(match.value)}\`). If this is a real credential, revoke and ` +
      `rotate it now, remove it from the diff history, and load it from an environment ` +
      `variable or secret manager instead of committing it. If it is a non-sensitive ` +
      `example or test fixture, add this path to \`secret_allow_paths\` or the literal to ` +
      `\`secret_allow_patterns\` in .aireview.toml to silence this check.`,
  };
}

/**
 * Scan the ADDED lines of the given diff files for committed secrets. Pure and
 * deterministic — no LLM call. Deleted/binary files and allowlisted paths are
 * skipped. Every finding is `critical` / `secret` with the value redacted.
 */
export function scanSecrets(files: readonly DiffFile[], allow: SecretAllowlist = {}): Finding[] {
  const allowPaths = allow.allowPaths ?? [];
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.isBinary || file.status === "deleted") continue;
    if (allowPaths.some((glob) => globMatch(glob, file.path))) continue;
    for (const hunk of file.hunks) {
      for (const dl of hunk.lines) {
        if (dl.type !== "add" || dl.newLine === undefined) continue;
        for (const match of detectSecretsInLine(dl.content)) {
          if (/example/i.test(match.value)) continue; // AWS/GitHub docs convention
          if (isAllowedValue(match.value, dl.content, allow)) continue;
          findings.push(makeFinding(file.path, dl.newLine, match));
        }
      }
    }
  }
  return findings;
}
