/**
 * Deterministic GitHub Actions workflow supply-chain checks (feature #4,
 * report item #4). Pure regex/line analysis over changed `.github/workflows/
 * *.yml` files in the diff — same deterministic-filter spirit as noise.ts,
 * no external data source, no LLM call. Three checks:
 *
 *   (a) unpinned third-party action — `uses: owner/repo@<tag|branch>` instead
 *       of a full commit SHA (a mutable ref a compromised upstream can
 *       silently repoint); first-party `actions/*` and `github/*` are trusted.
 *   (b) "pwn request" — `pull_request_target` combined with a checkout of the
 *       PR head ref, which runs fork-PR code with the base repo's secrets.
 *   (c) script injection — an attacker-controllable `${{ github.event.* }}`
 *       expression interpolated directly into a shell `run:` block.
 *
 * All checks are scoped to the diff: (a) and (c) fire only on ADDED lines;
 * (b) fires only when the diff introduced or touched at least one line of the
 * dangerous pair (never on wholly pre-existing config), matching the
 * "review the change, not the whole repo" ethos.
 */
import type { DiffFile, DiffHunk } from "./diff";
import type { Finding } from "./types";

const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/** Action owners trusted to use tag refs (GitHub's own first-party actions). */
const TRUSTED_OWNERS = new Set(["actions", "github"]);

const USES = /^\s*(?:-\s*)?uses:\s*["']?([^"'#\s]+)["']?/;
const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

/** PR-head checkout refs that make `pull_request_target` dangerous. */
const HEAD_CHECKOUT =
  /ref:\s*["']?\$\{\{\s*[^}]*(?:github\.event\.pull_request\.head\.(?:sha|ref)|github\.head_ref)[^}]*\}\}/i;

const RUN_KEY = /^(\s*)(?:-\s*)?run:\s?(.*)$/;
const INTERP = /\$\{\{([^}]*)\}\}/g;

/** Attacker-controllable expression contexts (whitespace removed, lowercased). */
const UNTRUSTED_CONTEXTS: readonly string[] = [
  "github.event.issue.title",
  "github.event.issue.body",
  "github.event.pull_request.title",
  "github.event.pull_request.body",
  "github.event.comment.body",
  "github.event.review.body",
  "github.event.review_comment.body",
  "github.event.discussion.title",
  "github.event.discussion.body",
  "github.event.head_commit.message",
  "github.event.commits",
  "github.event.pull_request.head.ref",
  "github.event.pull_request.head.label",
  "github.head_ref",
  "github.event.pages",
];

export function isWorkflowFile(path: string): boolean {
  return WORKFLOW_PATH.test(path);
}

interface NewLine {
  newLine: number;
  content: string;
  added: boolean;
}

/** New-side (added + context) lines of a hunk, in order, with added flags. */
function newSideLines(hunk: DiffHunk): NewLine[] {
  const out: NewLine[] = [];
  for (const l of hunk.lines) {
    if (l.newLine === undefined) continue; // deletions have no new-side line
    out.push({ newLine: l.newLine, content: l.content, added: l.type === "add" });
  }
  return out;
}

function indentOf(text: string): number {
  const m = /^(\s*)/.exec(text);
  return m ? m[1].length : 0;
}

function firstUntrusted(line: string): string | undefined {
  INTERP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INTERP.exec(line)) !== null) {
    const expr = m[1].replace(/\s+/g, "").toLowerCase();
    if (UNTRUSTED_CONTEXTS.some((c) => expr.includes(c))) return m[0];
    if (m.index === INTERP.lastIndex) INTERP.lastIndex += 1;
  }
  return undefined;
}

function unpinnedActionFinding(file: string, line: number, ref: string): Finding | undefined {
  if (ref.startsWith("./") || ref.startsWith("../") || ref.startsWith(".") || ref.startsWith("docker://")) {
    return undefined; // local action / docker ref — not a third-party tag pin
  }
  const at = ref.lastIndexOf("@");
  if (at === -1) return undefined; // no version pin at all (local reusable workflow, etc.)
  const nameRef = ref.slice(0, at);
  const version = ref.slice(at + 1);
  const owner = nameRef.split("/")[0]?.toLowerCase();
  if (owner && TRUSTED_OWNERS.has(owner)) return undefined;
  if (SHA.test(version)) return undefined; // already pinned to a commit SHA
  return {
    severity: "high",
    category: "supply-chain",
    file,
    line,
    title: `Unpinned third-party action: ${nameRef}`,
    body:
      `\`${ref}\` pins to the mutable ref \`${version}\`, which a compromised or malicious ` +
      `upstream can silently repoint to hostile code that then runs with this workflow's ` +
      `permissions. Pin third-party actions to a full-length commit SHA instead, e.g. ` +
      `\`uses: ${nameRef}@<40-char-sha> # ${version}\`, so the exact reviewed code is what runs.`,
  };
}

function pwnRequestFinding(file: string, lines: readonly NewLine[]): Finding | undefined {
  const targetLine = lines.find((l) => /pull_request_target/.test(l.content));
  if (!targetLine) return undefined;
  const checkoutLines = lines.filter((l) => HEAD_CHECKOUT.test(l.content));
  if (checkoutLines.length === 0) return undefined;

  const involvedAdded = targetLine.added || checkoutLines.some((l) => l.added);
  if (!involvedAdded) return undefined; // wholly pre-existing config — not this diff's change

  const addedCheckout = checkoutLines.find((l) => l.added);
  const anchor = addedCheckout ?? (targetLine.added ? targetLine : undefined);
  return {
    severity: "critical",
    category: "security",
    file,
    line: anchor?.newLine,
    title: "pull_request_target workflow checks out untrusted PR head code",
    body:
      "This workflow triggers on `pull_request_target` (which runs with the base repo's " +
      "secrets and a read/write token) AND checks out the PR's head ref. Code from a fork " +
      "PR would then execute with full access to those secrets — the classic \"pwn request\" " +
      "pattern. Use the `pull_request` trigger instead, or do not check out / build / run the " +
      "PR head under `pull_request_target`; only handle untrusted code in a sandboxed job that " +
      "has no secrets.",
  };
}

function injectionFindings(file: string, lines: readonly NewLine[]): Finding[] {
  const findings: Finding[] = [];
  let runIndent: number | null = null;
  for (const l of lines) {
    const runMatch = RUN_KEY.exec(l.content);
    if (runMatch) {
      runIndent = indentOf(l.content);
      // Inline `run: echo ${{ ... }}` — the expression is on the run: line itself.
      const inline = runMatch[2];
      if (l.added && inline) {
        const expr = firstUntrusted(inline);
        if (expr) findings.push(injectionFinding(file, l.newLine, expr));
      }
      continue;
    }
    if (runIndent === null) continue;
    if (l.content.trim().length === 0) continue; // blank line stays inside the block
    if (indentOf(l.content) <= runIndent) {
      runIndent = null; // dedented out of the run: block
      continue;
    }
    if (!l.added) continue;
    const expr = firstUntrusted(l.content);
    if (expr) findings.push(injectionFinding(file, l.newLine, expr));
  }
  return findings;
}

function injectionFinding(file: string, line: number, expr: string): Finding {
  return {
    severity: "critical",
    category: "security",
    file,
    line,
    title: "Untrusted input interpolated into a workflow run: script",
    body:
      `\`${expr}\` is attacker-controllable (a PR/issue title or body, a comment, or a branch ` +
      `name) and is interpolated directly into a shell \`run:\` block, allowing script injection ` +
      `into the runner. Pass it through an intermediate \`env:\` variable and reference it quoted ` +
      `(e.g. \`"$TITLE"\`) in the script, or consume it as an action input — never inline a ` +
      `\`\${{ github.event.* }}\` expression into the shell.`,
  };
}

/**
 * Run all workflow supply-chain checks over the changed workflow files in the
 * given diff. Pure and deterministic — no LLM call, no network.
 */
export function checkWorkflows(files: readonly DiffFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (file.isBinary || file.status === "deleted" || !isWorkflowFile(file.path)) continue;

    const allNewLines: NewLine[] = [];
    for (const hunk of file.hunks) {
      const lines = newSideLines(hunk);
      allNewLines.push(...lines);

      // (a) unpinned actions + (c) run: injection are scoped per hunk.
      for (const l of lines) {
        if (!l.added) continue;
        const uses = USES.exec(l.content);
        if (uses) {
          const finding = unpinnedActionFinding(file.path, l.newLine, uses[1]);
          if (finding) findings.push(finding);
        }
      }
      findings.push(...injectionFindings(file.path, lines));
    }

    // (b) pwn-request needs the whole file's visible new-side context.
    const pwn = pwnRequestFinding(file.path, allNewLines);
    if (pwn) findings.push(pwn);
  }
  return findings;
}
