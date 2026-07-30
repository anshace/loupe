import { describe, expect, it } from "vitest";
import { mapWebhook } from "./route";

const repoParts = {
  repository: { name: "repo", owner: { login: "owner" } },
  installation: { id: 555 },
};

function prPayload(action: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action,
    pull_request: { number: 42, draft: false, head: { sha: "abc123" }, ...overrides },
    sender: { login: "alice" },
    ...repoParts,
  };
}

function commentPayload(body: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "created",
    issue: { number: 42, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/42" } },
    comment: { id: 900, body, user: { login: "alice" } },
    sender: { login: "alice" },
    ...repoParts,
    ...overrides,
  };
}

describe("mapWebhook — pull_request", () => {
  it.each(["opened", "synchronize", "reopened", "ready_for_review"])(
    "dispatches a review for action %s with a full RunEvent",
    (action) => {
      expect(mapWebhook("pull_request", prPayload(action))).toEqual({
        kind: "review",
        pr: { owner: "owner", repo: "repo", prNumber: 42 },
        installationId: 555,
        event: { isDraft: false, actor: "alice", headSha: "abc123", onDemand: false },
      });
    },
  );

  it.each(["closed", "labeled", "edited", "assigned"])("ignores action %s", (action) => {
    expect(mapWebhook("pull_request", prPayload(action)).kind).toBe("ignore");
  });

  it("carries draft state through (the engine gate does the skipping)", () => {
    const dispatch = mapWebhook("pull_request", prPayload("opened", { draft: true }));
    expect(dispatch).toMatchObject({ kind: "review", event: { isDraft: true } });
  });

  it("carries the top-level before SHA on synchronize (incremental scoping, 7.2)", () => {
    const payload = { ...prPayload("synchronize"), before: "beforesha" };
    expect(mapWebhook("pull_request", payload)).toMatchObject({
      kind: "review",
      event: { headSha: "abc123", before: "beforesha" },
    });
  });

  it("ignores a payload with no installation id", () => {
    const payload = prPayload("opened");
    delete payload.installation;
    expect(mapWebhook("pull_request", payload)).toMatchObject({ kind: "ignore", reason: /installation/ });
  });

  it("ignores a payload missing head.sha", () => {
    expect(mapWebhook("pull_request", prPayload("opened", { head: {} })).kind).toBe("ignore");
  });
});

describe("mapWebhook — issue_comment", () => {
  it("dispatches /review as an on-demand command", () => {
    expect(mapWebhook("issue_comment", commentPayload("/review"))).toEqual({
      kind: "command",
      command: "review",
      pr: { owner: "owner", repo: "repo", prNumber: 42 },
      installationId: 555,
      commenter: "alice",
      commentId: 900,
      argument: "",
    });
  });

  it("dispatches /ask with the question as the argument", () => {
    expect(mapWebhook("issue_comment", commentPayload("/ask why is this loop O(n^2)?"))).toMatchObject({
      kind: "command",
      command: "ask",
      argument: "why is this loop O(n^2)?",
    });
  });

  it("tolerates leading whitespace before the command", () => {
    expect(mapWebhook("issue_comment", commentPayload("  /review please")).kind).toBe("command");
  });

  it("requires a word boundary — /reviewing is not a command", () => {
    expect(mapWebhook("issue_comment", commentPayload("/reviewing this now")).kind).toBe("ignore");
    expect(mapWebhook("issue_comment", commentPayload("/askance")).kind).toBe("ignore");
  });

  it("ignores ordinary comments", () => {
    expect(mapWebhook("issue_comment", commentPayload("looks good to me")).kind).toBe("ignore");
  });

  it("ignores commands buried mid-comment", () => {
    expect(mapWebhook("issue_comment", commentPayload("could you /review this?")).kind).toBe("ignore");
  });

  it("ignores comments on plain issues (no pull_request key)", () => {
    const payload = commentPayload("/review", { issue: { number: 42 } });
    expect(mapWebhook("issue_comment", payload)).toMatchObject({ kind: "ignore", reason: /not a pull request/ });
  });

  it("ignores edited and deleted comment events", () => {
    expect(mapWebhook("issue_comment", commentPayload("/review", { action: "edited" })).kind).toBe("ignore");
    expect(mapWebhook("issue_comment", commentPayload("/review", { action: "deleted" })).kind).toBe("ignore");
  });
});

function reviewCommentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "created",
    pull_request: { number: 42 },
    comment: {
      id: 901,
      in_reply_to_id: 900,
      body: "is this really exploitable?",
      user: { login: "alice" },
      diff_hunk: "@@ -1 +1 @@\n-old\n+new",
      path: "src/a.ts",
    },
    sender: { login: "alice" },
    ...repoParts,
    ...overrides,
  };
}

describe("mapWebhook — pull_request_review_comment (report item #32)", () => {
  it("dispatches a reply carrying the thread root, hunk, and reply body", () => {
    expect(mapWebhook("pull_request_review_comment", reviewCommentPayload())).toEqual({
      kind: "reply",
      pr: { owner: "owner", repo: "repo", prNumber: 42 },
      installationId: 555,
      commenter: "alice",
      commentId: 901,
      inReplyToId: 900,
      body: "is this really exploitable?",
      diffHunk: "@@ -1 +1 @@\n-old\n+new",
      path: "src/a.ts",
    });
  });

  it("ignores a top-level review comment (no in_reply_to_id)", () => {
    const payload = reviewCommentPayload();
    delete (payload.comment as Record<string, unknown>).in_reply_to_id;
    expect(mapWebhook("pull_request_review_comment", payload)).toMatchObject({
      kind: "ignore",
      reason: /not a reply/,
    });
  });

  it("ignores edited/deleted review comments", () => {
    expect(mapWebhook("pull_request_review_comment", reviewCommentPayload({ action: "edited" })).kind).toBe(
      "ignore",
    );
    expect(mapWebhook("pull_request_review_comment", reviewCommentPayload({ action: "deleted" })).kind).toBe(
      "ignore",
    );
  });

  it("ignores a payload with no installation id", () => {
    const payload = reviewCommentPayload();
    delete payload.installation;
    expect(mapWebhook("pull_request_review_comment", payload).kind).toBe("ignore");
  });

  it("tolerates a missing diff_hunk (falls back to empty string)", () => {
    const payload = reviewCommentPayload();
    delete (payload.comment as Record<string, unknown>).diff_hunk;
    expect(mapWebhook("pull_request_review_comment", payload)).toMatchObject({ kind: "reply", diffHunk: "" });
  });
});

describe("mapWebhook — everything else", () => {
  it("ignores unhandled event names", () => {
    expect(mapWebhook("push", { ref: "refs/heads/main" }).kind).toBe("ignore");
    expect(mapWebhook("ping", { zen: "Keep it simple." }).kind).toBe("ignore");
    expect(mapWebhook(undefined, prPayload("opened")).kind).toBe("ignore");
  });

  it("ignores non-object payloads", () => {
    expect(mapWebhook("pull_request", "[]").kind).toBe("ignore");
    expect(mapWebhook("pull_request", null).kind).toBe("ignore");
  });
});
