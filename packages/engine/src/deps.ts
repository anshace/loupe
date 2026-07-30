/**
 * Supply-chain / dependency risk (feature #22, report item #22).
 *
 * Manifest- and lockfile-diff scoped, over the ADDED lines only — the same
 * deterministic pre-pass spirit as secrets.ts / workflowcheck.ts, no LLM call.
 *
 * Two layers:
 *   1. DETERMINISTIC (default on, zero network — `scanDependencyChanges`):
 *      • flag NEW dependencies added to a package.json manifest as a heads-up
 *        (every added dependency is fresh supply-chain + transitive surface);
 *      • flag new dependencies whose lockfile entry declares an INSTALL SCRIPT
 *        (`"hasInstallScript": true` in package-lock.json / npm-shrinkwrap) —
 *        a postinstall/preinstall script runs arbitrary code on `npm install`,
 *        the classic supply-chain foothold. High severity.
 *   2. OPTIONAL AUDIT (default off, needs network — `auditDependencies`):
 *      • OSV.dev `querybatch` for known CVEs affecting the new deps;
 *      • npm registry license lookup, flagging copyleft (GPL/AGPL/LGPL) or
 *        unknown licenses as a heads-up.
 *
 * Zero engine deps: manifests/lockfiles are parsed with plain string/JSON logic;
 * the audit uses the injectable `fetch`. Everything is fail-soft — a network or
 * parse error drops that datum, never the run.
 */
import { globMatch } from "./config";
import type { DiffFile, DiffHunk, FetchLike } from "./diff";
import type { Finding } from "./types";

/** A dependency newly added to a manifest in this diff. */
export interface NewDependency {
  name: string;
  /** The version range/spec as written in the manifest (e.g. "^4.17.21"). */
  version: string;
  file: string;
  line: number;
  /** True when a lockfile entry for this package declared an install script. */
  hasInstallScript: boolean;
}

/** Result of the deterministic dependency scan. */
export interface DependencyScan {
  findings: Finding[];
  /** New deps (for the optional network audit); deduped by name. */
  newDeps: NewDependency[];
}

const MANIFEST = /(^|\/)package\.json$/;
const NPM_LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/;

function basenameMatches(path: string, re: RegExp): boolean {
  return re.test(path);
}

// A manifest dependency line: `"name": "version",` — a package name mapped to a
// version-like spec. Kept strict on the VALUE side (a semver range, tag, url, or
// protocol spec) so ordinary JSON string fields never masquerade as a dep.
const DEP_LINE = /^\s*"(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)"\s*:\s*"([^"]+)"\s*,?\s*$/i;
const VERSION_SPEC =
  /^(?:[\^~>=<]|\d|\*|x|latest$|next$|npm:|workspace:|file:|link:|git|https?:|github:|[\w.-]+\/[\w.-]+)/i;
// package.json keys that are NOT dependency maps (so their string children,
// which can look dep-shaped, are ignored). We only scan lines; this filters the
// most common false-positive keys when they appear as the value's own line.
const NON_DEP_NAME = /^(?:name|version|description|license|main|module|types|type|author|homepage|bugs|repository|private|scripts|engines|bin)$/i;

// A lockfile package key line: `"node_modules/foo": {` or `"foo": {` (v1 form).
const LOCK_PKG_KEY = /^\s*"(?:node_modules\/)?(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)"\s*:\s*\{/i;
const HAS_INSTALL_SCRIPT = /"hasInstallScript"\s*:\s*true/;

interface AddedLine {
  content: string;
  line: number;
}

function addedLines(hunks: readonly DiffHunk[]): AddedLine[] {
  const out: AddedLine[] = [];
  for (const hunk of hunks) {
    for (const l of hunk.lines) {
      if (l.type === "add" && l.newLine !== undefined) out.push({ content: l.content, line: l.newLine });
    }
  }
  return out;
}

/** Names of packages whose lockfile entry (added in this diff) has an install script. */
function installScriptNames(files: readonly DiffFile[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    if (file.isBinary || file.status === "deleted" || !basenameMatches(file.path, NPM_LOCKFILE)) continue;
    let currentPkg: string | undefined;
    for (const { content } of addedLines(file.hunks)) {
      const key = LOCK_PKG_KEY.exec(content);
      if (key) {
        currentPkg = key[1];
        // `hasInstallScript` may sit on the SAME line in compact lockfiles.
        if (HAS_INSTALL_SCRIPT.test(content)) names.add(currentPkg);
        continue;
      }
      if (currentPkg && HAS_INSTALL_SCRIPT.test(content)) names.add(currentPkg);
    }
  }
  return names;
}

function newDepFinding(deps: readonly NewDependency[], file: string, line: number): Finding {
  const list = deps.map((d) => `\`${d.name}@${d.version}\``).join(", ");
  return {
    severity: "low",
    category: "dependency",
    file,
    line,
    title: `New dependencies added (${deps.length})`,
    body:
      `This change adds ${deps.length} new dependenc${deps.length === 1 ? "y" : "ies"}: ${list}. ` +
      `Each new package (and its transitive deps) is fresh supply-chain surface. Confirm the ` +
      `package is the intended one (no typo-squat), that its maintenance/popularity is adequate, ` +
      `and that it is actually needed rather than a few lines you could inline.`,
  };
}

function installScriptFinding(dep: NewDependency): Finding {
  return {
    severity: "high",
    category: "supply-chain",
    file: dep.file,
    line: dep.line,
    title: `New dependency with an install script: ${dep.name}`,
    body:
      `\`${dep.name}@${dep.version}\` declares an install script (\`hasInstallScript: true\`), which ` +
      `runs arbitrary code on every \`npm install\` — including in CI and on contributors' machines — ` +
      `before any of your code executes. This is the most common supply-chain foothold. Verify the ` +
      `script is legitimate, pin the package to an exact version, and consider \`--ignore-scripts\` ` +
      `plus an explicit allowlist for packages that genuinely need a build step.`,
  };
}

/**
 * Scan manifest + lockfile diffs for newly-added dependencies and install-script
 * risk. Pure and deterministic — no network. Deleted/binary files are skipped.
 */
export function scanDependencyChanges(
  files: readonly DiffFile[],
  opts: { ignorePaths?: readonly string[] } = {},
): DependencyScan {
  const ignore = opts.ignorePaths ?? [];
  const installNames = installScriptNames(files);
  const findings: Finding[] = [];
  const newDeps: NewDependency[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (file.isBinary || file.status === "deleted" || !basenameMatches(file.path, MANIFEST)) continue;
    if (ignore.some((glob) => globMatch(glob, file.path))) continue;

    const fileNewDeps: NewDependency[] = [];
    for (const { content, line } of addedLines(file.hunks)) {
      const m = DEP_LINE.exec(content);
      if (!m) continue;
      const [, name, version] = m;
      if (NON_DEP_NAME.test(name) || !VERSION_SPEC.test(version)) continue;
      const key = `${name}@${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dep: NewDependency = {
        name,
        version,
        file: file.path,
        line,
        hasInstallScript: installNames.has(name),
      };
      fileNewDeps.push(dep);
      newDeps.push(dep);
    }

    if (fileNewDeps.length > 0) {
      findings.push(newDepFinding(fileNewDeps, file.path, fileNewDeps[0].line));
    }
    for (const dep of fileNewDeps) {
      if (dep.hasInstallScript) findings.push(installScriptFinding(dep));
    }
  }

  return { findings, newDeps };
}

// ── Optional network audit (OSV.dev CVEs + npm license) ─────────────────────

const OSV_QUERYBATCH = "https://api.osv.dev/v1/querybatch";
const NPM_REGISTRY = "https://registry.npmjs.org";
/** Copyleft licenses worth a heads-up when a new dep pulls one in. */
const COPYLEFT = /\b(?:A?GPL|LGPL|GPL-|AGPL-|LGPL-|SSPL|EUPL|CDDL|MPL-)/i;
/** Hard cap on deps audited over the network per run (bounds cost). */
export const MAX_AUDITED_DEPS = 50;

/** Strip a leading range operator to a bare version OSV can match, or undefined. */
function bareVersion(spec: string): string | undefined {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(spec);
  return m ? m[1] : undefined;
}

export interface AuditResult {
  findings: Finding[];
  notices: string[];
}

interface OsvBatchResponse {
  results?: Array<{ vulns?: Array<{ id?: unknown }> }>;
}

async function queryOsv(
  deps: readonly NewDependency[],
  fetchImpl: FetchLike,
): Promise<Map<number, string[]>> {
  const byIndex = new Map<number, string[]>();
  const queries = deps.map((d) => {
    const version = bareVersion(d.version);
    return version
      ? { package: { name: d.name, ecosystem: "npm" }, version }
      : { package: { name: d.name, ecosystem: "npm" } };
  });
  try {
    const res = await fetchImpl(OSV_QUERYBATCH, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "code-review-engine" },
      body: JSON.stringify({ queries }),
    });
    if (!res.ok) return byIndex;
    const json = JSON.parse(await res.text()) as OsvBatchResponse;
    const results = json.results ?? [];
    for (let i = 0; i < results.length; i++) {
      const ids = (results[i]?.vulns ?? [])
        .map((v) => v?.id)
        .filter((id): id is string => typeof id === "string");
      if (ids.length > 0) byIndex.set(i, ids);
    }
  } catch {
    // fail-soft — OSV unreachable → no CVE findings this run
  }
  return byIndex;
}

async function fetchLicense(
  dep: NewDependency,
  fetchImpl: FetchLike,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${NPM_REGISTRY}/${dep.name}`, {
      headers: { accept: "application/json", "user-agent": "code-review-engine" },
    });
    if (!res.ok) return undefined;
    const json = JSON.parse(await res.text()) as {
      license?: unknown;
      licenses?: Array<{ type?: unknown }>;
    };
    if (typeof json.license === "string") return json.license;
    const legacy = json.licenses?.[0]?.type;
    return typeof legacy === "string" ? legacy : undefined;
  } catch {
    return undefined;
  }
}

function cveFinding(dep: NewDependency, ids: readonly string[]): Finding {
  return {
    severity: "high",
    category: "supply-chain",
    file: dep.file,
    line: dep.line,
    title: `Known vulnerability in new dependency: ${dep.name}`,
    body:
      `OSV.dev reports ${ids.length} known advisory/advisories affecting \`${dep.name}@${dep.version}\`: ` +
      `${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", …" : ""}. Upgrade to a patched version, or ` +
      `pick an unaffected package, before merging.`,
  };
}

function licenseFinding(dep: NewDependency, license: string): Finding {
  return {
    severity: "low",
    category: "dependency",
    file: dep.file,
    line: dep.line,
    title: `Copyleft license on new dependency: ${dep.name} (${license})`,
    body:
      `\`${dep.name}@${dep.version}\` is published under \`${license}\`, a copyleft license whose ` +
      `obligations can extend to code that links it. Confirm this is compatible with your project's ` +
      `licensing before adopting it.`,
  };
}

/**
 * Optional network audit of the new deps: OSV.dev CVEs + npm license check.
 * One batched OSV call + one registry call per dep (capped). Fail-soft: any
 * failure yields fewer findings, never an error. Off by default in the pipeline.
 */
export async function auditDependencies(
  newDeps: readonly NewDependency[],
  fetchImpl: FetchLike,
  opts: { maxDeps?: number; checkLicenses?: boolean } = {},
): Promise<AuditResult> {
  const findings: Finding[] = [];
  const notices: string[] = [];
  const deps = newDeps.slice(0, opts.maxDeps ?? MAX_AUDITED_DEPS);
  if (deps.length === 0) return { findings, notices };

  const cves = await queryOsv(deps, fetchImpl);
  let cveCount = 0;
  for (const [i, ids] of cves) {
    const dep = deps[i];
    if (dep) {
      findings.push(cveFinding(dep, ids));
      cveCount += 1;
    }
  }
  if (cveCount > 0) notices.push(`dependency audit: ${cveCount} new dep(s) with known CVEs (OSV.dev)`);

  if (opts.checkLicenses ?? true) {
    for (const dep of deps) {
      const license = await fetchLicense(dep, fetchImpl);
      if (license && COPYLEFT.test(license)) findings.push(licenseFinding(dep, license));
    }
  }

  return { findings, notices };
}
