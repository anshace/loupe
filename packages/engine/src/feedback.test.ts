import { describe, expect, it } from "vitest";
import type { ExistingComment } from "./dedupe";
import type { FetchLike } from "./diff";
import {
  buildFeedbackReport,
  classifyFeedback,
  fetchReviewThreadResolution,
  parseFindingTitle,
  toRunLogFeedback,
} from "./feedback";

describe("classifyFeedback (feature #12)", () => {
  it("disputes when 👎 outweigh 👍", () => {
    expect(classifyFeedback({ up: 0, down: 2, eyes: 0, confused: 0 }, undefined)).toBe("disputed");
    expect(classifyFeedback({ up: 1, down: 3, eyes: 0, confused: 0 }, true)).toBe("disputed"); // dispute beats resolved
  });

  it("disputes on 😕 with no 👍", () => {
    expect(classifyFeedback({ up: 0, down: 0, eyes: 0, confused: 1 }, undefined)).toBe("disputed");
  });

  it("accepts a resolved thread with no negative reactions", () => {
    expect(classifyFeedback(undefined, true)).toBe("accepted");
  });

  it("accepts on 👍", () => {
    expect(classifyFeedback({ up: 2, down: 0, eyes: 0, confused: 0 }, false)).toBe("accepted");
  });

  it("is unresolved with no signal at all", () => {
    expect(classifyFeedback(undefined, undefined)).toBe("unresolved");
    expect(classifyFeedback({ up: 0, down: 0, eyes: 3, confused: 0 }, false)).toBe("unresolved"); // 👀 is neither
  });
});

describe("parseFindingTitle (feature #12)", () => {
  it("extracts the title from a rendered inline comment body", () => {
    expect(parseFindingTitle("**[high] Missing null check**\n\nDereferences req.user.")).toBe("Missing null check");
  });

  it("returns undefined for an unrecognized body", () => {
    expect(parseFindingTitle("just some prose")).toBeUndefined();
  });
});

describe("buildFeedbackReport (feature #12)", () => {
  const comments: ExistingComment[] = [
    { path: "a.ts", line: 3, body: "**[high] Bug A**\n\n...", id: 100, reactions: { up: 0, down: 2, eyes: 0, confused: 0 } },
    { path: "b.ts", line: 9, body: "**[medium] Nit B**\n\n...", id: 200 }, // resolved via map → accepted
    { path: "c.ts", line: 1, body: "**[low] Thing C**\n\n...", id: 300 }, // no signal → unresolved
  ];

  it("classifies each prior finding by reactions + resolution", () => {
    const resolution = new Map<number, boolean>([
      [200, true],
      [300, false],
    ]);
    const report = buildFeedbackReport(comments, resolution);
    expect(report.total).toBe(3);
    expect(report.disputed).toBe(1);
    expect(report.accepted).toBe(1);
    expect(report.unresolved).toBe(1);
    const byPath = Object.fromEntries(report.items.map((i) => [i.path, i.classification]));
    expect(byPath).toEqual({ "a.ts": "disputed", "b.ts": "accepted", "c.ts": "unresolved" });
    expect(report.items[0].title).toBe("Bug A");
  });

  it("treats a comment with no id as resolution-unknown", () => {
    const report = buildFeedbackReport([{ path: "x.ts", body: "**[high] X**" }], new Map());
    expect(report.items[0].resolved).toBeUndefined();
    expect(report.items[0].classification).toBe("unresolved");
  });
});

describe("fetchReviewThreadResolution (feature #12)", () => {
  const pr = { owner: "anshace", repo: "demo", prNumber: 5 };

  it("maps comment databaseId → isResolved from the GraphQL response", async () => {
    const fake: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    { isResolved: true, comments: { nodes: [{ databaseId: 100 }, { databaseId: 101 }] } },
                    { isResolved: false, comments: { nodes: [{ databaseId: 200 }] } },
                  ],
                },
              },
            },
          },
        }),
    });
    const map = await fetchReviewThreadResolution(pr, "tok", fake);
    expect(map.get(100)).toBe(true);
    expect(map.get(101)).toBe(true);
    expect(map.get(200)).toBe(false);
    expect(map.size).toBe(3);
  });

  it("returns an empty map on API error, bad JSON, or network failure (fail-soft)", async () => {
    const err: FetchLike = async () => ({ ok: false, status: 500, text: async () => "boom" });
    expect((await fetchReviewThreadResolution(pr, "tok", err)).size).toBe(0);

    const garbage: FetchLike = async () => ({ ok: true, status: 200, text: async () => "not json" });
    expect((await fetchReviewThreadResolution(pr, "tok", garbage)).size).toBe(0);

    const down: FetchLike = async () => {
      throw new Error("network down");
    };
    expect((await fetchReviewThreadResolution(pr, "tok", down)).size).toBe(0);
  });
});

describe("toRunLogFeedback (feature #12)", () => {
  it("keeps counts and only disputed/unresolved detail items", () => {
    const report = buildFeedbackReport(
      [
        { path: "a.ts", body: "**[high] Bug A**", id: 1, reactions: { up: 0, down: 1, eyes: 0, confused: 0 } },
        { path: "b.ts", body: "**[low] Nit B**", id: 2, reactions: { up: 3, down: 0, eyes: 0, confused: 0 } },
        { path: "c.ts", body: "**[medium] Thing C**", id: 3 },
      ],
      new Map(),
    );
    const compact = toRunLogFeedback(report);
    expect(compact).toMatchObject({ accepted: 1, disputed: 1, unresolved: 1, total: 3 });
    expect(compact.items).toEqual([
      { path: "a.ts", title: "Bug A", class: "disputed" },
      { path: "c.ts", title: "Thing C", class: "unresolved" },
    ]);
  });

  it("omits items when there are no actionable ones, and respects the cap", () => {
    const allAccepted = buildFeedbackReport(
      [{ path: "a.ts", body: "**[high] A**", id: 1, reactions: { up: 1, down: 0, eyes: 0, confused: 0 } }],
      new Map(),
    );
    expect(toRunLogFeedback(allAccepted).items).toBeUndefined();

    const many = buildFeedbackReport(
      Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.ts`, body: `**[high] F${i}**`, id: i })),
      new Map(),
    );
    expect(toRunLogFeedback(many, 2).items).toHaveLength(2);
  });
});
