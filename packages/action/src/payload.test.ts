import { describe, expect, it } from "vitest";
import { extractPrEventInfo, toRunEvent } from "./payload";
import fixture from "./fixtures/pull_request.opened.json";

describe("extractPrEventInfo", () => {
  it("extracts PR number, head SHA, stats, draft state, and actor from a pull_request event", () => {
    expect(extractPrEventInfo(fixture)).toEqual({
      prNumber: 7,
      headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      fileCount: 3,
      additions: 42,
      deletions: 7,
      isDraft: false,
      actor: "anshace",
    });
  });

  it("throws on a payload without pull_request", () => {
    expect(() => extractPrEventInfo({ action: "opened" })).toThrow(/no pull_request/);
  });

  it("throws when a stat field is missing", () => {
    const broken = JSON.parse(JSON.stringify(fixture));
    delete broken.pull_request.changed_files;
    expect(() => extractPrEventInfo(broken)).toThrow(/changed_files/);
  });

  it("throws when head sha is missing", () => {
    const broken = JSON.parse(JSON.stringify(fixture));
    delete broken.pull_request.head.sha;
    expect(() => extractPrEventInfo(broken)).toThrow(/head\.sha/);
  });

  it("reads draft: true and tolerates a missing sender", () => {
    const draft = JSON.parse(JSON.stringify(fixture));
    draft.pull_request.draft = true;
    delete draft.sender;
    const info = extractPrEventInfo(draft);
    expect(info.isDraft).toBe(true);
    expect(info.actor).toBeUndefined();
  });
});

describe("toRunEvent", () => {
  it("maps payload info to the engine RunEvent the worker adapter also builds", () => {
    expect(toRunEvent(extractPrEventInfo(fixture))).toEqual({
      isDraft: false,
      actor: "anshace",
      headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
      onDemand: false,
    });
  });
});
