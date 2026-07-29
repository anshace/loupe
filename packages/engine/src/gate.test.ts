import { describe, expect, it } from "vitest";
import { shouldRun } from "./gate";

describe("shouldRun", () => {
  it("runs on a normal event", () => {
    expect(shouldRun({ isDraft: false, actor: "alice", botIdentity: "review-bot", headSha: "abc" })).toEqual({
      run: true,
    });
  });

  it("skips draft PRs", () => {
    const decision = shouldRun({ isDraft: true });
    expect(decision.run).toBe(false);
    if (!decision.run) expect(decision.reason).toMatch(/draft/);
  });

  it("skips events whose actor is the bot itself (case-insensitive)", () => {
    const decision = shouldRun({ actor: "Review-Bot[bot]", botIdentity: "review-bot[BOT]" });
    expect(decision.run).toBe(false);
    if (!decision.run) expect(decision.reason).toMatch(/bot/);
  });

  it("does not treat other actors as the bot", () => {
    expect(shouldRun({ actor: "alice", botIdentity: "review-bot" }).run).toBe(true);
  });

  it("skips when the head SHA matches the last reviewed SHA", () => {
    const decision = shouldRun({ headSha: "abc123", lastReviewedSha: "abc123" });
    expect(decision.run).toBe(false);
    if (!decision.run) expect(decision.reason).toContain("abc123");
  });

  it("runs on a new head SHA", () => {
    expect(shouldRun({ headSha: "def456", lastReviewedSha: "abc123" }).run).toBe(true);
  });

  it("onDemand overrides the already-reviewed-SHA skip", () => {
    expect(shouldRun({ headSha: "abc123", lastReviewedSha: "abc123", onDemand: true }).run).toBe(true);
  });

  it("onDemand does NOT override the draft or bot-actor skips", () => {
    expect(shouldRun({ isDraft: true, onDemand: true }).run).toBe(false);
    expect(shouldRun({ actor: "bot", botIdentity: "bot", onDemand: true }).run).toBe(false);
  });

  it("runs when no state is available (first review)", () => {
    expect(shouldRun({ headSha: "abc123" }).run).toBe(true);
  });
});
