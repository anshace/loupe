import { describe, expect, it } from "vitest";
import type { FetchLike } from "./diff";
import { fetchPrIntent, parseLinkedIssues, renderPrIntent } from "./intent";

const pr = { owner: "anshace", repo: "demo", prNumber: 5 };

describe("parseLinkedIssues", () => {
  it("extracts numbers behind every closing keyword form, de-duped", () => {
    const body = "This fixes #12 and Closes #7. Also resolved #12. See #99 (not closing).";
    expect(parseLinkedIssues(body).sort((a, b) => a - b)).toEqual([7, 12]);
  });

  it("is case-insensitive and ignores plain mentions", () => {
    expect(parseLinkedIssues("FIX #3, references #4")).toEqual([3]);
  });

  it("returns [] for an empty or missing body", () => {
    expect(parseLinkedIssues(undefined)).toEqual([]);
    expect(parseLinkedIssues("")).toEqual([]);
    expect(parseLinkedIssues("no links here")).toEqual([]);
  });
});

describe("renderPrIntent", () => {
  it("renders title, description, and linked issues", () => {
    const text = renderPrIntent({ title: "Add retry", body: "Retries failed calls.", linkedIssues: [12] });
    expect(text).toContain("Title: Add retry");
    expect(text).toContain("Description:\nRetries failed calls.");
    expect(text).toContain("Linked issues (closed by this PR): #12");
  });

  it("omits empty parts and returns undefined when nothing is present", () => {
    expect(renderPrIntent(undefined)).toBeUndefined();
    expect(renderPrIntent({ linkedIssues: [] })).toBeUndefined();
    expect(renderPrIntent({ title: "Only title", linkedIssues: [] })).toBe("Title: Only title");
  });
});

describe("fetchPrIntent", () => {
  it("fetches title/body and derives linked issues", async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ title: "Fix bug", body: "Fixes #42." }),
    });
    const intent = await fetchPrIntent(pr, "tok", fetchImpl);
    expect(intent).toEqual({ title: "Fix bug", body: "Fixes #42.", linkedIssues: [42] });
  });

  it("fails soft to undefined on a non-OK response", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 404, text: async () => "nope" });
    expect(await fetchPrIntent(pr, "tok", fetchImpl)).toBeUndefined();
  });

  it("fails soft to undefined on non-JSON (e.g. a diff body served by mistake)", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, text: async () => "diff --git a/x b/x" });
    expect(await fetchPrIntent(pr, "tok", fetchImpl)).toBeUndefined();
  });

  it("fails soft when the network throws", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    expect(await fetchPrIntent(pr, "tok", fetchImpl)).toBeUndefined();
  });
});
