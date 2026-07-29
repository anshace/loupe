/**
 * .aireview.toml loading (tasks 4.6–4.8) — read from the PR head revision via
 * the GitHub contents API, parsed with a MINIMAL TOML-subset parser.
 *
 * Supported TOML subset (deliberately tiny — NO dependency):
 *   - `key = value` pairs, one per line
 *   - booleans: `true` / `false`
 *   - basic double-quoted strings: `"..."` (backslash escapes for `\"` and `\\`)
 *   - single-line arrays of basic strings: `["a", "b"]`
 *   - `[[rules]]` array-of-tables (task 7.4) — the ONLY table form supported
 *   - full-line comments starting with `#`, and trailing `# ...` after a value
 *   - blank lines
 * Anything else (other tables, multi-line values, numbers, dates, dotted
 * keys...) makes the file "invalid": the run proceeds on safe defaults and
 * the summary shows a visible notice (requirement: never crash, never skip).
 *
 * Recognized keys: enabled (bool), min_severity (string), ignore (string[]),
 * rules (string[] — unscoped custom rules), plus `[[rules]]` tables with
 * `text` (required) and `pattern` (path glob, default "**") for per-path rule
 * scoping. Unknown keys are ignored for forward compatibility.
 */
import type { FetchLike } from "./diff";
import type { AuthToken, PrIdentity, Severity } from "./types";

export const AIREVIEW_CONFIG_PATH = ".aireview.toml";
export const HOUSE_RULES_PATH = "HOUSE_RULES.md";

/** A user-written review rule, scoped to the paths matching `pattern` (7.4). */
export interface CustomRule {
  /** Path glob the rule applies to; "**" (everything) by default. */
  pattern: string;
  text: string;
}

export interface RepoConfig {
  enabled: boolean;
  minSeverity: Severity;
  ignore: string[];
  rules: CustomRule[];
}

/** Documented safe defaults (task 4.8). */
export const DEFAULT_REPO_CONFIG: RepoConfig = {
  enabled: true,
  minSeverity: "medium",
  ignore: [],
  rules: [],
};

function freshDefaults(): RepoConfig {
  return { ...DEFAULT_REPO_CONFIG, ignore: [], rules: [] };
}

export interface ParsedRepoConfig {
  config: RepoConfig;
  /** True when the file was malformed/invalid → defaults were used. */
  invalid: boolean;
  problems: string[];
}

const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low", "nit"];
const KEY_VALUE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/;

type TomlValue = boolean | string | string[];

/** Parse a basic double-quoted string starting at text[0]. Returns [value, rest]. */
function parseQuotedString(text: string): [string, string] | undefined {
  if (text[0] !== '"') return undefined;
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      const next = text[i + 1];
      if (next === '"' || next === "\\") {
        out += next;
        i++;
        continue;
      }
      return undefined; // unsupported escape → invalid
    }
    if (c === '"') return [out, text.slice(i + 1)];
    out += c;
  }
  return undefined; // unterminated
}

function isCommentOrBlank(rest: string): boolean {
  const t = rest.trim();
  return t.length === 0 || t.startsWith("#");
}

function parseValue(raw: string): TomlValue | undefined {
  const text = raw.trim();
  if (/^true(\s*#.*)?$/.test(text)) return true;
  if (/^false(\s*#.*)?$/.test(text)) return false;
  if (text.startsWith('"')) {
    const parsed = parseQuotedString(text);
    if (parsed && isCommentOrBlank(parsed[1])) return parsed[0];
    return undefined;
  }
  if (text.startsWith("[")) {
    let rest = text.slice(1).trim();
    const items: string[] = [];
    if (rest.startsWith("]")) {
      return isCommentOrBlank(rest.slice(1)) ? items : undefined;
    }
    for (;;) {
      const parsed = parseQuotedString(rest);
      if (!parsed) return undefined;
      items.push(parsed[0]);
      rest = parsed[1].trim();
      if (rest.startsWith(",")) {
        rest = rest.slice(1).trim();
        if (rest.startsWith("]")) return isCommentOrBlank(rest.slice(1)) ? items : undefined;
        continue;
      }
      if (rest.startsWith("]")) return isCommentOrBlank(rest.slice(1)) ? items : undefined;
      return undefined;
    }
  }
  return undefined;
}

const RULES_TABLE_HEADER = /^\[\[rules\]\]\s*(#.*)?$/;

/** Parse .aireview.toml text. Never throws; invalid input → defaults + notice. */
export function parseAireviewToml(text: string): ParsedRepoConfig {
  const problems: string[] = [];
  const values: Record<string, TomlValue> = {};
  const ruleTables: Array<Record<string, TomlValue>> = [];
  let currentRule: Record<string, TomlValue> | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (RULES_TABLE_HEADER.test(line)) {
      currentRule = {};
      ruleTables.push(currentRule);
      continue;
    }
    const match = KEY_VALUE.exec(line);
    if (!match) {
      problems.push(`unparseable line: ${line.slice(0, 60)}`);
      continue;
    }
    const value = parseValue(match[2]);
    if (value === undefined) {
      problems.push(`unsupported value for "${match[1]}"`);
      continue;
    }
    if (currentRule) currentRule[match[1]] = value;
    else values[match[1]] = value;
  }

  const config: RepoConfig = freshDefaults();

  if ("enabled" in values) {
    if (typeof values.enabled === "boolean") config.enabled = values.enabled;
    else problems.push(`"enabled" must be a boolean`);
  }
  if ("min_severity" in values) {
    const v = values.min_severity;
    if (typeof v === "string" && (SEVERITIES as readonly string[]).includes(v.toLowerCase())) {
      config.minSeverity = v.toLowerCase() as Severity;
    } else {
      problems.push(`"min_severity" must be one of ${SEVERITIES.join("/")}`);
    }
  }
  if ("ignore" in values) {
    const v = values.ignore;
    if (Array.isArray(v)) config.ignore = v;
    else problems.push(`"ignore" must be an array of glob strings`);
  }
  // Custom rules (task 7.4): unscoped strings via `rules = [...]`...
  if ("rules" in values) {
    const v = values.rules;
    if (Array.isArray(v)) {
      config.rules.push(...v.map((text) => ({ pattern: "**", text })));
    } else {
      problems.push(`"rules" must be an array of rule strings`);
    }
  }
  // ...and/or path-scoped `[[rules]]` tables with text (required) + pattern.
  for (const table of ruleTables) {
    if (typeof table.text !== "string" || table.text.length === 0) {
      problems.push(`each [[rules]] table needs a non-empty "text" string`);
      continue;
    }
    if ("pattern" in table && typeof table.pattern !== "string") {
      problems.push(`[[rules]] "pattern" must be a glob string`);
      continue;
    }
    config.rules.push({ pattern: typeof table.pattern === "string" ? table.pattern : "**", text: table.text });
  }

  if (problems.length > 0) {
    // Malformed → run on FULL defaults (never a half-applied config) + notice.
    return { config: freshDefaults(), invalid: true, problems };
  }
  return { config, invalid: false, problems };
}

/** Rules applicable to this run: pattern matches at least one reviewed path. */
export function applicableRules(rules: readonly CustomRule[], paths: readonly string[]): CustomRule[] {
  return rules.filter((rule) => paths.some((path) => globMatch(rule.pattern, path)));
}

/**
 * Minimal glob matcher — `*` matches within a path segment, `**` matches
 * across segments, `?` matches one non-separator char. A pattern without a
 * `/` also matches against the basename (gitignore-style convenience).
 * No dependency; anything fancier is out of scope.
 */
export function globMatch(pattern: string, path: string): boolean {
  const regex = globToRegExp(pattern);
  if (regex.test(path)) return true;
  if (!pattern.includes("/")) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return regex.test(base);
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` at a segment boundary also matches zero segments.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(out + "$");
}

/**
 * Fetch a file's raw content from the reviewed revision via the contents API.
 * Returns undefined when the file is absent or on any error — loading repo
 * config must never crash or skip the run.
 */
export async function fetchRepoFile(
  pr: PrIdentity,
  auth: AuthToken,
  path: string,
  ref: string | undefined,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const url = `https://api.github.com/repos/${pr.owner}/${pr.repo}/contents/${path}${refQuery}`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github.raw+json",
        authorization: `Bearer ${auth}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "code-review-engine",
      },
    });
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}
