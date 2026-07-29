# Security & Correctness — feature research (2026-07-30)

Scope: dedicated security/correctness capabilities Loupe does not yet have.
Excludes anything already shipped (see the "already has" list in the research
prompt / `openspec/` / `research/08-synthesis-architecture-and-milestones.md`).
Priority order per project convention: **precision > recall > actionability >
trust/UX**. Everything below is buildable inside the existing zero-dep
TypeScript engine (`packages/engine`) — no new heavy runtime, no executing PR
code, no cloud SaaS beyond calls Loupe already makes (GitHub API, LLM
providers). Calling a public read-only API such as OSV.dev or the npm/PyPI
registry from the Action/Worker is the same category of network call Loupe
already makes to GitHub and the model providers — it is not the "keep
everything local" rule from Ansh's personal Claude Code setup (that rule
governs *this assistant's* artifacts/uploads, not the product being built).

---

## 1. Deterministic secret / credential detection pre-pass

**What.** A zero-dependency regex (+ optional Shannon-entropy) scanner that
runs over the **added lines of the diff only**, before the LLM call, in the
same spirit as `noise.ts`/`suppress.ts`. It flags things that look like
credentials: AWS access keys (`AKIA[0-9A-Z]{16}`), GitHub tokens
(`ghp_`, `gho_`, `github_pat_...`), Slack tokens (`xox[baprs]-`), Stripe keys
(`sk_live_`), private-key PEM headers (`-----BEGIN ... PRIVATE KEY-----`),
generic `api_key`/`secret`/`password` = "long random string" assignments, and
JWT-looking literals. Two industry tools define the reference pattern sets to
adapt (both open source, patterns are just data — no binary to shell out to):

- **Gitleaks** — "rule-first": ships 150+ TOML regex rules for named
  credential formats, uses Shannon entropy only as a secondary signal for
  unnamed high-randomness strings.
- **TruffleHog** — adds *live verification* (calling the provider's API to
  check if a found credential is still valid) on top of regex+entropy; that
  verification step is a stretch goal, not needed for v1.

**Why it's high value for Loupe specifically.** Diff-only secret leaks are a
top real-world PR bug class and are currently **only caught if the LLM
happens to notice them** — a pure regex pass gets deterministic ~100%
precision on named formats (a `-----BEGIN RSA PRIVATE KEY-----` string is
never a false positive) and adds recall the LLM alone won't reliably provide
(LLMs are known to skim past exactly this kind of "boring" line). It also
composes with existing infra: emit these as `Finding`s with
`severity: "critical"`, `category: "security"` and skip the LLM/verifier
round-trip entirely for these (deterministic findings don't need verification
— they need a **suppression rule** instead, e.g. an allowlist for known
test-fixture secrets via `.aireview.toml` `ignore`/pattern-based rule so CI
fixtures don't spam every run).

**Effort:** M. Curating ~30–50 high-signal patterns + tests (this repo's
convention is heavy unit-testing per module) + wiring a new deterministic
`secrets.ts` pass into `run.ts` alongside `noise.ts`/`gate.ts`.

**Sources:**
- [TruffleHog vs. Gitleaks: A Detailed Comparison](https://www.jit.io/resources/appsec-tools/trufflehog-vs-gitleaks-a-detailed-comparison-of-secret-scanning-tools)
- [Gitleaks vs TruffleHog vs GitHub Secret Scanning](https://secrails.com/blog/trufflehog-vs-gitleaks-github-secret-scanning-guide)
- [trufflesecurity/trufflehog (GitHub)](https://github.com/trufflesecurity/trufflehog)

---

## 2. Dependency risk pass: CVE + license, scoped to the PR's diff

**What.** When a PR touches a lockfile (`package-lock.json`, `pnpm-lock.yaml`,
`yarn.lock`, and similarly `requirements.txt`/`poetry.lock`, `go.sum`, per
ecosystem Loupe wants to support), diff **only the added/bumped dependency
lines**, then:

- **CVE check** — batch those `{ecosystem, name, version}` triples to the
  **OSV.dev `POST /v1/querybatch`** endpoint (Google's free, no-auth-required,
  no-local-database-needed API; the local-database mode of `osv-scanner` is
  for offline use and is not needed here since Loupe already makes network
  calls). One HTTP call, JSON in/out, zero new npm dependency (`fetch` is
  already used everywhere in this engine).
- **License check** — for each *newly added* dependency (not already in the
  base ref's lockfile), fetch its declared license from the package registry
  metadata endpoint (npm registry `GET /<pkg>` returns a `license` SPDX
  string; PyPI JSON API similarly) and flag copyleft/viral licenses
  (GPL/AGPL family) against a configurable allow-list — mirroring what
  `license-checker`-style npm tools do, but without pulling that dependency
  in; it's a single registry GET.

**Why it's high value.** This is the "dependency/CVE & license checks" bullet
verbatim and it is **not** covered by anything in Loupe today — the engine
reviews *code* diffs, never *dependency* diffs. Because it's diff-scoped (only
new/bumped deps, not the whole tree) it stays cheap and avoids the "wall of
pre-existing CVEs" noise problem that makes full-tree scanners noisy in a PR
context — this directly serves the precision priority.

**Effort:** L for multi-ecosystem (lockfile parsing for 3+ formats + two
external API integrations + tests); a **npm-only MVP is M**.

**Sources:**
- [OSV-Scanner (google/osv-scanner)](https://github.com/google/osv-scanner)
- [POST /v1/querybatch — OSV](https://google.github.io/osv.dev/post-v1-querybatch/)
- [Supported Artifacts and Manifests — OSV-Scanner](https://google.github.io/osv-scanner/supported-languages-and-lockfiles/)
- [license-checker-rseidelsohn (npm)](https://www.npmjs.com/package/license-checker-rseidelsohn)
- [onebeyond/license-checker (GitHub)](https://github.com/onebeyond/license-checker)

---

## 3. New-dependency supply-chain heuristic (postinstall / provenance)

**What.** A smaller, purely-deterministic sibling of #2 that needs **no
external API**: parse the lockfile diff for dependencies that are *new in this
PR* and flag any whose lockfile entry sets `hasInstallScript: true`
(`package-lock.json` records this field explicitly), or — as a v1.1 stretch —
cross-check the package's registry publish date/download count via the same
registry call as the license check (a brand-new, near-zero-download package
suddenly appearing as a transitive dependency is the single highest-signal
indicator used in real 2026 npm supply-chain incident writeups, e.g. the
March 2026 Axios-adjacent `plain-crypto-js` postinstall payload).

**Why it's high value.** This is a distinct threat model from #2's
known-CVE lookup: it catches **novel/zero-day supply-chain payloads that have
no CVE yet**, which is exactly the gap CVE databases can't fill. It is cheap,
diff-scoped, and matches Loupe's existing "flag, never silently act" ethos —
report it as a `high`/`critical` finding on the lockfile hunk, don't block.

**Effort:** S for the lockfile-only heuristic (`hasInstallScript` field
check); +M if adding the registry-metadata provenance check.

**Sources:**
- [RIP npm Postinstall Scripts — Semgrep blog, 2026](https://semgrep.dev/blog/2026/rip-npm-postinstall-scripts-npm-v12-default-change/)
- [A Simple Defense Against npm Supply Chain Attacks](https://blog.openreplay.com/npm-supply-chain-defense/)
- [Mitigating supply chain attacks — pnpm docs](https://pnpm.io/supply-chain-security)

---

## 4. GitHub Actions / workflow supply-chain checks

**What.** A small, deterministic, regex/YAML-line pass scoped to diffs
touching `.github/workflows/*.yml`:

- Flag `uses: owner/action@<tag>` (a mutable ref) instead of a pinned
  full-length commit SHA — the standard "pin your actions" recommendation,
  and the exact vector behind several real 2023–2025 GitHub Actions supply
  chain incidents.
- Flag `pull_request_target` triggers combined with a `checkout` step that
  checks out the PR head ref (`github.event.pull_request.head.sha` or
  similar) — the classic pattern that leaks repo secrets to fork PRs.
- Flag secrets referenced in a step that also has `run:` with untrusted
  interpolation (`${{ github.event.issue.title }}` etc. directly in a shell
  `run:` block — a known script-injection vector into Action runners).

**Why it's high value for Loupe specifically.** Loupe *is* delivered as a
GitHub Action and will itself review PRs that touch CI config for other
repos — this is a natural, on-brand, high-signal, low-noise check that no
current bullet in the "already has" list covers, and it needs no external
data source at all (pure text pattern matching on the diff, same style as
`noise.ts`).

**Effort:** S (three regex-shaped checks + tests, no new integration).

**Sources:** (background, not consulted live this pass — well-established
public guidance: GitHub's own "Security hardening for GitHub Actions" docs
and the `pull_request_target` warning are widely documented; treat as
common-knowledge baseline for this candidate.)

---

## 5. Deterministic "dangerous sink" rule pack (SAST-lite), per language

**What.** A hand-authored, zero-dependency, regex + (where the optional
tree-sitter package is present) light-AST rule pack modeled on
`eslint-plugin-security` and Python's `bandit`, run over the diff's added
lines and injected into the reviewer prompt as **pre-flagged evidence lines**
(not as standalone findings — the LLM/verifier still judges true-positive-ness,
per the project's precision priority). Candidate rules, by language:

- **JS/TS:** `eval(`, `new Function(`, non-literal `child_process.exec`/`spawn`,
  `innerHTML`/`outerHTML`/`dangerouslySetInnerHTML` assignment from a
  non-literal, template-literal SQL/shell strings, regex literals with nested
  quantifiers (ReDoS shape, e.g. `(a+)+`).
- **Python:** `eval`/`exec`, `pickle.loads`, `yaml.load` without
  `Loader=SafeLoader`, `subprocess...shell=True` with a non-literal command,
  raw SQL string formatting/concatenation, `os.system(`.
- **Go:** `exec.Command` with a non-literal arg, `text/template` used where
  `html/template` is required, disabled TLS verification
  (`InsecureSkipVerify: true`).

This is explicitly **why not just run Semgrep/OpenGrep**: Semgrep's OSS tier
was relicensed in Dec 2024 (renamed "Community Edition", new rules
locked behind a commercial license); OpenGrep is the free LGPL-2.1 fork that
restores taint/interprocedural analysis, but **both require shelling out to
an external OCaml/Python binary** — a heavy runtime dependency the project's
"zero-dep engine" / "minimize new runtime deps" rule explicitly avoids. The
in-scope alternative is exactly this hand-rolled lightweight pack — smaller
rule coverage, but zero new runtime and full control over noise.

**Why it's high value.** This is the literal ask ("SAST/semgrep-style
deterministic rule packs feeding the LLM") and closes the single biggest gap
versus CodeRabbit's documented pattern of pairing itself with an actual
Semgrep config file for exactly this "identify unsafe patterns and missing
standard checks" purpose — Loupe gets the same benefit without the extra
binary. Feeding matches into the prompt as "evidence lines to weigh" (rather
than auto-emitting findings) is deliberately conservative: recent hybrid
SAST+LLM research (see #6 below) shows the LLM-as-judge-over-flagged-lines
pattern is what drives large false-positive reductions, so this is the
correct integration point for the precision-first priority.

**Effort:** L (multi-language pattern authoring + false-positive-controlling
test suite is the single largest item in this document; could be phased
JS/TS-first as M, then Python/Go as follow-ups).

**Sources:**
- [ESLint Plugin Security (eslint-community)](https://github.com/eslint-community/eslint-plugin-security)
- [Opengrep Emerges as Open Source Alternative — Socket.dev](https://socket.dev/blog/opengrep-forks-semgrep)
- [Launching Opengrep — Aikido](https://www.aikido.dev/blog/launching-opengrep-why-we-forked-semgrep)
- [Semgrep license change — InfoQ](https://www.infoq.com/news/2025/02/semgrep-forked-opengrep)
- [CodeRabbit paired with Semgrep config](https://dev.to/rahulxsingh/7-best-coderabbit-alternatives-for-ai-code-review-in-2026-ko5)

---

## 6. Taint-flow prompting addendum (source → sink reasoning), using the existing agentic tool loop

**What.** Rather than building a real taint-analysis engine (out of scope —
needs a call graph / CPG, a heavy dependency Loupe explicitly avoids), add a
**prompting technique**: for any diff line matched by the dangerous-sink pack
(#5) or otherwise flagged as security-relevant, require the reviewer (or,
better, a small dedicated step reusing the existing capped `grep`/`read_file`
agentic tools already built for M4) to **explicitly trace and cite** the
variable's origin before it may report a "high"/"critical" security finding:
"cite the file:line where the tainted value entered (a request param, env var,
file read, etc.) and the file:line of the sink; if you cannot find a
concrete source, downgrade or drop." This directly encodes the finding from
2025–2026 hybrid-SAST research (below) that giving the model **path-sensitive
context and requiring it to justify reachability** is what separates
precise LLM security review from "pattern-matches on keyword, hallucinates
severity."

Concretely: extend `reviewer-v3.md`'s system prompt with a
"Security findings require evidence of reachability" rule, and optionally add
a `trace_source` framing to the existing `tool_calls` protocol so the model's
own grep/read budget (already capped by `AgenticCaps`) can be spent
confirming a source→sink path before emitting the finding.

**Why it's high value.** Published 2025–2026 results are unusually strong for
a prompting-level (no-new-dependency) change:
- **ZeroFalse** (context-extraction + LLM judging over SAST alerts):
  eliminated 94–98% of false positives while keeping recall high; on one
  reported case precision moved from 35.7% → 89.5% (225 → 20 flagged issues).
- **AdaTaint** (LLM-driven adaptive source/sink inference + neuro-symbolic
  filtering): −43.7% false positives, +11.2% recall vs. CodeQL/Joern
  baselines.
- Multi-query self-validation / task-aware prompting was shown to let GPT-4
  beat cryptography-focused static tools by +26.7% accuracy.

This is squarely a precision-and-recall win with **zero new runtime
dependencies** — it's a prompt/harness change reusing infra Loupe already
built (M4 agentic tools, M4 verifier).

**Effort:** M (prompt authoring + a small harness change to let the tool loop
be invoked specifically for security evidence-gathering; reuses existing
`agentic.ts`/`verify.ts` machinery, doesn't need new caps or types beyond
maybe a `category: "security"`-specific verifier instruction).

**Sources:**
- [ZeroFalse: Improving Precision in Static Analysis with LLMs](https://arxiv.org/html/2510.02534)
- [LLM-Driven Adaptive Source–Sink Identification (AdaTaint)](https://dl.acm.org/doi/10.1145/3773365.3773410)
- [LLM-Driven SAST-Genius hybrid framework](https://arxiv.org/pdf/2509.15433)
- [Sifting the Noise: LLM Agents in Vulnerability False Positive Filtering](https://arxiv.org/pdf/2601.22952)
- [CPGHunter: LLM-guided semantic modeling for taint analysis](https://link.springer.com/article/10.1007/s10664-026-10842-2)
- [Taint-Style Vulnerability Detection for Node.js via LLM Agent Reasoning](https://arxiv.org/pdf/2604.20179)

---

## 7. CWE-tagged checklist injected per language into the reviewer prompt

**What.** A small static table mapping file extension/language → a short,
curated checklist of the CWE classes most relevant to that language, appended
to the system prompt right before review for files of that language (similar
mechanism to how `{{HOUSE_RULES}}`/`{{CONTEXT}}` are already templated in).
Base it on the **2025 CWE Top 25** (CISA/MITRE, scored on prevalence × severity
across 39,080 CVEs): XSS (#1), SQL injection (#2), CSRF (#3), out-of-bounds
write/read, use-after-free (#8, mainly native/Go/Rust/C-family), path
traversal, code injection (#10), plus 2025's new entries — classic/stack/heap
buffer overflow, improper access control (CWE-284), authorization bypass via
user-controlled key (CWE-639), and unthrottled resource allocation (CWE-770,
directly relevant to the "concurrency/resource-leak" ask below). Pair each
CWE with one or two lines of language-specific "what this looks like" text
(e.g., for JS/TS: CWE-639 → "an ID/owner field taken from the request body or
URL and used directly in a DB lookup without checking it belongs to the
authenticated user").

**Why it's high value.** This is a pure recall lever: it directs the model's
limited attention toward the specific bug classes that dominate real-world
CVEs for that language, instead of relying on the model's undirected prior.
It's the single cheapest item in this document to build (no new module, no
new types — a template-string lookup table) and composes with everything
else here (the dangerous-sink pack in #5 can literally cite the same CWE ids
in its match metadata, and the verifier can be told to weight
CWE-cited findings more carefully).

**Effort:** S (a lookup table + prompt template wiring; the checklist content
itself is the only real authoring work).

**Sources:**
- [2025 CWE Top 25 Most Dangerous Software Weaknesses — CISA](https://www.cisa.gov/news-events/alerts/2025/12/11/2025-cwe-top-25-most-dangerous-software-weaknesses)
- [MITRE shares 2025's top 25 — BleepingComputer](https://www.bleepingcomputer.com/news/security/mitre-shares-2025s-top-25-most-dangerous-software-weaknesses/)
- [Top 25 Most Dangerous Software Weaknesses of 2025 — Infosecurity Magazine](https://www.infosecurity-magazine.com/news/top-25-dangerous-software/)

---

## 8. Concurrency & resource-leak checklist + light heuristic flags

**What.** Two layers, in increasing effort:

- **Prompt-checklist layer (cheap):** add a language-conditional checklist
  (same delivery mechanism as #7) enumerating the concrete patterns worth
  checking given the enclosing-scope context Loupe already extracts:
  unclosed file/DB/socket handles on early-return/error paths (the classic
  "defer must come after the error check, not before" Go bug and its
  JS/Python try/finally equivalents), promises created but never awaited nor
  attached to a rejection handler ("floating promises" — very common in
  TS), a mutex/lock acquired on one branch but not released on an early
  `return`/`throw`, and goroutines/channels that can block forever because
  nothing ever closes the channel or cancels the context.
- **Heuristic flag layer (pricier, optional follow-up):** using the
  enclosing-scope function body Loupe's `scope.ts` already fetches, a light
  structural check — "this function calls an acquire-shaped call
  (`open(`, `.Lock()`, `net.Dial`, `db.Begin()`) and the enclosing scope has
  no matching close/unlock/rollback on at least one return path" — flagged
  as a hint for the LLM to judge, not auto-reported (same conservative
  pattern as #5).

**Why it's high value.** Concurrency/resource bugs are notoriously hard for
static tools to catch with real precision (per current research: goroutine
leaks are "difficult to detect statically"; production tools like Uber's
LeakProf resort to runtime profiling, which is out of reach for a PR-time
review bot). That's exactly why a **checklist-plus-context** prompting
approach — pointing the LLM at the right shape of bug using the
enclosing-scope context it already has — is the correct, low-effort lever
here rather than trying to build real dataflow analysis.

**Effort:** M for the checklist layer alone (S engineering, more content
authoring); L if the heuristic acquire/release structural flag layer is
included.

**Sources:**
- [LeakProf: Featherlight In-Production Goroutine Leak Detection — Uber](https://www.uber.com/blog/leakprof-featherlight-in-production-goroutine-leak-detection/)
- [A Flow Extension to Coroutine Types for Deadlock Detection in Go](https://arxiv.org/pdf/2602.19686)
- [Preventing Resource Leaks in Go — JetBrains GoLand blog](https://blog.jetbrains.com/go/2025/12/09/preventing-resource-leaks-in-go-how-goland-helps-you-write-safer-code/)

---

## 9. Input-validation checklist (OWASP ASVS-derived), tied to the sink pack

**What.** A focused checklist addition (again, same lookup-table mechanism as
#7) built from **OWASP ASVS v5 Chapter on Validation/Sanitization/Encoding**:
require positive (allow-list) validation over deny-lists for any
diff-visible input handling, flag any new endpoint/handler parameter used
without a visible validation step before it reaches a sink matched by #5's
rule pack, and specifically call out the ASVS-flagged classes: untyped
request bodies used directly, regex-based validation that isn't anchored
(missing `^`/`$`), and "validated on the client only" patterns visible in
diffs that touch both a form/schema and a handler.

**Why it's high value.** This is the direct, cheap, prompt-level way to
raise recall on the input-validation ask, and it's the natural companion to
#5/#6: the sink pack tells the model *where* dangerous data flows to, this
checklist tells it *what a correct guard looks like* so it can judge whether
one is present, which is exactly the kind of "cite the guard, or lack of
one" evidence-based check the whole project's precision-first design already
expects (do-not-report list, verifier evidence requirement).

**Effort:** S (checklist content + prompt wiring; no new module).

**Sources:**
- [OWASP ASVS 5.0 — Encoding and Sanitization chapter](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x10-V1-Encoding-and-Sanitization.md)
- [Input Validation — OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [OWASP ASVS Explained — Aikido](https://www.aikido.dev/learn/compliance/compliance-frameworks/owasp-asvs)

---

## 10. Reviewer-agent prompt-injection self-defense

**What.** A different flavor of "security" — the security *of Loupe itself*,
not of the reviewed code. Anything Loupe templates verbatim into the
reviewer/verifier prompt from PR-attacker-controlled sources (diff content,
PR title/body if ever added, `HOUSE_RULES.md`/`.aireview.toml` custom
`rules` text — the latter two are repo-committed but still attacker-reachable
via the PR itself if the PR modifies them) should be scanned for classic
indirect-prompt-injection markers before templating: phrases like "ignore
previous instructions", "you are now in developer mode", fake
system/assistant role delimiters, and invisible/zero-width Unicode
characters (a documented smuggling vector). Matches get **stripped from the
templated content and surfaced as a notice** in the run's summary/notices
list ("suspicious instruction-like content in {{file}} was ignored") — same
"never silent" ethos already used for size-cap truncation and config
parse errors.

**Why it's high value.** 2025–2026 research explicitly flags PR
descriptions/diffs/config files as a live indirect-prompt-injection vector
against AI code-review agents specifically (not just IDE agents), and notes
"no production code review system has fully implemented" defenses yet —
i.e., this is a genuine, current, unaddressed gap, and it's cheap: Loupe
already has a guardrail module (`guardrail.ts`) and a notices channel
(`ReviewResult.notices`) to extend, not build from scratch. Since the custom
`[[rules]]` text in `.aireview.toml` is literally free-form text templated
into the prompt, it is the most concrete injection surface Loupe has today.

**Effort:** S (a regex/heuristic pass over templated user-controlled string
inputs, applied at the same point `renderPrompt` builds the message, plus a
notices entry).

**Sources:**
- [Prompt Injection Defense for Production AI Agents: A Complete 2026 Guide](https://www.getmaxim.ai/articles/prompt-injection-defense-for-production-ai-agents-a-complete-2026-guide/)
- ["Your AI, My Shell": Prompt Injection Attacks on Agentic AI Coding Editors](https://arxiv.org/pdf/2509.22040)
- [Are AI-assisted Development Tools Immune to Prompt Injection?](https://arxiv.org/pdf/2603.21642)

---

## 11. Explicitly out of scope: shelling out to a real SAST engine (Semgrep/OpenGrep/CodeQL)

**What was considered.** Running the actual Semgrep Community Edition or its
free OpenGrep fork (or CodeQL) as a subprocess against the PR's checked-out
files, using their mature multi-thousand-rule registries and real
taint/interprocedural analysis instead of a hand-rolled pack.

**Why it doesn't fit.** All three require installing and invoking an external
non-Node binary/runtime (OCaml+Python for Semgrep/OpenGrep, a compiled
extraction+query database for CodeQL) — this directly conflicts with the
project's "zero-dep engine" / "minimize new runtime deps" non-goal, adds a
non-trivial CI-image/toolchain burden for a solo GitHub Action, and
(for Semgrep specifically) its post-2024 relicensing locked new
community rules behind a commercial license, so the free rule set is now
smaller than it once was. The in-scope alternative is #5 (hand-rolled
lightweight sink pack) plus #6 (LLM-based taint reasoning over the flagged
lines) — deliberately smaller rule coverage, in exchange for zero added
runtime weight, matching this project's stated tradeoffs.

**Sources:**
- [Opengrep Emerges as Open Source Alternative — Socket.dev](https://socket.dev/blog/opengrep-forks-semgrep)
- [Semgrep license change — InfoQ](https://www.infoq.com/news/2025/02/semgrep-forked-opengrep)
- [Launching Opengrep — Aikido](https://www.aikido.dev/blog/launching-opengrep-why-we-forked-semgrep)

---

## Suggested build order (precision/recall-first, effort-aware)

1. **#1 Secrets pre-pass** and **#4 Actions workflow checks** (both S/M,
   deterministic, no external API, immediate recall win on a common real bug
   class).
2. **#7 CWE checklist** and **#9 input-validation checklist** (both S,
   pure prompt content, compounds with everything else).
3. **#3 Supply-chain lockfile heuristic** (S, no API) then **#2 CVE+license
   pass** (M/L, needs OSV.dev + registry calls) as the dependency-risk track.
4. **#10 prompt-injection self-defense** (S, closes a real and currently
   undefended gap in Loupe's own trust model).
5. **#5 dangerous-sink rule pack** (L, phase JS/TS first) feeding **#6
   taint-flow prompting** (M, reuses M4 agentic infra) — the biggest lift,
   but also the biggest, most directly-requested recall improvement on real
   security bugs.
6. **#8 concurrency/resource-leak checklist** (M) as a lower-priority
   rounding-out item — genuinely hard to get high recall on without runtime
   profiling, so keep expectations calibrated (checklist-level help, not a
   dataflow engine).
