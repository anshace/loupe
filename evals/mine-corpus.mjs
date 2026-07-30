#!/usr/bin/env node
/**
 * SZZ-style real-bug corpus mining (report item #25).
 *
 * Mines bug-FIX commits from LOCAL git repositories (this repo, and/or a
 * configurable list of already-cloned OSS repo paths) and reconstructs each into
 * a synthetic PRE-FIX eval case in the existing `evals/cases/*` format: the
 * pre-fix state of a touched file becomes the "PR" diff, and the lines the fix
 * deleted/modified become the golden expected-finding location. This grows the
 * corpus from a handful of hand-written cases to hundreds of REAL bugs, for $0.
 *
 * STRICTLY LOCAL — NO NETWORK. This script only runs `git` read commands
 * (`log`/`show`/`diff`/`cat-file`) against a local path you already have on disk.
 * It never clones, fetches, or pulls. If you configure no repos, it no-ops with a
 * clear message (so the test/CI path never touches git or the network).
 *
 * Usage:
 *   node evals/mine-corpus.mjs --repo=. --limit=20
 *   node evals/mine-corpus.mjs --repo=/path/to/cloned/oss --repo=. --grep=fix
 *   MINE_REPOS="/path/a;/path/b" node evals/mine-corpus.mjs
 *   node evals/mine-corpus.mjs --repo=. --dry-run    # count only, write nothing
 * Output: one `<name>.mjs` per mined case under evals/mined/ (git-ignored). These
 * carry NO mockResponses, so they are LIVE-mode cases (run with REVIEW_MODEL set);
 * the deterministic default `nub run eval` does not discover them (non-recursive).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT_DIR = join(HERE, "mined");

const CODE_EXT = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "go", "java",
  "rb", "php", "cs", "c", "h", "cc", "cpp", "cxx", "hpp", "rs",
]);

/** True when the path looks like a reviewable source file (not lockfile/doc/config). */
export function isCodeFile(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return CODE_EXT.has(path.slice(dot + 1).toLowerCase());
}

/**
 * Parse `git log --format=%H%x1f%s` output (hash, US, subject per line) into
 * fix-commit descriptors. Pure.
 */
export function parseFixCommits(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const sep = line.indexOf("\x1f");
    if (sep === -1) continue;
    const hash = line.slice(0, sep).trim();
    const subject = line.slice(sep + 1).trim();
    if (/^[0-9a-f]{7,40}$/i.test(hash)) out.push({ hash, subject });
  }
  return out;
}

/** Map a fix-commit subject to a Loupe finding category. Pure, keyword-based. */
export function deriveCategory(subject) {
  const s = String(subject).toLowerCase();
  if (/\b(xss|sql\s*injection|csrf|ssrf|rce|auth|secret|token|vuln|security|sanitiz|escap|injection)\b/.test(s))
    return "security";
  if (/\b(leak|oom|perf|slow|n\+1|latency|memory)\b/.test(s)) return "performance";
  if (/\b(typo|rename|refactor|cleanup|lint|format|style)\b/.test(s)) return "maintainability";
  return "bug";
}

/**
 * Parse a single-file unified diff (the FIX's diff) and return the OLD-side line
 * numbers of DELETED lines — i.e. the buggy pre-fix lines the fix removed or
 * replaced. These map 1:1 onto the pre-fix file's line numbers. Pure.
 */
export function deletedOldLines(diffText) {
  const lines = String(diffText).split(/\r?\n/);
  const deleted = [];
  let oldLine = 0;
  let inHunk = false;
  for (const line of lines) {
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (h) {
      oldLine = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) continue; // added line — does not advance old side
    if (line.startsWith("-")) {
      deleted.push(oldLine);
      oldLine += 1;
      continue;
    }
    // context (including the leading space); "\ No newline" markers are ignored
    if (line.startsWith("\\")) continue;
    oldLine += 1;
  }
  return deleted;
}

/** Build a new-file unified diff (every content line added → all commentable). Pure. */
export function newFileDiff(path, contentLines) {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..2222222 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${contentLines.length} @@`,
    contentLines.map((l) => `+${l}`).join("\n"),
  ].join("\n");
}

/**
 * Assemble one mined eval-case object from the pre-fix file content + the buggy
 * line numbers derived from the fix. Pure. Returns undefined when there is no
 * anchorable buggy region (fix added lines only, or the file is empty).
 */
export function buildMinedCase({ repoLabel, hash, subject, file, preFixContent, buggyOldLines }) {
  const contentLines = String(preFixContent).split("\n");
  if (contentLines.length > 0 && contentLines[contentLines.length - 1] === "") contentLines.pop();
  const anchors = buggyOldLines.filter((n) => n >= 1 && n <= contentLines.length);
  if (contentLines.length === 0 || anchors.length === 0) return undefined;
  const lo = Math.max(1, Math.min(...anchors));
  const hi = Math.min(contentLines.length, Math.max(...anchors));
  const short = hash.slice(0, 8);
  return {
    name: `mined-${repoLabel}-${short}-${file.replace(/[^a-zA-Z0-9]+/g, "_")}`,
    diff: newFileDiff(file, contentLines),
    fileContents: { [file]: contentLines.join("\n") },
    expectedFindings: [{ file, lineRange: [lo, hi], category: deriveCategory(subject) }],
    source: { repo: repoLabel, fixCommit: hash, subject },
    // No mockResponses on purpose → this is a LIVE-mode case (REVIEW_MODEL set).
  };
}

/** Serialize a mined case object to an ES-module source string. Pure. */
export function renderMinedCaseModule(caseObj) {
  return (
    "// Auto-generated by evals/mine-corpus.mjs (report item #25) — a synthetic\n" +
    "// PRE-FIX case reconstructed from a real bug-fix commit. LIVE-mode only.\n" +
    `export default ${JSON.stringify(caseObj, null, 2)};\n`
  );
}

// ── Git plumbing (LOCAL only; injectable for tests) ─────────────────────────

/** Default git runner — read-only commands against a local checkout. */
function defaultGit(repoPath) {
  return (args) =>
    execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Mine one local repo into case objects. `git(args)->string` is injected so this
 * is testable without a real repo. Never throws on a single bad commit/file —
 * it skips and continues. Pure w.r.t. the injected `git`.
 */
export function mineRepo(repoLabel, git, { limit = 20, grep = "fix" } = {}) {
  const cases = [];
  let log;
  try {
    log = git([
      "log",
      `--grep=${grep}`,
      "-i",
      "--no-merges",
      `--max-count=${limit}`,
      "--format=%H\x1f%s",
    ]);
  } catch {
    return cases; // not a git repo / git unavailable — caller already warned
  }
  for (const { hash, subject } of parseFixCommits(log)) {
    let nameStatus;
    try {
      nameStatus = git(["show", "--name-status", "--format=", hash]);
    } catch {
      continue;
    }
    for (const row of nameStatus.split(/\r?\n/)) {
      const m = /^M\t(.+)$/.exec(row.trim()); // MODIFY only — needs a pre-fix version
      if (!m) continue;
      const file = m[1];
      if (!isCodeFile(file)) continue;
      let fixDiff;
      let preFix;
      try {
        fixDiff = git(["diff", `${hash}^`, hash, "--", file]);
        preFix = git(["show", `${hash}^:${file}`]);
      } catch {
        continue;
      }
      const buggyOldLines = deletedOldLines(fixDiff);
      if (buggyOldLines.length === 0) continue;
      const c = buildMinedCase({ repoLabel, hash, subject, file, preFixContent: preFix, buggyOldLines });
      if (c) cases.push(c);
    }
  }
  return cases;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const repos = [];
  let limit = 20;
  let grep = "fix";
  let out = DEFAULT_OUT_DIR;
  let dryRun = false;
  for (const a of argv) {
    if (a.startsWith("--repo=")) repos.push(a.slice("--repo=".length));
    else if (a.startsWith("--limit=")) limit = Number(a.slice("--limit=".length)) || limit;
    else if (a.startsWith("--grep=")) grep = a.slice("--grep=".length);
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
    else if (a === "--dry-run") dryRun = true;
  }
  const envRepos = process.env.MINE_REPOS;
  if (envRepos) for (const p of envRepos.split(/[;,]/)) if (p.trim()) repos.push(p.trim());
  return { repos, limit, grep, out, dryRun };
}

function labelFor(repoPath) {
  const parts = repoPath.replace(/[\\/]+$/, "").split(/[\\/]/);
  const base = parts[parts.length - 1] || "repo";
  return base === "." || base === "" ? "self" : base.replace(/[^a-zA-Z0-9]+/g, "-");
}

function main() {
  const { repos, limit, grep, out, dryRun } = parseArgs(process.argv.slice(2));
  if (repos.length === 0) {
    console.log(
      "mine-corpus: no repositories configured — nothing to mine (no-op).\n" +
        "  Pass one or more LOCAL git checkouts:  --repo=. --repo=/path/to/cloned/oss\n" +
        "  or set MINE_REPOS=\"/path/a;/path/b\".  This script is LOCAL-ONLY — it never\n" +
        "  clones or fetches over the network; point it at repos you already have.",
    );
    return 0;
  }

  let total = 0;
  if (!dryRun) mkdirSync(out, { recursive: true });
  for (const repoPath of repos) {
    if (!existsSync(join(repoPath, ".git")) && !existsSync(join(repoPath, "HEAD"))) {
      console.log(`mine-corpus: skipping "${repoPath}" — not a git repository (no .git). LOCAL paths only.`);
      continue;
    }
    const label = labelFor(repoPath);
    let cases = [];
    try {
      cases = mineRepo(label, defaultGit(repoPath), { limit, grep });
    } catch (err) {
      console.log(`mine-corpus: "${repoPath}" failed — ${err?.message ?? err}`);
      continue;
    }
    for (const c of cases) {
      total += 1;
      if (dryRun) continue;
      writeFileSync(join(out, `${c.name}.mjs`), renderMinedCaseModule(c));
    }
    console.log(`mine-corpus: ${repoPath} → ${cases.length} case(s)`);
  }
  console.log(
    dryRun
      ? `mine-corpus: ${total} case(s) would be written to ${out} (dry run — nothing written).`
      : total === 0
        ? `mine-corpus: 0 cases mined (no MODIFY bug-fix commits on code files matched --grep=${grep}).`
        : `mine-corpus: wrote ${total} case(s) to ${out}. Run them live with REVIEW_MODEL=<provider>.`,
  );
  return 0;
}

if (process.argv[1]?.endsWith("mine-corpus.mjs")) process.exit(main());
