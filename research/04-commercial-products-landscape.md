# Commercial / Popular AI PR Review Product Landscape (2026)

Research date: 2026-07-29. Pricing/feature figures are as reported in mid-2026 sources; verify against vendor pages before quoting to customers, as this market moves fast (multiple vendors changed pricing models between March–June 2026 alone).

---

## 1. CodeRabbit

**What it is**: One of the most widely adopted standalone AI code review GitHub/GitLab/Bitbucket/Azure DevOps App.

**Integration**: Installs as an App on GitHub, GitLab, Azure DevOps, and Bitbucket — the only major tool in this set claiming full support across all four platforms. Also ships a Slack agent (billed separately by agent-minutes) and a CLI.

**Review output**:
- Plain-English PR walkthrough/summary of every change
- Auto-generated **sequence diagrams** showing code flow for the change
- Inline line-by-line comments flagging bugs, security vulnerabilities, and performance issues
- **One-click fix suggestions** (commit-able diffs) on inline comments
- Integrates with existing linters/SAST tools rather than replacing them
- Analytics dashboard for review metrics across the org

**Pricing** (2026):
- **Free**: unlimited public repos; 200 private-repo reviews/month
- **Pro**: $24/dev/mo annual ($30/mo monthly)
- **Pro Plus**: $48/dev/mo annual — adds unit-test generation, custom pre-merge checks, higher limits
- **Enterprise**: custom — self-hosting, SSO/SAML, RBAC, audit logs, API access, EU data residency, SLA
- Billing quirk: only developers who *open* PRs are billed; reviewers/managers are free seats

**Differentiators**: broadest Git-platform coverage of any vendor; diagram generation; pre-merge custom checks; Slack-native agent.

Sources: [Aitoolsort CodeRabbit 2026](https://aitoolsort.com/tools/coderabbit), [Git AutoReview](https://gitautoreview.com/compare/coderabbit-alternative), [WeavAI CodeRabbit review](https://weavai.app/blog/en/2026/04/30/coderabbit-2026-review-is-ai-code-review-worth-24-mo/), [WeavAI CodeRabbit pricing/alternatives](https://weavai.app/blog/en/2026/05/12/coderabbit-2026-ai-code-review-pricing-alternatives/)

---

## 2. Qodo Merge / PR-Agent (open source) — studied in depth

This is the one vendor in the set with a genuinely open-source core, so it's the most useful for someone building their own reviewer.

### PR-Agent (OSS core, `qodo-ai/pr-agent` on GitHub)

**Architecture**: Modular Python project — `/pr_agent` (core logic), `/github_action`, `/docker`, `/scripts`. Each "tool" is designed to be a **single LLM call**, explicitly framed as "fast & affordable" (~30s per tool) rather than a long multi-step agent loop — a deliberate cost/latency tradeoff.

**Tools/commands** (invoked as PR comments or CLI args):
| Command | Function |
|---|---|
| `/describe` | Generates PR title, summary, walkthrough, and automated labels |
| `/review` | Findings, security concerns, "review effort" estimate, test-coverage assessment |
| `/improve` | Actionable code-improvement suggestions (inline, committable) |
| `/ask` | Free-text Q&A about the PR, including line-specific questions |
| `/compliance` | (Newer) runs security, ticket-requirement, duplication, and custom org-rule checks |

**Configuration**: `.pr_agent.toml` — declarative, per-repo, allows customizing review categories/behavior without code changes ("JSON-based prompting" style config).

**Platform support**: GitHub (full), GitLab, Bitbucket, Azure DevOps, Gitea (near-parity; Gitea lacks the tagging-bot feature).

**LLM providers**: model-agnostic — documented support for OpenAI GPT, Claude, DeepSeek, and others; users can self-host and bring their own API key, meaning code never has to leave their infra/vendor boundary.

**Deployment models**: GitHub Actions workflow, CLI (`pr-agent --pr_url <URL> review`), Docker (image migrated from `codiumai/pr-agent` to `pragent/pr-agent` at v0.34.2+), self-hosted webhook receiver, or GitHub App/bot for interactive comment-triggered runs.

**Diff/context handling (most relevant for a DIY builder)**:
- **"PR Compression strategy"**: adaptive, token-aware file-patch fitting so both small and large PRs fit the LLM's context window without naive truncation
- **Dynamic context fetching**: retrieves relevant repo context beyond the raw diff
- **Ticket context integration**: pulls linked issue/ticket content into the prompt
- **Self-reflection**: tools can validate/refine their own output before posting (a lightweight critique pass)
- Metadata system (local + global) feeding prompt construction

**Positioning**: explicitly "community-maintained," distinct from Qodo's commercial product, marketed on data control and no vendor lock-in. Note: there's also a community fork, `The-PR-Agent/pr-agent`, explicitly branding itself "the original open-source PR reviewer... not the Qodo free tier" — signals some community/commercial tension after Qodo's monetization moves.

### Qodo Merge (commercial layer on top of PR-Agent)

**Qodo 2.0** (Feb 2026): re-architected as **multi-agent** — separate specialized agents for bug detection, security analysis, code quality, and test coverage running concurrently, rather than one generalist pass. Reported the highest F1 score (60.1%) among 8 tools in an independent benchmark.

**Pricing**:
- **Free**: 30 reviews/org/month (tight — the most commonly cited limitation) — note some sources say up to 75; likely changed across 2026, treat as volatile
- **Teams**: $30/user/mo annual ($38/mo monthly) — unlimited reviews under a current promo (else ~20/user/mo standard), 2,500 IDE/CLI credits/user/mo (10x free tier)
- **Enterprise**: custom, cited near $45+/user/mo — multi-repo context awareness, SSO, enterprise dashboards, air-gapped deployment; aimed at 50+ dev orgs

**Differentiator vs OSS**: hosted multi-agent pipeline, org-wide dashboards, IDE/CLI credit system, enterprise compliance features layered on the same open-source tool primitives.

Sources: [qodo-ai/pr-agent](https://github.com/qodo-ai/pr-agent), [The-PR-Agent/pr-agent fork](https://github.com/The-PR-Agent/pr-agent), [DeepWiki qodo-ai/pr-agent](https://deepwiki.com/qodo-ai/pr-agent), [DEV Community Qodo Merge integration](https://dev.to/rahulxsingh/qodo-merge-github-integration-automated-pr-review-setup-4i2g), [DEV Community Qodo Merge review](https://dev.to/rahulxsingh/qodo-merge-review-is-ai-pr-review-worth-it-46j1), [Qodo pricing DEV Community](https://dev.to/rahulxsingh/qodo-ai-pricing-free-vs-teams-vs-enterprise-plans-in-2026-2mh5), [AICodeReview Qodo Merge pricing](https://aicodereview.cc/blog/qodo-merge-pricing/), [Git AutoReview Qodo pricing](https://gitautoreview.com/compare/qodo-alternative)

---

## 3. Greptile

**Positioning**: full-codebase-context reviewer, not just diff-based. Uses a "Repository-wide Semantic Graph Index + Swarm Agents" approach — indexes the entire codebase's architecture/dependencies, claims 82% bug-detection rate on its own benchmark.

**Integration**: GitHub and GitLab; API available for building custom tools on top; SOC2 Type II and HIPAA compliant.

**Review output**: automated PR reviews with fix suggestions grounded in whole-repo understanding (not just the diff), so it can catch cross-file/architectural issues diff-only tools miss.

**Pricing**: notably changed model in March 2026 — from flat $30/mo to **$1 per review after the first 50 reviews** (usage-based). Plans: Developer (free), Pro ($30/user/mo), Enterprise (custom). The pivot to per-review pricing was unusual enough to get its own trade coverage ("Greptile Now Charges Per Review. Nobody Else Does.").

**Differentiator**: whole-codebase semantic indexing vs. diff-only context — this is the single most architecturally distinct claim among the pure-play reviewers.

Sources: [Stork.AI Greptile](https://www.stork.ai/en/greptile), [Agent Wars: per-review pricing](https://www.agent-wars.com/news/2026-05-01-greptile-per-review-pricing), [Costbench Greptile pricing](https://costbench.com/software/ai-code-review/greptile/), [WeavAI Greptile review](https://weavai.app/blog/en/2026/05/12/greptile-2026-review-ai-code-review-pricing-debate/), [Developers Digest comparison](https://www.developersdigest.tech/blog/best-ai-code-review-tools-2026)

---

## 4. Ellipsis

**Background**: YC W24 startup. GitHub App only (no GitLab/Bitbucket/Azure DevOps — notable gap for multi-platform orgs).

**Review output**:
- PR summaries
- Logical bug detection, style-guide enforcement
- **Can act on comments**: e.g. tag `@ellipsis-dev fix this unit test` and it generates working, tested code to address the request — closer to an agentic fixer than a passive commenter
- Answers questions when tagged directly in a GitHub comment
- Reviews multiple commits/day (continuous review, not just review-on-open)

**Reported impact**: ~13% average merge-speed acceleration for teams using it.

**Pricing**: Free for public repos (no feature restriction); $20/dev/mo for private-repo paid seats.

**Differentiator**: comment-driven agentic fix generation is more interactive/conversational than most competitors' one-click-suggestion model.

Sources: [aichief Ellipsis](https://aichief.com/ai-code-assistant/ellipsis/), [Tenki vs Ellipsis comparison](https://www.tenki.cloud/blog/tenki-code-review-vs-ellipsis), [WeavAI Ellipsis review](https://weavai.app/blog/en/2026/05/01/ellipsis-review-2026-ai-code-review-tool-for-20-mo/)

---

## 5. Sourcery

**Positioning**: AI code review **and** security scanning, with unusually deep IDE-side presence, and famous for Python-specific refactoring depth.

**Integration**: GitHub/GitLab PR bot **plus** real-time IDE review inside VS Code, Cursor, and JetBrains — i.e., review happens pre-PR, in-editor, not only post-push.

**Review output**: PR summaries, diagrams, line-by-line feedback; real-time in-IDE suggestions with one-click fixes; continuous vulnerability scanning with remediation guidance.

**Rules engine**: 200+ built-in Python rules, custom rule support via `.sourcery.yaml`.

**Compliance**: SOC 2 certified, zero-retention option, bring-your-own-LLM.

**Pricing** (sources vary slightly): Free tier for open-source repos with pro-level review quality; Pro ~$10–12/user/mo (private repos, "most affordable entry point" claim); Team ~$24/user/mo (adds security scanning + analytics).

**Differentiator**: the only tool in this set foregrounding **in-IDE real-time review** as a first-class channel, plus deepest Python-idiom-aware refactoring of the group — most other tools are comparatively language-agnostic pattern matchers with much shallower per-language depth. Weaker coverage outside Python/JS.

Sources: [DEV Community Sourcery vs Codacy](https://dev.to/rahulxsingh/sourcery-vs-codacy-ai-code-review-tools-compared-2026-4lpj), [DEV Community Qodo vs Sourcery](https://dev.to/rahulxsingh/qodo-vs-sourcery-ai-code-review-approaches-compared-2026-a6b), [aichief Sourcery](https://aichief.com/ai-development-tools/sourcery/), [SimilarLabs best tools 2026](https://similarlabs.com/blog/best-ai-code-review-tools)

---

## 6. GitHub Copilot code review

**Positioning**: the "default"/bundled option for any org already on GitHub — not a separate purchase decision for many teams, which is its main competitive weapon.

**Integration**: native to GitHub, runs on GitHub Actions (GitHub-hosted runners). As of March 2026, Copilot's agent works in VS Code and JetBrains; can be assigned a GitHub issue and works autonomously — writes code, runs tests, opens a PR — closing the loop from issue to review to fix.

**Review output**: gathers full project context before suggesting changes; can pass review suggestions directly into the coding agent to auto-generate fix PRs (review → fix is a single pipeline, not two separate tools).

**Pricing**: Pro $10/mo; Pro+ $39/mo (all frontier models, 1,500 premium requests); Business $19/seat/mo org-level (policy controls, IP indemnity, SSO). Notable 2026 change: **from June 1, 2026, code review consumes GitHub Actions minutes** in addition to AI credits — usage from unlicensed users bills the org directly as "AI Credits," a billing model shift that drew criticism ("why you pay twice").

**Differentiator**: zero-integration-friction bundling into the platform devs already use; agentic issue→PR→review→fix loop; downside is a genuinely more complex/less predictable billing model than flat per-seat competitors.

Sources: [GitHub Copilot plans](https://github.com/features/copilot/plans), [GitHub Changelog: Actions minutes billing](https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/), [Medium: pay twice](https://medium.com/@the_atomic_architect/github-copilot-code-review-pricing-1d95f21f7b43), [NxCode Copilot guide](https://www.nxcode.io/resources/news/github-copilot-complete-guide-2026-features-pricing-agents)

---

## 7. Graphite Diamond → "Graphite Agent"

**Background/major 2026 development**: Anysphere (maker of Cursor) **acquired Graphite in December 2025**. The standalone "Diamond" reviewer brand was retired and merged with Graphite's "Chat" feature into a single **Graphite Agent** experience — one thing to know if researching under the old "Diamond" name, most current material already calls it Graphite Agent.

**Review output**: instant feedback on every PR — bugs, logic errors, style inconsistencies, security vulnerabilities; customizable rules to enforce team-specific coding patterns; comment-filtering settings (tune noise level); "codebase awareness" to improve comment relevance. Beyond commenting, Graphite Agent can **review, edit, and help merge PRs directly inside the PR interface** — a more active collaborator role than passive commenting.

**Integration**: tightly coupled to Graphite's own stacked-PR / merge-queue workflow product (Graphite is fundamentally a PR-stacking/merge tool with review bolted on, unlike the diff-only pure-play reviewers).

**Pricing**: Free (individuals); Starter $20; Team $40/user/mo — includes **unlimited AI reviews** at the Team tier. 30-day free trial, no credit card required.

**Differentiator**: only tool in this set built on top of a stacked-diff/merge-queue workflow product rather than as a bolt-on to a plain GitHub PR flow; post-Cursor-acquisition roadmap likely to converge with Cursor/BugBot tooling.

Sources: [Graphite Series B / Diamond launch](https://graphite.com/blog/series-b-diamond-launch), [daily.dev: Graphite Agent](https://app.daily.dev/posts/meet-graphite-agent-the-next-evolution-of-ai-code-review-kb7ud8dxw), [Gitar: Graphite/Diamond vs Gitar](https://cms.gitar.ai/graphite-diamond-ai-code-review/), [CodeAnt: Graphite alternatives](https://codeant.ai/blogs/best-graphite-alternative-for-code-review)

---

## 8. Cursor BugBot

**Positioning**: deliberately narrow scope — **bugs and security only**, explicitly *not* style/formatting nits. Focuses on logic errors, race conditions, SQL injection, CVE-class vulnerabilities.

**Integration**: GitHub only as of April 2026 (no GitLab/Bitbucket/Azure DevOps).

**Review output**: automatic check on every PR; **Autofix** (launched Feb 2026) — spawns an autonomous Cloud Agent in an isolated VM to test, patch, and propose a fix for detected issues, not just flag them; "learned rules" that adapt to a team's accepted/rejected feedback over time.

**Performance**: June 10 2026 update cut average review time from ~5 minutes to ~90 seconds while finding 10% more bugs at 22% lower run cost — aggressive, publicly-marketed speed/cost iteration cadence.

**Pricing**: switched from flat $40/seat/mo to **usage-based billing**; average run costs $1.00–$1.50 depending on PR size/complexity — same directional shift as Greptile (flat seat → consumption pricing), suggesting a broader 2026 industry pricing-model trend.

**Differentiator**: narrowest, most bug/security-focused scope (a feature, not a limitation, for teams who find generalist reviewers noisy); autonomous cloud-VM autofix; fastest iteration on review latency in the set.

Sources: [RockB: BugBot 2026 review](https://baeseokjae.github.io/posts/cursor-bugbot-review-2026/), [getoptimal: BugBot pricing](https://getoptimal.ai/blog/cursor-bugbot-pricing), [Cursor blog: May 2026 BugBot changes](https://cursor.com/blog/may-2026-bugbot-changes), [Digital Applied: 90-second reviews](https://www.digitalapplied.com/blog/cursor-bugbot-90-second-reviews-june-2026-release), [Git AutoReview: BugBot pricing](https://gitautoreview.com/compare/cursor-bugbot-alternative)

---

## Feature Matrix

| Product | GitHub | GitLab | Bitbucket | Azure DevOps | IDE review | Inline fix suggestions | Auto-PR summary/walkthrough | Diagrams | Codebase-wide context | Autonomous autofix agent | OSS core | Entry price |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CodeRabbit | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ (sequence) | partial | ❌ | ❌ | Free / $24/dev/mo |
| Qodo Merge (+ PR-Agent OSS) | ✅ | ✅ | ✅ | ✅ | partial (CLI/IDE credits) | ✅ | ✅ | ❌ | partial (multi-agent) | ❌ | ✅ (PR-Agent) | Free (30/org/mo) / $30/user/mo |
| Greptile | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ (full repo graph) | ❌ | ❌ | Free / $1 per review after 50 |
| Ellipsis | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ (agentic, comment-triggered) | ✅ | ❌ | partial | ✅ (comment-triggered fix) | ❌ | Free (public) / $20/dev/mo |
| Sourcery | ✅ | ✅ | ❌ | ❌ | ✅ (VS Code/Cursor/JetBrains) | ✅ | ✅ | ✅ | partial | ❌ | ❌ | Free (OSS) / ~$10-12/user/mo |
| GitHub Copilot code review | ✅ (native) | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ (full project context) | ✅ (agent issue→PR) | ❌ | $10/mo (Pro) |
| Graphite Agent (ex-Diamond) | ✅ | ❌ | ❌ | ❌ | ❌ (PR-interface focused) | ✅ (can edit/merge) | ✅ | ❌ | ✅ | partial (edits PR directly) | ❌ | Free / $20-40/user/mo |
| Cursor BugBot | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ (bugs/security only) | ❌ (not a summarizer) | ❌ | partial | ✅ (Cloud Agent Autofix) | ❌ | usage-based, ~$1-1.50/run |

(✅ = confirmed feature, ❌ = confirmed absent/not primary, "partial" = present but limited or secondary per available sources)

---

## Table-Stakes Features vs. Differentiators (for someone building their own)

### Table stakes (every serious product in 2026 has these — build these first, they are the entry price of admission)
1. **GitHub App/webhook integration** that triggers on PR open/push, no manual invocation required
2. **Auto-generated PR summary** in plain English (what changed, why, at what "effort level")
3. **Inline, line-anchored comments** on the diff (not just a top-level comment blob)
4. **One-click/committable fix suggestions**, not just prose description of the bug
5. **Configurable rules/behavior** via a repo-committed config file (`.pr_agent.toml`, `.sourcery.yaml`, etc.) — teams expect to tune noise and enforce their own standards
6. **A free tier for open-source/public repos** — near-universal go-to-market move to build trust/adoption
7. **Security-issue detection** (at minimum common CWE-class bugs) alongside style/logic review
8. **Diff-size-aware context handling** so large PRs don't silently get truncated or blow the budget (PR-Agent's "compression strategy" is the clearest documented version of this)
9. **Multi-LLM-provider flexibility or at least model choice**, increasingly expected by enterprise buyers wary of lock-in
10. **Ability to answer follow-up questions** on the PR (an `/ask`-style command) rather than one-shot commentary

### Differentiators (this is where products currently compete / where a DIY builder can carve a niche)
1. **Whole-codebase / cross-file semantic context** vs. diff-only review — Greptile's repo graph index and Copilot's "full project context" are the sharpest examples; most tools are still diff-scoped
2. **Autonomous fix agents that run in an isolated sandbox/VM** to actually test a patch before proposing it (Cursor BugBot's Autofix, Ellipsis's comment-triggered fixer) vs. static suggested-diff text
3. **Multi-platform breadth** (GitHub+GitLab+Bitbucket+Azure DevOps) — CodeRabbit and Qodo Merge lead here; most competitors are GitHub-only, a real gap for enterprise multi-platform shops
4. **In-IDE / pre-PR review** (Sourcery, Copilot in-editor) — shifting review left of the PR entirely, catching issues before a diff is even opened
5. **Deep single-language expertise** (Sourcery's 200+ Python-specific rules) vs. shallow language-agnostic pattern matching — a plausible wedge for a narrow, opinionated tool
6. **Narrow scope done well** (Cursor BugBot's bugs/security-only focus) as an antidote to "reviews everything, signal buried in noise" — positioning choice, not just a technical one
7. **Diagram/visual generation** (CodeRabbit's sequence diagrams) to aid human reviewer comprehension of complex changes
8. **Open-source core with a hosted commercial layer** (Qodo Merge/PR-Agent) — lets self-hosters/privacy-sensitive orgs adopt for free while still monetizing a hosted multi-agent tier; a strong trust-building GTM model to copy
9. **Compliance-as-a-tool** (Qodo's `/compliance` command: ticket-requirement checks, duplication detection, custom org rules) — moving beyond code correctness into process/governance checks
10. **Pricing model itself as differentiation** — the 2026 shift from flat per-seat to usage/consumption-based pricing (Greptile, Cursor BugBot) is itself now a competitive axis; a DIY tool could differentiate by offering predictable flat pricing while incumbents move to variable billing
11. **Multi-agent decomposition** (Qodo 2.0: separate bug/security/quality/test-coverage agents running concurrently) vs. one generalist prompt — reportedly improves benchmark F1 score, a concrete quality lever
12. **Merge-workflow integration** (Graphite's stacked-diff/merge-queue-native review) — review as part of a broader PR-workflow product rather than a bolt-on point solution

---

## Notable 2026 market dynamics worth tracking
- **Pricing-model churn**: multiple vendors (Greptile, Cursor BugBot) moved from flat per-seat to usage-based billing in H1 2026; GitHub Copilot added Actions-minutes billing on top of AI credits. Consumption pricing is becoming the norm, not the exception, for compute-heavy AI review.
- **Consolidation**: Anysphere (Cursor) acquired Graphite (Dec 2025), folding "Diamond" into "Graphite Agent" — signals platform-level bundling (editor + review + merge workflow) rather than point-solution proliferation.
- **Benchmarks are emerging** (e.g., the 8-tool F1-score benchmark citing Qodo 2.0 at 60.1%) — the market is maturing enough that vendors compete on published accuracy numbers, not just feature lists.
- **OSS vs. commercial tension**: a community fork of PR-Agent (`The-PR-Agent/pr-agent`) explicitly distances itself from Qodo's monetized "free tier," suggesting friction as an OSS project's steward commercializes on top of it — a governance risk worth watching for anyone building on PR-Agent.
