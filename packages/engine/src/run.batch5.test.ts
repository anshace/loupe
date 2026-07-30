/**
 * Integration tests for Batch-2 (reflection & calibration) wired through the
 * full pipeline:
 *   #27 bounded reflection demotes a critical/high `keep` whose evidence a second
 *       critique pass rejects (never drops it);
 *   #29 empirical calibration pre-suppresses a finding whose (category,severity)
 *       shape has a persistently low keep-rate in the run-log history;
 *   #30 the verifier's optional confidence field is captured in the run log.
 */
import { describe, expect, it } from "vitest";
import type { ExistingComments } from "./dedupe";
import type { FetchLike } from "./diff";
import { runReview } from "./run";
import type { RunDeps } from "./run";
import type { ModelRequest, ModelResponse, ReviewModel } from "./model";
import type { AuthToken, EngineConfig, PrIdentity, ReviewPayload } from "./types";
import type { RunLogRecord } from "./runlog";

const pr = { owner: "anshace", repo: "demo", prNumber: 27 };
const NO_COMMENTS: ExistingComments = { reviewComments: [], issueComments: [] };

function diffFetch(diff: string): FetchLike {
  return async () => ({ ok: true, status: 200, text: async () => diff });
}

function newFileDiff(path: string, lines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..2222222 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    lines.map((l) => `+${l}`).join("\n"),
  ].join("\n");
}

/** A model that replays a queued list of responses in order (verifier-of-verifier needs ≥3). */
class SeqProvider implements ReviewModel {
  readonly name = "mock-seq";
  readonly requests: ModelRequest[] = [];
  #i = 0;
  constructor(private readonly responses: string[]) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const text = this.responses[Math.min(this.#i, this.responses.length - 1)];
    this.#i += 1;
    return { text, inputTokens: 5, outputTokens: 5 };
  }
}

function capture(): { posts: ReviewPayload[]; deps: RunDeps } {
  const posts: ReviewPayload[] = [];
  return {
    posts,
    deps: {
      post: async (_pr: PrIdentity, _auth: AuthToken, payload: ReviewPayload) => {
        posts.push(payload);
      },
      upsertSummary: async () => {},
      repoFiles: {},
      existingComments: NO_COMMENTS,
      headFiles: {},
    },
  };
}

const base: EngineConfig = { event: { headSha: "abc123" }, minSeverity: "low", escalation: false };

const FILE_LINES = [
  "export function run(id: string) {",
  "  const row = db.query(`SELECT * FROM t WHERE id = ${id}`);",
  "  return row;",
  "}",
];
const DIFF = newFileDiff("src/db.ts", FILE_LINES);

function runLogCapture(history: RunLogRecord[] = []): { lines: string[]; io: RunDeps["runLogIo"] } {
  const lines: string[] = [];
  return {
    lines,
    io: {
      readFile: () => history.map((r) => JSON.stringify(r)).join("\n"),
      appendFile: (_p: string, line: string) => {
        lines.push(line);
      },
    },
  };
}

describe("runReview — bounded reflection (#27)", () => {
  it("demotes a critical `keep` when the reflection pass rejects its evidence, and never drops it", async () => {
    const model = new SeqProvider([
      // 1) reviewer
      JSON.stringify([
        {
          severity: "critical",
          category: "security",
          file: "src/db.ts",
          line: 2,
          title: "SQL injection",
          body: "user id is interpolated into the query.",
        },
      ]),
      // 2) verifier keeps it
      JSON.stringify([{ id: 1, verdict: "keep", evidence: "src/db.ts:2 — db.query(`SELECT * FROM t WHERE id = ${id}`)" }]),
      // 3) reflection: evidence does not establish critical
      JSON.stringify([{ id: 1, upholds: false, note: "id may be numeric-validated upstream; severity overstated" }]),
    ]);
    const { posts, deps } = capture();
    const result = await runReview(
      pr,
      "tok",
      { ...base, verify: true, reflection: true },
      { ...deps, fetchImpl: diffFetch(DIFF), model },
    );

    expect(model.requests).toHaveLength(3); // reviewer + verifier + reflection
    expect(result.findings).toHaveLength(1); // NOT dropped
    expect(result.findings[0].severity).toBe("high"); // critical → high
    expect(result.verification?.reflection?.demotions).toHaveLength(1);
    expect(result.notices.some((n) => n.includes("reflection: demoted"))).toBe(true);
  });

  it("does not run the reflection pass when the flag is off", async () => {
    const model = new SeqProvider([
      JSON.stringify([{ severity: "critical", category: "security", file: "src/db.ts", line: 2, title: "SQLi", body: "x" }]),
      JSON.stringify([{ id: 1, verdict: "keep", evidence: "src/db.ts:2 — db.query" }]),
    ]);
    const { deps } = capture();
    const result = await runReview(
      pr,
      "tok",
      { ...base, verify: true, reflection: false },
      { ...deps, fetchImpl: diffFetch(DIFF), model },
    );
    expect(model.requests).toHaveLength(2); // no reflection call
    expect(result.findings[0].severity).toBe("critical");
    expect(result.verification?.reflection).toBeUndefined();
  });
});

describe("runReview — empirical calibration pre-suppression (#29)", () => {
  const history: RunLogRecord[] = [
    {
      pr: "anshace/demo#1",
      timestamp: "2026-07-01T00:00:00.000Z",
      inputTokens: 0,
      outputTokens: 0,
      estCostUsd: 0,
      findingsKept: 0,
      findingsDropped: 5,
      dropReasons: {},
      verifierDropped: 5,
      abstained: 0,
      verifierUngrounded: 0,
      escalated: false,
      incremental: false,
      // The "security|critical" shape was dropped 5× and never kept → keepRate 0.
      verifierShapes: { kept: {}, dropped: { "security|critical": 5 } },
    },
  ];

  it("pre-suppresses a persistently-low-keep-rate shape before the verifier and records it", async () => {
    const model = new SeqProvider([
      JSON.stringify([
        { severity: "critical", category: "security", file: "src/db.ts", line: 2, title: "SQLi", body: "x" },
      ]),
      // Verifier would keep it — but it never reaches the verifier.
      JSON.stringify([{ id: 1, verdict: "keep", evidence: "e" }]),
    ]);
    const { lines, io } = runLogCapture(history);
    const { deps } = capture();
    const result = await runReview(
      pr,
      "tok",
      { ...base, verify: true, empiricalCalibration: true, runLogPath: "run.jsonl" },
      { ...deps, fetchImpl: diffFetch(DIFF), model, runLogIo: io },
    );

    expect(result.findings).toHaveLength(0); // suppressed before publish
    expect(result.suppressed).toEqual([
      expect.objectContaining({ reason: "low-keep-rate", finding: expect.objectContaining({ title: "SQLi" }) }),
    ]);
    // Verifier never called (only the reviewer ran).
    expect(model.requests).toHaveLength(1);
    const appended = JSON.parse(lines.at(-1) as string);
    expect(appended.calibrationSuppressed).toBe(1);
    expect(result.notices.some((n) => n.includes("empirical calibration: pre-suppressed"))).toBe(true);
  });

  it("suppresses nothing when the flag is off (default)", async () => {
    const model = new SeqProvider([
      JSON.stringify([
        { severity: "critical", category: "security", file: "src/db.ts", line: 2, title: "SQLi", body: "x" },
      ]),
    ]);
    const { io } = runLogCapture(history);
    const { deps } = capture();
    const result = await runReview(
      pr,
      "tok",
      { ...base, runLogPath: "run.jsonl" },
      { ...deps, fetchImpl: diffFetch(DIFF), model, runLogIo: io },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.suppressed.some((s) => s.reason === "low-keep-rate")).toBe(false);
  });
});

describe("runReview — verifier confidence capture (#30)", () => {
  it("records the verifier's self-reported confidences of kept findings in the run log", async () => {
    const model = new SeqProvider([
      JSON.stringify([{ severity: "high", category: "bug", file: "src/db.ts", line: 2, title: "bug", body: "x" }]),
      JSON.stringify([{ id: 1, verdict: "keep", evidence: "src/db.ts:2 — db.query", confidence: 0.9 }]),
    ]);
    const { lines, io } = runLogCapture();
    const { deps } = capture();
    await runReview(
      pr,
      "tok",
      { ...base, verify: true, runLogPath: "run.jsonl" },
      { ...deps, fetchImpl: diffFetch(DIFF), model, runLogIo: io },
    );
    const appended = JSON.parse(lines.at(-1) as string);
    expect(appended.verifierConfidences).toEqual([0.9]);
  });
});
