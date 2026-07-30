/**
 * Dangerous-sink rule pack (SAST-lite) + taint prompting (feature #21, report
 * item #21).
 *
 * A hand-rolled, per-language pattern pack that scans the ADDED diff lines for
 * KNOWN dangerous sinks (eval/exec, innerHTML, dangerouslySetInnerHTML, raw SQL
 * concatenation, child_process, ReDoS-shaped regexes, Python `shell=True`, …).
 * JS/TS is phased first (the deepest pack); a small Python pack rides along.
 *
 * Crucially this is NOT a finding emitter. A pattern match is injected into the
 * reviewer prompt as a PRE-FLAGGED EVIDENCE line the model must REASON about:
 * before it may report high/critical it has to establish source→sink
 * reachability (does attacker/untrusted input actually reach this sink?). This
 * is a recall aid that shifts the model's attention, gated behind a
 * DEFAULT-OFF EngineConfig flag because its precision impact is unproven and
 * pending live-eval measurement (task 6.8-style).
 *
 * Zero deps, pure, no external SAST binary (honoring the no-shell-out non-goal).
 */
import type { DiffFile } from "./diff";

/** One dangerous-sink pattern. */
export interface SinkPattern {
  id: string;
  /** Short human label shown in the evidence block. */
  label: string;
  /** File extensions this pattern applies to (lowercase, no dot). */
  exts: readonly string[];
  regex: RegExp;
  /** Why it is dangerous + what makes it a true positive (the taint question). */
  note: string;
}

/** A pattern match on an added diff line. */
export interface SinkMatch {
  file: string;
  line: number;
  id: string;
  label: string;
  /** The trimmed, length-capped matched source line. */
  text: string;
  note: string;
}

const JS_EXTS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] as const;
const PY_EXTS = ["py"] as const;

/** Default cap on total pre-flagged sinks injected (bounds prompt bloat). */
export const DEFAULT_MAX_SINKS = 40;
/** Per matched line, cap the echoed source text. */
const MAX_LINE_TEXT = 200;

export const SINK_PATTERNS: readonly SinkPattern[] = [
  // ── JavaScript / TypeScript ──────────────────────────────────────────────
  {
    id: "js-eval",
    label: "eval()",
    exts: JS_EXTS,
    regex: /\beval\s*\(/,
    note: "eval executes arbitrary JS. Report high/critical only if any argument derives from untrusted input.",
  },
  {
    id: "js-new-function",
    label: "new Function()",
    exts: JS_EXTS,
    regex: /\bnew\s+Function\s*\(/,
    note: "The Function constructor compiles a string as code — same risk as eval when the body is tainted.",
  },
  {
    id: "js-innerhtml",
    label: "innerHTML/outerHTML assignment",
    exts: JS_EXTS,
    regex: /\.(?:inner|outer)HTML\s*(?:\+?=)/,
    note: "Assigning HTML from untrusted input is DOM XSS. True positive requires the value to be attacker-influenced and unsanitized.",
  },
  {
    id: "js-insert-adjacent-html",
    label: "insertAdjacentHTML()",
    exts: JS_EXTS,
    regex: /\.insertAdjacentHTML\s*\(/,
    note: "Injects parsed HTML — DOM XSS when the markup argument is tainted.",
  },
  {
    id: "js-document-write",
    label: "document.write()",
    exts: JS_EXTS,
    regex: /\bdocument\.write(?:ln)?\s*\(/,
    note: "Writes markup to the document — XSS when the argument is tainted.",
  },
  {
    id: "react-dangerously-set-inner-html",
    label: "dangerouslySetInnerHTML",
    exts: JS_EXTS,
    regex: /dangerouslySetInnerHTML/,
    note: "React's raw-HTML escape hatch — XSS when the __html value is untrusted/unsanitized.",
  },
  {
    id: "js-child-process",
    label: "child_process exec/spawn",
    exts: JS_EXTS,
    regex: /\bchild_process\b|\b(?:exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/,
    note: "Spawns an OS process — command injection when the command/args include untrusted input (esp. exec with a shell).",
  },
  {
    id: "js-sql-concat",
    label: "SQL built by concatenation/interpolation",
    exts: JS_EXTS,
    regex: /(?:select|insert\s+into|update|delete\s+from)\b[\s\S]*?(?:"\s*\+|'\s*\+|\+\s*["'`]|\$\{)/i,
    note: "A SQL statement assembled with + or ${} instead of parameters — SQL injection when the interpolated value is tainted.",
  },
  {
    id: "js-settimeout-string",
    label: "setTimeout/setInterval with a string",
    exts: JS_EXTS,
    regex: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/,
    note: "A string first argument is eval'd — code injection when that string is tainted.",
  },
  {
    id: "js-vm",
    label: "vm.runIn*Context()",
    exts: JS_EXTS,
    regex: /\bvm\.runIn(?:New|This)?Context\s*\(/,
    note: "Executes code in a VM context — not a security sandbox; arbitrary code execution when the source is tainted.",
  },
  {
    id: "js-redos",
    label: "possibly ReDoS-prone regex",
    exts: JS_EXTS,
    regex: /\/(?:[^/\\\n]|\\.)*(?:\([^)]*[+*][^)]*\)|\[[^\]]*\])[+*][^/\n]*\//,
    note: "Nested/adjacent unbounded quantifiers can backtrack catastrophically — DoS when the regex runs on attacker-sized input.",
  },
  // ── Python ────────────────────────────────────────────────────────────────
  {
    id: "py-eval-exec",
    label: "eval()/exec()",
    exts: PY_EXTS,
    regex: /\b(?:eval|exec)\s*\(/,
    note: "Executes arbitrary Python — code injection when the argument is tainted.",
  },
  {
    id: "py-os-system",
    label: "os.system()",
    exts: PY_EXTS,
    regex: /\bos\.system\s*\(/,
    note: "Runs a shell command — command injection when the string includes untrusted input.",
  },
  {
    id: "py-subprocess-shell",
    label: "subprocess with shell=True",
    exts: PY_EXTS,
    regex: /shell\s*=\s*True/,
    note: "A shell interprets the command line — command injection when any arg is tainted. Prefer a list argv with shell=False.",
  },
  {
    id: "py-pickle",
    label: "pickle.load(s)()",
    exts: PY_EXTS,
    regex: /\bpickle\.loads?\s*\(/,
    note: "Unpickling untrusted data executes arbitrary code (insecure deserialization).",
  },
  {
    id: "py-yaml-load",
    label: "yaml.load() without SafeLoader",
    exts: PY_EXTS,
    regex: /\byaml\.load\s*\((?![^)]*Safe)/,
    note: "Full-loader YAML can instantiate arbitrary objects — use yaml.safe_load on untrusted input.",
  },
];

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/**
 * Scan the ADDED lines of the diff for dangerous-sink patterns. Pure and
 * deterministic. Deleted/binary files are skipped; each line yields at most one
 * match per pattern id; the total is capped. Ordered by file then line.
 */
export function scanSinks(
  files: readonly DiffFile[],
  opts: { maxSinks?: number } = {},
): SinkMatch[] {
  const max = opts.maxSinks ?? DEFAULT_MAX_SINKS;
  const out: SinkMatch[] = [];
  for (const file of files) {
    if (file.isBinary || file.status === "deleted") continue;
    const ext = extOf(file.path);
    const patterns = SINK_PATTERNS.filter((p) => p.exts.includes(ext));
    if (patterns.length === 0) continue;
    for (const hunk of file.hunks) {
      for (const l of hunk.lines) {
        if (l.type !== "add" || l.newLine === undefined) continue;
        for (const p of patterns) {
          if (out.length >= max) return out;
          if (p.regex.test(l.content)) {
            out.push({
              file: file.path,
              line: l.newLine,
              id: p.id,
              label: p.label,
              text: l.content.trim().slice(0, MAX_LINE_TEXT),
              note: p.note,
            });
          }
        }
      }
    }
  }
  return out;
}

const SINK_HEADER =
  "### Pre-flagged dangerous sinks (deterministic pattern scan — reason about reachability)\n\n" +
  "A pattern scan flagged the lines below as KNOWN dangerous sinks. A match is NOT itself a\n" +
  "finding. Before reporting any of these at high/critical, you MUST trace whether\n" +
  "attacker-controlled or otherwise-untrusted input can REACH the sink (source→sink), and cite\n" +
  "that path in the finding body. If no untrusted input reaches the sink (e.g. the argument is a\n" +
  "constant or repo-internal value), treat it as a lower-severity hardening note or omit it.";

/** Render the {{SINK_EVIDENCE}} block from matches, or "(none)". Pure. */
export function renderSinkEvidence(matches: readonly SinkMatch[]): string {
  if (matches.length === 0) return "(none)";
  const lines = matches.map(
    (m) => `- \`${m.file}:${m.line}\` [${m.label}]: \`${m.text}\`\n  reachability question: ${m.note}`,
  );
  return [SINK_HEADER, ...lines].join("\n");
}
