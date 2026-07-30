/**
 * Capped agentic tools (task 6.3): the reviewer/verifier model may answer
 * with `{"tool_calls": [...]}` instead of findings; the engine executes the
 * tools against the repo (grep over the git tree + contents API, read-file
 * via contents API) under HARD CAPS and re-prompts with the results. Cap
 * exhaustion forces a findings answer. Everything is injectable: the repo
 * reader, the caps, and the shared usage counters (reviewer + verifier share
 * one budget per run).
 *
 * The model NEVER executes anything itself — the engine runs read-only
 * lookups on its behalf (design decision 8 still holds: no write access).
 */
import { fetchRepoFile } from "./config";
import type { FetchLike } from "./diff";
import type { CostTracker } from "./cost";
import { parseToolCalls } from "./guardrail";
import type { ToolCallRequest } from "./guardrail";
import { findImporters } from "./importgraph";
import type { ModelResponse, ReviewModel } from "./model";
import type { RenderedPrompt } from "./prompt";
import type { SymbolRef, SymbolService } from "./symbols";
import type { AgenticCaps, AgenticUsage, AuthToken, PrIdentity } from "./types";

export const DEFAULT_AGENTIC_CAPS: Required<AgenticCaps> = {
  maxHops: 5,
  maxFileReads: 10,
  maxTotalBytes: 200 * 1024,
};

/** At most this many tool calls are executed per hop (the hop cap still rules). */
const MAX_CALLS_PER_HOP = 5;
/** grep returns at most this many matching lines. */
const MAX_GREP_MATCHES = 50;

export function newAgenticUsage(): AgenticUsage {
  return { hops: 0, fileReads: 0, bytesRead: 0, cappedOut: false };
}

/** Read-only repo access for tools. Injectable; production hits the GitHub API. */
export interface RepoReader {
  /** All blob paths at the reviewed revision. Errors → empty list. */
  listTree(): Promise<string[]>;
  /** Raw file content, or undefined when absent/unreadable. */
  readFile(path: string): Promise<string | undefined>;
}

/** Production reader: git/trees (recursive) + contents API, tree cached per run. */
export function githubRepoReader(
  pr: PrIdentity,
  auth: AuthToken,
  ref: string | undefined,
  fetchImpl: FetchLike,
): RepoReader {
  let treeCache: string[] | undefined;
  return {
    async listTree(): Promise<string[]> {
      if (treeCache) return treeCache;
      try {
        const url = `https://api.github.com/repos/${pr.owner}/${pr.repo}/git/trees/${encodeURIComponent(
          ref ?? "HEAD",
        )}?recursive=1`;
        const res = await fetchImpl(url, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${auth}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "code-review-engine",
          },
        });
        if (!res.ok) return (treeCache = []);
        const json = JSON.parse(await res.text()) as {
          tree?: Array<{ path?: string; type?: string }>;
        };
        treeCache = (json.tree ?? [])
          .filter((e) => e.type === "blob" && typeof e.path === "string")
          .map((e) => e.path as string);
      } catch {
        treeCache = [];
      }
      return treeCache;
    },
    readFile: (path: string) => fetchRepoFile(pr, auth, path, ref, fetchImpl),
  };
}

const BINARYISH = /\.(png|jpe?g|gif|ico|pdf|zip|gz|tar|jar|exe|dll|wasm|woff2?|ttf|eot|mp[34]|lock)$/i;

function numbered(text: string): string {
  return text
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(5)}| ${l}`)
    .join("\n");
}

async function runReadFile(
  path: string,
  reader: RepoReader,
  caps: Required<AgenticCaps>,
  usage: AgenticUsage,
): Promise<string> {
  if (usage.fileReads >= caps.maxFileReads || usage.bytesRead >= caps.maxTotalBytes) {
    usage.cappedOut = true;
    return `[read_file ${path}] refused: tool budget exhausted`;
  }
  const content = await reader.readFile(path);
  if (content === undefined) return `[read_file ${path}] file not found`;
  usage.fileReads += 1;
  const remaining = caps.maxTotalBytes - usage.bytesRead;
  const slice = content.slice(0, remaining);
  usage.bytesRead += slice.length;
  if (slice.length < content.length) usage.cappedOut = true;
  const truncNote = slice.length < content.length ? "\n[... truncated at byte cap]" : "";
  return `[read_file ${path}]\n${numbered(slice)}${truncNote}`;
}

async function runGrep(
  call: ToolCallRequest,
  reader: RepoReader,
  caps: Required<AgenticCaps>,
  usage: AgenticUsage,
): Promise<string> {
  const pattern = call.pattern as string;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch {
    return `[grep ${pattern}] invalid pattern`;
  }
  const tree = await reader.listTree();
  const scoped = call.path ? tree.filter((p) => p.startsWith(call.path as string)) : tree;

  // Path matches are free (no content fetch) — often enough for symbol lookups.
  const pathHits = scoped.filter((p) => regex.test(p)).slice(0, 20);

  const matches: string[] = [];
  for (const p of scoped) {
    if (matches.length >= MAX_GREP_MATCHES) break;
    if (BINARYISH.test(p)) continue;
    if (usage.fileReads >= caps.maxFileReads || usage.bytesRead >= caps.maxTotalBytes) {
      usage.cappedOut = true;
      break;
    }
    const content = await reader.readFile(p);
    if (content === undefined) continue;
    usage.fileReads += 1;
    usage.bytesRead += content.length;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
      if (regex.test(lines[i])) matches.push(`${p}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
  }

  const sections = [`[grep ${pattern}${call.path ? ` in ${call.path}` : ""}]`];
  sections.push(pathHits.length > 0 ? `Matching paths:\n${pathHits.join("\n")}` : "Matching paths: (none)");
  sections.push(matches.length > 0 ? `Matching lines:\n${matches.join("\n")}` : "Matching lines: (none within read budget)");
  if (usage.cappedOut) sections.push("[search stopped: tool budget exhausted]");
  return sections.join("\n");
}

async function runFindImporters(
  call: ToolCallRequest,
  reader: RepoReader,
  caps: Required<AgenticCaps>,
  usage: AgenticUsage,
): Promise<string> {
  const path = call.path as string;
  const importers = await findImporters(path, reader, caps, usage);
  const header = `[find_importers ${path}]`;
  if (importers.length === 0) {
    const note = usage.cappedOut ? "\n[scan stopped: tool budget exhausted]" : "";
    return `${header}\nNo importers found (regex scan of TS/JS relative imports).${note}`;
  }
  const list = importers.slice(0, MAX_GREP_MATCHES).map((i) => `- ${i.path}`).join("\n");
  const note = usage.cappedOut
    ? "\n[scan stopped: tool budget exhausted — this list may be incomplete]"
    : "";
  return `${header}\nFiles importing ${path} (${importers.length}):\n${list}${note}`;
}

function formatRef(r: SymbolRef): string {
  return `- ${r.path}:${r.line}:${r.column}: ${r.text}`;
}

/** find_definition / find_references / hover, backed by the injected SymbolService. */
async function runSymbolTool(
  call: ToolCallRequest,
  symbols: SymbolService | undefined,
): Promise<string> {
  const label = `[${call.tool} ${call.symbol}${call.line !== undefined ? `@${call.line}` : ""} in ${call.path}]`;
  if (!symbols) {
    return `${label} refused: TS symbol tools are not available this run`;
  }
  const query = { path: call.path as string, symbol: call.symbol as string, line: call.line };
  try {
    if (call.tool === "hover") {
      const info = await symbols.hover(query);
      return info ? `${label}\n${info}` : `${label}\nNo hover/type information found.`;
    }
    const refs =
      call.tool === "find_definition"
        ? await symbols.findDefinition(query)
        : await symbols.findReferences(query);
    if (refs.length === 0) {
      const noun = call.tool === "find_definition" ? "definition" : "reference";
      return `${label}\nNo ${noun}s found (symbol may be undeclared, or in a file outside the loaded set).`;
    }
    const shown = refs.slice(0, MAX_GREP_MATCHES);
    const note = refs.length > shown.length ? `\n[${refs.length - shown.length} more omitted]` : "";
    const kind = call.tool === "find_definition" ? "Definition(s)" : `Reference(s) (${refs.length})`;
    return `${label}\n${kind}:\n${shown.map(formatRef).join("\n")}${note}`;
  } catch {
    return `${label} failed: the symbol service errored (continuing)`;
  }
}

/** Execute one hop's tool calls under the caps; returns the results block. */
export async function executeToolCalls(
  calls: readonly ToolCallRequest[],
  reader: RepoReader,
  caps: Required<AgenticCaps>,
  usage: AgenticUsage,
  symbols?: SymbolService,
): Promise<string> {
  const parts: string[] = [];
  for (const call of calls.slice(0, MAX_CALLS_PER_HOP)) {
    if (call.tool === "read_file") {
      parts.push(await runReadFile(call.path as string, reader, caps, usage));
    } else if (call.tool === "find_importers") {
      parts.push(await runFindImporters(call, reader, caps, usage));
    } else if (call.tool === "find_definition" || call.tool === "find_references" || call.tool === "hover") {
      parts.push(await runSymbolTool(call, symbols));
    } else {
      parts.push(await runGrep(call, reader, caps, usage));
    }
  }
  if (calls.length > MAX_CALLS_PER_HOP) {
    parts.push(`[${calls.length - MAX_CALLS_PER_HOP} additional tool call(s) ignored: max ${MAX_CALLS_PER_HOP} per turn]`);
  }
  return parts.join("\n\n");
}

export interface AgenticOptions {
  reader: RepoReader;
  caps?: AgenticCaps;
  /** Shared counters so reviewer + verifier draw from ONE per-run budget. */
  usage?: AgenticUsage;
  /**
   * Injected TS language service (report item #33). When present, the
   * find_definition / find_references / hover tools are executable; when absent,
   * those tool calls are answered "not available this run". Loads PR-head files
   * on its own budget — it does not draw from the reader byte caps above.
   */
  symbols?: SymbolService;
}

export interface AgenticResult {
  /** The final (non-tool-call, hopefully findings-bearing) response; undefined
   *  when the cost cap prevented even the first model call. */
  response?: ModelResponse;
  usage: AgenticUsage;
  /** True when the per-run token cap stopped the loop. */
  costStopped: boolean;
}

/**
 * The engine-side agentic loop: call the model; if it requests tools and
 * agentic mode is on, execute them (capped) and re-prompt with the results;
 * on cap exhaustion, force a findings answer. Token costs of every hop are
 * recorded on the shared CostTracker; when the tracker says stop, the loop
 * returns what it has — never a hard failure (6.6).
 */
export async function agenticComplete(
  model: ReviewModel,
  prompt: RenderedPrompt,
  tracker: CostTracker,
  agentic?: AgenticOptions,
): Promise<AgenticResult> {
  const caps: Required<AgenticCaps> = { ...DEFAULT_AGENTIC_CAPS, ...agentic?.caps };
  const usage = agentic?.usage ?? newAgenticUsage();
  let user = prompt.user;
  let last: ModelResponse | undefined;
  let forced = false;

  for (;;) {
    if (!tracker.canProceed()) return { response: last, usage, costStopped: true };
    const response = await model.complete({ system: prompt.system, user });
    tracker.record(model.name, response.inputTokens, response.outputTokens);
    last = response;

    const calls = agentic ? parseToolCalls(response.text) : undefined;
    if (calls === undefined || !agentic) return { response, usage, costStopped: false };
    if (forced) {
      // The model ignored the forcing and asked for tools again — hand the
      // response downstream, where the guardrail degrades it safely.
      return { response, usage, costStopped: false };
    }
    if (usage.hops >= caps.maxHops || usage.cappedOut || calls.length === 0) {
      forced = true;
      user += `\n\n---\n\nYour previous response:\n${response.text}\n\nThe tool budget is exhausted. Respond now with ONLY the required JSON array — no tool calls.`;
      continue;
    }
    usage.hops += 1;
    const results = await executeToolCalls(calls, agentic.reader, caps, usage, agentic.symbols);
    user += `\n\n---\n\nYour previous response requested tools:\n${response.text}\n\nTool results:\n${results}\n\nContinue: request more tools if needed (within budget) or respond with ONLY the required JSON array.`;
  }
}
