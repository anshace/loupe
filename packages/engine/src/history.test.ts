import { describe, expect, it } from "vitest";
import type { FetchLike } from "./diff";
import {
  collectChurnyPaths,
  collectFileHistories,
  fetchBlameRanges,
  renderHistoryContext,
  summarizeFileHistory,
  type BlameRange,
} from "./history";

const pr = { owner: "anshace", repo: "demo", prNumber: 1 };

/** Build a GraphQL blame response from range tuples. */
function blameResponse(
  ranges: Array<{ start: number; end: number; date: string; author?: string; oid?: string }>,
): string {
  return JSON.stringify({
    data: {
      repository: {
        object: {
          blame: {
            ranges: ranges.map((r) => ({
              startingLine: r.start,
              endingLine: r.end,
              commit: { oid: r.oid, committedDate: r.date, author: r.author ? { name: r.author } : null },
            })),
          },
        },
      },
    },
  });
}

const NOW = new Date("2026-07-30T00:00:00Z");

describe("summarizeFileHistory (report item #20)", () => {
  const ranges: BlameRange[] = [
    { startLine: 1, endLine: 10, committedDate: "2025-01-01T00:00:00Z", author: "Alice", oid: "aaaaaaa1" },
    { startLine: 11, endLine: 20, committedDate: "2026-07-29T00:00:00Z", author: "Bob", oid: "bbbbbbb2" },
  ];

  it("summarizes only the ranges overlapping the changed spans", () => {
    const h = summarizeFileHistory("src/x.ts", ranges, [{ startLine: 12, endLine: 15 }], NOW);
    expect(h).toEqual({
      path: "src/x.ts",
      authorCount: 1,
      commitCount: 1,
      mostRecentDaysAgo: 1,
      oldestDaysAgo: 1,
      mostRecentOid: "bbbbbbb",
    });
  });

  it("aggregates authors, most-recent, and oldest across all overlapping ranges", () => {
    const h = summarizeFileHistory("src/x.ts", ranges, [{ startLine: 1, endLine: 20 }], NOW);
    expect(h?.authorCount).toBe(2);
    expect(h?.commitCount).toBe(2);
    expect(h?.mostRecentDaysAgo).toBe(1);
    expect(h?.oldestDaysAgo).toBeGreaterThanOrEqual(365); // 2025-01-01 → stable
    expect(h?.mostRecentOid).toBe("bbbbbbb");
  });

  it("returns undefined when no range overlaps the spans", () => {
    expect(summarizeFileHistory("src/x.ts", ranges, [{ startLine: 50, endLine: 60 }], NOW)).toBeUndefined();
  });

  it("returns undefined for empty spans", () => {
    expect(summarizeFileHistory("src/x.ts", ranges, [], NOW)).toBeUndefined();
  });

  it("takes `now` as a parameter — never reads the clock", () => {
    const earlier = summarizeFileHistory("src/x.ts", ranges, [{ startLine: 11, endLine: 20 }], new Date("2026-07-29T00:00:00Z"));
    expect(earlier?.mostRecentDaysAgo).toBe(0); // same day as the commit
  });
});

describe("renderHistoryContext", () => {
  it("renders a compact per-file line with authors, recency, and a stable flag", () => {
    const out = renderHistoryContext([
      { path: "src/x.ts", authorCount: 2, commitCount: 3, mostRecentDaysAgo: 1, oldestDaysAgo: 400, mostRecentOid: "abc1234" },
    ]);
    expect(out).toContain("src/x.ts");
    expect(out).toContain("last touched 1 day ago");
    expect(out).toContain("by 2 authors");
    expect(out).toContain("3 commits");
    expect(out).toContain("(abc1234)");
    expect(out).toContain("365+ days ago (stable)");
  });

  it("says 'today' at zero days and singularizes one author", () => {
    const out = renderHistoryContext([
      { path: "a.ts", authorCount: 1, commitCount: 1, mostRecentDaysAgo: 0, oldestDaysAgo: 0 },
    ]);
    expect(out).toContain("last touched today");
    expect(out).toContain("by 1 author");
    expect(out).not.toContain("commits");
    expect(out).not.toContain("stable");
  });

  it("is (none) for no histories", () => {
    expect(renderHistoryContext([])).toBe("(none)");
  });
});

describe("fetchBlameRanges", () => {
  it("parses a GraphQL blame response", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => blameResponse([{ start: 1, end: 5, date: "2026-01-01T00:00:00Z", author: "Alice", oid: "deadbeef" }]),
    });
    const ranges = await fetchBlameRanges(pr, "tok", "src/x.ts", "HEAD", fetchImpl);
    expect(ranges).toEqual([
      { startLine: 1, endLine: 5, committedDate: "2026-01-01T00:00:00Z", author: "Alice", oid: "deadbeef" },
    ]);
  });

  it("is fail-soft: non-ok → undefined", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 502, text: async () => "bad gateway" });
    expect(await fetchBlameRanges(pr, "tok", "src/x.ts", "HEAD", fetchImpl)).toBeUndefined();
  });

  it("is fail-soft: unparseable body → undefined", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, text: async () => "not json" });
    expect(await fetchBlameRanges(pr, "tok", "src/x.ts", "HEAD", fetchImpl)).toBeUndefined();
  });

  it("is fail-soft: a thrown fetch → undefined", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    expect(await fetchBlameRanges(pr, "tok", "src/x.ts", "HEAD", fetchImpl)).toBeUndefined();
  });

  it("skips malformed ranges but keeps the good ones", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: {
            repository: {
              object: {
                blame: {
                  ranges: [
                    { startingLine: "x", endingLine: 5, commit: { committedDate: "2026-01-01T00:00:00Z" } },
                    { startingLine: 6, endingLine: 9, commit: { committedDate: "2026-02-01T00:00:00Z" } },
                  ],
                },
              },
            },
          },
        }),
    });
    const ranges = await fetchBlameRanges(pr, "tok", "src/x.ts", "HEAD", fetchImpl);
    expect(ranges).toHaveLength(1);
    expect(ranges?.[0].startLine).toBe(6);
  });
});

describe("collectFileHistories", () => {
  it("fetches + summarizes per file, skipping files whose blame fails", async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? "{}") as { variables?: { path?: string } };
      if (body.variables?.path === "src/bad.ts") return { ok: false, status: 500, text: async () => "" };
      return {
        ok: true,
        status: 200,
        text: async () => blameResponse([{ start: 1, end: 40, date: "2026-07-20T00:00:00Z", author: "Alice", oid: "cafef00d" }]),
      };
    };
    const histories = await collectFileHistories(
      pr,
      "tok",
      "HEAD",
      [
        { path: "src/good.ts", spans: [{ startLine: 5, endLine: 10 }] },
        { path: "src/bad.ts", spans: [{ startLine: 1, endLine: 2 }] },
      ],
      fetchImpl,
      NOW,
    );
    expect(histories.map((h) => h.path)).toEqual(["src/good.ts"]);
    expect(histories[0].mostRecentDaysAgo).toBe(10);
  });
});

// ── Churn history (report item #19) ─────────────────────────────────────────

/** A commits-API response from a list of commit messages. */
function commitsResponse(messages: readonly string[]): string {
  return JSON.stringify(messages.map((message) => ({ commit: { message } })));
}

describe("collectChurnyPaths", () => {
  it("returns only the paths whose recent history shows revert/hotfix churn", async () => {
    const fetchImpl: FetchLike = async (url) => {
      const path = new URL(url).searchParams.get("path");
      const messages =
        path === "src/hot.ts"
          ? ["normal feature", "hotfix: crash on null"]
          : ["add feature", "refactor"];
      return { ok: true, status: 200, text: async () => commitsResponse(messages) };
    };
    const churny = await collectChurnyPaths(pr, "tok", "HEAD", ["src/hot.ts", "src/calm.ts"], fetchImpl);
    expect(churny).toEqual(["src/hot.ts"]);
  });

  it("is fail-soft: a non-ok response drops that path, never throws", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 404, text: async () => "" });
    await expect(collectChurnyPaths(pr, "tok", "HEAD", ["src/x.ts"], fetchImpl)).resolves.toEqual([]);
  });

  it("scopes the commits query to the file path", async () => {
    const urls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => commitsResponse(["revert bad change"]) };
    };
    await collectChurnyPaths(pr, "tok", "abc123", ["src/a.ts"], fetchImpl);
    expect(urls[0]).toContain("path=src%2Fa.ts");
    expect(urls[0]).toContain("sha=abc123");
  });
});
