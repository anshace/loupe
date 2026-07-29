import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diff";
import { checkWorkflows, isWorkflowFile } from "./workflowcheck";

/** New workflow file where every content line is an added line. */
function workflow(lines: readonly string[], path = ".github/workflows/ci.yml"): ReturnType<typeof parseUnifiedDiff> {
  const diff = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..2222222 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    lines.map((l) => `+${l}`).join("\n"),
  ].join("\n");
  return parseUnifiedDiff(diff);
}

/** Modified workflow from typed [type, text] rows. */
function workflowDiff(rows: ReadonlyArray<["ctx" | "add" | "del", string]>, path = ".github/workflows/ci.yml") {
  const oldCount = rows.filter(([t]) => t !== "add").length;
  const newCount = rows.filter(([t]) => t !== "del").length;
  const body = rows.map(([t, s]) => (t === "add" ? "+" : t === "del" ? "-" : " ") + s).join("\n");
  const diff = [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    body,
  ].join("\n");
  return parseUnifiedDiff(diff);
}

describe("isWorkflowFile", () => {
  it("matches only top-level .github/workflows/*.yml|yaml files", () => {
    expect(isWorkflowFile(".github/workflows/ci.yml")).toBe(true);
    expect(isWorkflowFile(".github/workflows/deploy.yaml")).toBe(true);
    expect(isWorkflowFile(".github/workflows/nested/ci.yml")).toBe(false);
    expect(isWorkflowFile(".github/actions/foo.yml")).toBe(false);
    expect(isWorkflowFile("src/ci.yml")).toBe(false);
  });

  it("returns no findings for non-workflow files even with dangerous content", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/ci.yml b/src/ci.yml",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/ci.yml",
        "@@ -0,0 +1,1 @@",
        "+  uses: some-org/action@v3",
      ].join("\n"),
    );
    expect(checkWorkflows(files)).toEqual([]);
  });
});

describe("checkWorkflows — (a) unpinned third-party actions", () => {
  it("flags a third-party action pinned to a mutable tag", () => {
    const findings = checkWorkflows(workflow(["    steps:", "      - uses: some-org/some-action@v3"]));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");
    expect(findings[0].category).toBe("supply-chain");
    expect(findings[0].title).toContain("some-org/some-action");
    expect(findings[0].line).toBe(2);
  });

  it("does not flag an action pinned to a full commit SHA", () => {
    const sha = "a".repeat(40);
    expect(checkWorkflows(workflow([`      - uses: some-org/some-action@${sha}`]))).toEqual([]);
  });

  it("does not flag first-party actions/* and github/* even on a tag", () => {
    expect(checkWorkflows(workflow(["      - uses: actions/checkout@v4"]))).toEqual([]);
    expect(checkWorkflows(workflow(["      - uses: github/codeql-action@v3"]))).toEqual([]);
  });

  it("does not flag local (./) actions", () => {
    expect(checkWorkflows(workflow(["      - uses: ./.github/actions/build"]))).toEqual([]);
  });

  it("only fires on added uses: lines, not pre-existing ones", () => {
    expect(checkWorkflows(workflowDiff([["ctx", "      - uses: some-org/some-action@v3"], ["add", "      - run: echo hi"]]))).toEqual(
      [],
    );
  });
});

describe("checkWorkflows — (b) pull_request_target pwn request", () => {
  const PWN = [
    "on: pull_request_target",
    "jobs:",
    "  build:",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        with:",
    "          ref: ${{ github.event.pull_request.head.sha }}",
  ];

  it("flags pull_request_target combined with a PR-head checkout", () => {
    const findings = checkWorkflows(workflow(PWN));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].category).toBe("security");
    expect(findings[0].title).toContain("pull_request_target");
    expect(findings[0].line).toBe(7); // anchored to the checkout ref line
  });

  it("does not flag pull_request_target without a PR-head checkout", () => {
    expect(checkWorkflows(workflow(["on: pull_request_target", "    steps:", "      - uses: actions/checkout@v4"]))).toEqual([]);
  });

  it("does not flag a PR-head checkout under the safe pull_request trigger", () => {
    const safe = ["on: pull_request", "    steps:", "        with:", "          ref: ${{ github.event.pull_request.head.sha }}"];
    expect(checkWorkflows(workflow(safe))).toEqual([]);
  });

  it("does not fire when the dangerous pair is wholly pre-existing (unchanged by this diff)", () => {
    const rows: Array<["ctx" | "add" | "del", string]> = PWN.map((l): ["ctx" | "add" | "del", string] => ["ctx", l]);
    rows.push(["add", "      - run: echo unrelated"]);
    expect(checkWorkflows(workflowDiff(rows))).toEqual([]);
  });
});

describe("checkWorkflows — (c) untrusted interpolation in run:", () => {
  it("flags an untrusted expression inside a run: block scalar", () => {
    const findings = checkWorkflows(
      workflow([
        "    steps:",
        "      - name: Greet",
        "        run: |",
        '          echo "Hello ${{ github.event.issue.title }}"',
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].category).toBe("security");
    expect(findings[0].title).toContain("run:");
  });

  it("flags an untrusted expression in an inline run:", () => {
    const findings = checkWorkflows(workflow(["      - run: echo ${{ github.event.pull_request.title }}"]));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
  });

  it("does not flag untrusted interpolation outside a run: block", () => {
    expect(
      checkWorkflows(workflow(["      - name: ${{ github.event.issue.title }}", "        run: echo safe"])),
    ).toEqual([]);
  });

  it("does not flag trusted context expressions inside run:", () => {
    expect(checkWorkflows(workflow(["      - run: echo ${{ github.sha }}"]))).toEqual([]);
  });

  it("only fires on added run: lines", () => {
    expect(
      checkWorkflows(
        workflowDiff([
          ["ctx", "        run: |"],
          ["ctx", '          echo "${{ github.event.issue.title }}"'],
          ["add", "          echo done"],
        ]),
      ),
    ).toEqual([]);
  });
});
