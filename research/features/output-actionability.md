# Output quality & actionability — features Loupe lacks

**Research date:** 2026-07-30. Scope: OUTPUT-side quality — what happens *after* the reviewer/verifier
pipeline has produced findings — not diff-fetch, prompting, or verification methodology (those are
covered by sibling research files). Cross-checked directly against the current engine source, not just
prior research docs, so every gap below is confirmed against real code, not assumed.

## Method

Read the current implementation of the output path before searching anything:
`packages/engine/src/publish.ts`, `summary.ts`, `clamp.ts`, `types.ts`, `guardrail.ts`, `config.ts`,
`escalate.ts`, and the worker's `route.ts` / `handlers.ts` (the only place a conversational surface
exists today — the `/ask` slash command). Then researched 2026 competitor mechanics and GitHub API
mechanics for each candidate. `research/04-commercial-products-landscape.md` and
`research/09-feature-requirements.md` already catalogue TS-09 (committable suggestions), TS-12 (`/ask`),
and LT-05 (diagrams — recorded as deliberate polish, not re-litigated here). This file goes one level
deeper: it confirms which of those are actually implemented today (several are not) and adds gaps those
docs didn't name at all (risk verdict, auto-labeling, in-thread replies, evidence permalinks).

---

## Confirmed current state (so the gaps below are precise, not guessed)

- `Finding.suggestion` (`packages/engine/src/types.ts:13`) is a free-text string. `formatFindingComment`
  (`packages/engine/src/publish.ts:9-13`) renders it as `**Suggested fix:**\n${finding.suggestion}` —
  **plain markdown prose, not a GitHub `` ```suggestion `` fence**. GitHub never renders a "Commit
  suggestion" / "Add suggestion to batch" button for this. TS-09 in `research/09-feature-requirements.md`
  called this out as P1 for M2–M3; it was never built.
- `ReviewComment` (`types.ts:194-199`) has only `path`, `line`, `side`, `body` — **no `start_line` /
  `start_side`**, so even a hand-written suggestion fence could only ever cover a single line.
- `composeSummaryComment` (`summary.ts:81-152`) reports `findingsPublished` as a **bare count**
  (`"Found ${n} new issue(s) this run."`). The actual new findings list is never passed in — only
  `summaryFindings` (unanchored) and `stillOpen` (carry-forward) get itemized bullets. There is no table,
  no severity grouping, and no ordering guarantee for the new findings a reviewer will actually see inline.
- Nothing in the pipeline computes or surfaces a single "how risky / how much effort" verdict. `escalate.ts`
  already computes a risk decision (sensitive-path heuristic) for **model routing**, but that signal is
  silently consumed — it never reaches the summary comment a human reads.
- There is no labeling code anywhere in `packages/engine` or `packages/worker` (confirmed by grep) — no
  `.aireview.toml` key, no API call to `POST /issues/{n}/labels`.
- `severityLine` in `summary.ts:77-78` renders `` `file`:line `` as plain text, never a link — no permalink
  to the blob at the head SHA, so "evidence" a human can jump to straight from the summary doesn't exist.
- The only conversational surface is the `/ask` **top-level slash command** on the PR's issue-comment
  thread (`packages/worker/src/route.ts` + `handlers.ts:150-179`). It is explicitly "minimal": one model
  call over the whole (possibly truncated) diff, one flat markdown reply, **no thread/turn memory**. There
  is no handling of the `pull_request_review_comment` webhook at all — if a human replies *inside* one of
  the bot's own inline finding threads ("why is this a bug?"), the bot never sees it, because `route.ts`'s
  `mapWebhook` only switches on `pull_request` and `issue_comment` event names.
- `guardrail.ts`'s `extractArray` (line 79-90) **already tolerates an object-wrapped response**
  (`{findings: [...]}`, or synonyms `issues`/`results`/`comments`) — this matters for candidate 8 below: a
  walkthrough/effort field can piggyback on the existing reviewer call with a genuinely small blast radius,
  because the guardrail was already built to look past a bare array.

---

## Candidates

### 1. Validated, single-line committable `suggestion` blocks
**Gap vs market:** every table-stakes competitor (CodeRabbit, PR-Agent/Qodo, Sourcery, Greptile, Copilot,
BugBot) ships one-click committable fixes; Loupe emits the same information as inert prose. This was
already flagged as TS-09 and never built.

**How it works on GitHub:** a review comment body containing a fenced block whose info-string is exactly
`suggestion` — ```` ```suggestion\n<replacement lines>\n``` ```` — renders "Add suggestion to batch" /
"Commit suggestion" UI when the comment is anchored to a valid diff line. This has been GA since 2020 and
is unchanged in 2026.

**The precision trap (why this is not just a formatting change):** a suggestion block that doesn't apply
cleanly is *worse* than prose — it's a visibly broken "Commit suggestion" button, which reads as the bot
being incompetent (a Bitbucket/GitHub community thread on this exact failure mode: users report they
"cannot suggest changes to files the original person had not touched" and get confused about what the
buttons even do). Two concrete correctness hazards a real implementation must handle:
1. **Backtick-fence collision** — if the suggested replacement text itself contains a line of three
   backticks (e.g., the diff touches markdown or a template literal containing a code fence), the
   ` ```suggestion ` fence must escalate to four-or-more backticks or the block truncates early/corrupts.
   Documented GitHub community discussion on exactly this collision.
2. **Exact line/whitespace match** — a suggestion can only be posted on a comment anchored to a *real*
   commentable line (already enforced by `anchorFinding`/`clampFinding`); the safest, immediately-buildable
   version is **single full-line replacement only** — reject (fall back to prose) whenever the "fix" isn't
   a clean same-line swap, e.g. anything requiring inserting/removing lines.

**Buildable approach:** add a distinct schema field (e.g. `finding.suggestedLine: string`, kept separate
from the existing free-text `suggestion` prose) that the reviewer is instructed to emit *only* when the
fix is a literal same-line text replacement; in `publish.ts`, when present and the finding's `line` is a
`"line"`-placement (exact, not nearest/clamped) commentable anchor, render a `` ```suggestion `` fence
(escalating fence length per point 1) instead of/alongside the prose suggestion; otherwise behave exactly
as today. Zero new dependencies, all deterministic code in `publish.ts` + a guardrail field + a prompt
version bump.

**Effort:** M. **In scope:** yes — no autofix, no commit is ever pushed by the bot itself (GitHub, not
Loupe, applies the suggestion on the human's click), so it doesn't touch the "no autofix / writing commits"
non-goal.

### 2. Multi-line suggestion ranges (`start_line`/`start_side`)
**What it adds over #1:** GitHub's suggestion comments also accept `start_line` + `start_side` alongside
`line`/`side` for a contiguous range, letting a fix replace a whole small block (e.g., a 3-line broken
conditional) instead of only ever a single line. `ReviewComment` in `types.ts` has no such fields today.

**Buildable approach:** extend `ReviewComment` with optional `startLine`, validate both ends are
commentable *exact* (non-clamped) lines in the same file before ever emitting a range suggestion, and fall
back to prose the moment either end is uncertain. This is meaningfully riskier than #1 (more ways for the
range to be subtly wrong), so keep it as a follow-on rather than bundling into the first cut.

**Effort:** S (once #1's plumbing exists). **In scope:** yes, same reasoning as #1.

### 3. Grouped, severity-sorted findings table in the summary comment
**Gap:** `composeSummaryComment` only ever prints a bare count for new findings (`summary.ts:95`); the
actual list, sorted or grouped, never appears anywhere in one place. On a PR with 15 inline comments across
6 files, a human has to click through the Files Changed tab to even know what severities exist. This is
exactly the "grouping/prioritizing findings" gap named in the research brief, and it is a real actionability
lever, not pure polish: an unread/unscanned finding buried in file order is functionally a missed finding
for the human, regardless of what the model "found."

**Market precedent:** Greptile explicitly organizes output as file-by-file breakdown + top-level summary
with severity badges per comment; CodeRabbit groups its walkthrough/summary "by type." Neither approach
requires new LLM calls — it's a deterministic sort/group over findings the pipeline already has.

**Buildable approach:** thread the actual (post-suppression, post-dedupe, post-anchoring) list of newly
published findings into `SummaryCommentParts` (currently only a count is passed from `run.ts`); render a
table — severity icon, `` `file`:line ``, one-line title, category — sorted critical→nit, grouped by
severity with a `<details>`/`<summary>` collapsible block per band once the list crosses a size threshold
(keeps the comment scannable on large PRs without losing anything, consistent with the "never silent"
invariant already in place elsewhere in this codebase).

**Effort:** M (mechanical, but touches the `run.ts` → `summary.ts` data flow, needs a size-based collapse
threshold, and needs tests updated). **In scope:** yes.

### 4. At-a-glance risk verdict + review-effort line
**Gap:** nothing today gives a human a single line to decide "do I need to look at this carefully right
now." `escalate.ts`'s sensitive-path heuristic already exists and is *thrown away* after routing the model
call — it never reaches the summary.

**Market precedent:** Greptile publishes a 0–5 confidence score mapped to an explicit merge
recommendation ladder (5 = "Production ready — Merge," 3 = "Implementation issues — Address feedback
first," 0–1 = "Critical problems — Major rethink needed"); PR-Agent/Qodo publishes a 1–5 "review effort"
estimate as a label on the PR. Both are cheap, deterministic-or-single-call, human-facing verdicts — not
new review passes.

**Buildable approach (kept deterministic, zero extra LLM calls, so it can't regress precision):** compute
a risk line from signals the pipeline already has — `shouldEscalate`'s sensitive-path flag, the
critical/high finding counts after verification, and file/line-count from the diff stats — into one line
in the summary, e.g. `Risk: 🔴 high (touches payment code, 2 critical findings) · Est. review effort: 4/5`.
An LLM-emitted effort field (piggybacked on the reviewer's existing JSON object, see candidate 8's note on
`extractArray` already tolerating an object wrapper) is a plausible v2 refinement but not required for v1 —
ship the deterministic version first since it can't hallucinate.

**Effort:** S. **In scope:** yes.

### 5. Auto-label the PR by risk/size
**Gap:** no labeling code exists anywhere (confirmed by grep across `packages/`). Every commercial tool in
this space treats "make risk visible outside the PR conversation" (triage lists, label filters, saved
searches) as a baseline expectation.

**Buildable approach:** one new deterministic call, `POST /repos/{owner}/{repo}/issues/{n}/labels`, driven
by the exact same signals as candidate 4 (`risk:high`/`risk:low`, optionally `size:S|M|L` from diff stats).
Add an `.aireview.toml` toggle (`labels = true/false`, default off until proven non-annoying, consistent
with this project's existing "verify defaults off until eval-proven" pattern for the verifier pass) since
some teams have their own label taxonomy and won't want a bot creating/applying labels unasked.

**Caveat to record honestly:** requires `issues: write` permission on the Action's `GITHUB_TOKEN` (or the
equivalent App installation permission) — one more scope than the comment-only permissions the project has
needed so far. Not a blocker, just a workflow-YAML/App-manifest line to add.

**Effort:** S. **In scope:** yes — this is metadata on the PR object, not code, not a merge action, not
autofix.

### 6. Evidence permalinks (clickable blob links) in summary bullets
**Gap:** `severityLine` (`summary.ts:77-78`) renders `` `file`:line `` as inert text in every bulleted
section of the summary (`summaryFindings`, `stillOpen`, verifier-dropped). A human reading the summary
comment cannot jump to the code from there — has to go find the file manually.

**Buildable approach:** `composeSummaryComment` already has (or can trivially be given) the PR identity and
head SHA it needs (the state marker already carries `headSha`); turn each bullet's `` `file`:line `` into a
markdown link to `https://github.com/{owner}/{repo}/blob/{sha}/{file}#L{line}`. Pure function change, no
new dependency, no new API call (GitHub blob URLs are static, no fetch required to construct them).

**Effort:** S. **In scope:** yes. This is squarely a trust/UX win (priority 4 of 4 in the stated ranking) —
flagging it honestly as polish-adjacent, but it's cheap enough (a few lines) that the cost/benefit is still
favorable, and clickable evidence is table stakes for "actionability" as the brief frames it.

### 7. In-thread conversational replies on inline finding comments
**Gap:** the only conversational surface today is the top-level `/ask` issue-comment command
(`handlers.ts:150-179`), and `mapWebhook` in `route.ts` never even looks at the
`pull_request_review_comment` event. If a human clicks "Reply" directly under one of the bot's own inline
findings — the single most natural way a reviewer engages with a specific comment — Loupe never sees it,
never answers, and the thread just sits there unresolved. This is a materially different (and more
commonly used) interaction than a top-level slash command, and it is the literal "conversational follow-up
threads answering replies" gap named in the brief.

**Mechanics confirmed:** GitHub supports `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies`
to post a threaded reply to a specific review comment (keeps the reply inside the existing thread, distinct
from a disconnected new top-level comment). At least one existing OSS PR-reviewer (`tmokmss/bedrock-pr-reviewer`,
a descendant of the original `coderabbitai/ai-pr-reviewer` lineage) documents exactly this pattern — "reply
to a review comment made by this action and get a response based on the diff context" — confirming it's a
proven, not speculative, mechanic. (Notably, GitHub's own MCP server is *still* missing first-class
`in_reply_to` support as of mid-2026 per open feature requests — so this remains a genuine differentiator,
not something "everyone already has.")

**Buildable approach:** add a `pull_request_review_comment` case to `mapWebhook` (only for `action ===
"created"` where the comment is a reply — has `in_reply_to_id` — and the root of that thread is one of
the bot's own comments, matched via `botIdentity`); ground the answer in that specific finding's
`diff_hunk`/file context (cheap — reuse the existing enclosing-scope context machinery already built for
the reviewer, not the whole-PR diff `/ask` uses today) and post via the replies endpoint so it lands inside
the thread, never as a disconnected new comment.

**Scope caveat to be explicit about:** this only exists on the webhook (Worker/App) delivery path, not the
Action path — the Action never receives a live `pull_request_review_comment` event, only the App/Worker
does. Per `CLAUDE.md`, the Worker/App is "built, deferred" — so this candidate is real and buildable *once*
the App path is actually running, not before.

**Effort:** M. **In scope:** yes — still just answering questions grounded in the diff/context the engine
already gathers; no autofix, no write access beyond posting a comment.

### 8. LLM-emitted PR walkthrough narrative (piggybacked on the existing reviewer call)
**Gap:** the summary comment is purely a findings report ("Found N issue(s)..."); there's no "what changed
and why" narrative a reviewer can read in 15 seconds to orient before diving into individual comments —
the single most universally-copied competitor feature (CodeRabbit's walkthrough, PR-Agent's `/describe`,
Greptile's "top-level PR summary providing the big picture").

**Honest quality framing (as the brief asked):** this candidate serves dimension 4 (trust/UX) almost
exclusively — it does not catch more bugs (recall) or reduce false positives (precision), and a wrong or
vague walkthrough carries near-zero risk since it's descriptive, not a claim of a defect. Rank it below
candidates 1, 3, and 4 for that reason; ship it only once those land.

**Buildable approach (low blast-radius specifically because of how the guardrail already works):**
`guardrail.ts`'s `extractArray` (line 79-90) *already* digs a `findings` array out of a wrapping object
and ignores unknown sibling keys. That means the reviewer prompt can be changed to emit
`{"findings": [...], "walkthrough": "...", "effort": 3}` and **old-shape bare-array responses keep working
unchanged** — the walkthrough/effort fields are additively read from the same parsed object when present,
never required. Missing/unparseable walkthrough must fail open exactly like every other guardrail path in
this codebase (findings still post; the walkthrough section is simply omitted from the summary, with no
error surfaced to the user) — never let a walkthrough failure suppress real findings.

**Explicitly not re-proposing:** sequence/flow diagrams (CodeRabbit's differentiator) — already recorded
in `research/09-feature-requirements.md` as LT-05, "pure polish," a decision already made, not a new gap.

**Effort:** M (prompt version bump, guardrail field, `run.ts`/`summary.ts` plumbing, degraded-mode test
coverage). **In scope:** yes, with the priority caveat above.

### 9. Deterministic severity-first ordering of posted comments
**Gap:** `buildReviewPayload` (`publish.ts:37-47`) posts `comments` in whatever order `anchorFindings`
happened to produce them — no ordering guarantee. Combined with candidate 3's summary table, a reviewer
benefits from the *inline* comments themselves also surfacing severity-first inside each file (GitHub
already groups by file in the Files Changed tab; this only controls order *within* a file/across the
batched review body).

**Buildable approach:** sort the `comments` array by severity (critical→nit) before building the payload —
a one-line `.sort()` using the existing `SEVERITY_RANK`/`atLeastSeverity` machinery already in `types.ts`.
Essentially free to add alongside candidate 3.

**Effort:** S. **In scope:** yes.

---

## Explicitly out of scope (named so it's a decision, not an omission)
- **Autofix / auto-committing a suggestion** — the suggestion-block candidates (1, 2) stop at *rendering*
  a suggestion GitHub can apply on a human's click; Loupe never calls the merge/commit API itself. Anything
  further (an autonomous fixer agent, à la Cursor BugBot Autofix or Ellipsis's comment-triggered fixer)
  violates the stated "no autofix / writing commits" non-goal.
- **Multi-agent adversarial debate for the walkthrough or risk verdict** — candidates 4 and 8 are
  deliberately kept to zero-or-one LLM calls (deterministic heuristics, or a sibling field on the existing
  reviewer call); a separate "explainer" agent pass would violate the "no multi-model adversarial debate"
  non-goal and the zero-dep/cost-cap ethos.
- **A dashboard for risk trends across repos** — candidate 4's risk verdict is per-PR, in the summary
  comment only; anything cross-PR/cross-repo is explicitly the dashboard/SaaS non-goal.

---

## Sources

- [GitHub Changelog — Multi-line code suggestions general availability](https://github.blog/changelog/2020-04-15-multi-line-code-suggestions-general-availability/)
- [GitHub Changelog — Multi-line code suggestions beta](https://github.blog/changelog/2020-02-26-multi-line-code-suggestions-beta/)
- [GitHub community discussion #76840 — suggestion closing-marker/backtick collision with markdown code fences](https://github.com/orgs/community/discussions/76840)
- [GitHub community discussion #137816 — confusion over "Commit suggestion" vs "Add suggestion to batch"](https://github.com/orgs/community/discussions/137816)
- [Graphite guide — how to suggest changes in a GitHub PR](https://graphite.com/guides/suggest-changes-github-pr)
- [CodeRabbit docs — PR summaries/walkthrough structure](https://docs.coderabbit.ai/pr-reviews/summaries)
- [CodeRabbit blog — Introducing the Overview page](https://www.coderabbit.ai/blog/introducing-overview)
- [CodeRabbit blog — Explainable PRs and smarter reviewer routing](https://www.coderabbit.ai/blog/explainable-prs-and-smarter-reviewer-routing)
- [CodeRabbit blog — Change Stack / Atlas review interface](https://www.coderabbit.ai/blog/introducing-atlas-the-first-ai-native-code-review-interface)
- [Greptile docs — Anatomy of a review (severity badges, 0–5 confidence score, merge ladder)](https://www.greptile.com/docs/code-review/first-pr-review)
- [PR-Agent (qodo-ai) — review tool docs, review-effort estimate](https://github.com/qodo-ai/pr-agent/blob/main/docs/docs/tools/review.md)
- [PR-Agent — pr_reviewer.py source](https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/tools/pr_reviewer.py)
- [tmokmss/bedrock-pr-reviewer — AI PR summarizer/reviewer with chat capabilities (in-thread reply pattern)](https://github.com/tmokmss/bedrock-pr-reviewer)
- [github/github-mcp-server issue #2240 — feature request for `in_reply_to` support replying to review-comment threads](https://github.com/github/github-mcp-server/issues/2240)
- [github/github-mcp-server issue #1322 — reply to individual PR review comments](https://github.com/github/github-mcp-server/issues/1322)
- [MergeGuard — best AI PR review tools 2026 (risk score framing)](https://www.mergeguard.ai/best-ai-pr-review-tools)
- Internal: `research/04-commercial-products-landscape.md` (table-stakes/differentiator matrix, already in
  this repo) and `research/09-feature-requirements.md` (TS-09, TS-12, LT-05 — prior decisions this file
  builds on rather than duplicates)
