# Dummy-PR workflow (code-review-testbed)

The testbed lives at `C:\Users\Ansh\Documents\ANSH\code-review-testbed` — a
separate git repo (own `git init`, main branch, Ansh's git identity) seeded
with small realistic TS/JS files (`src/pricing.ts`, `src/slugify.js`,
`src/retry.ts`). Its only job: generate throwaway PRs to exercise the review
bot.

## Generating a dummy PR

1. Create a branch:
   ```
   cd C:\Users\Ansh\Documents\ANSH\code-review-testbed
   git checkout main
   git checkout -b test/<short-name>
   ```
2. Introduce a change — ideally with a deliberate, subtle bug so the reviewer
   has something to find. Examples:
   - `applyDiscount`: flip to `1 + discountPercent / 100` (adds instead of discounts)
   - `truncateSlug`: use `>=` vs `>` off-by-one on the dash check
   - `withRetry`: forget the `await` on `operation()` so failures escape the try
   Clean-PR and docs-only-PR variants are useful too (M1+ needs the
   "no issues found" path).
3. Commit on the branch (normal identity, no co-author trailers).
4. Open the PR — **requires the testbed to be on GitHub first**:
   ```
   gh pr create --base main --title "..." --body "..."
   ```
   The `.github/workflows/review.yml` triggers on
   opened / synchronize / reopened / ready_for_review.
5. Push more commits to the same branch to test `synchronize` (re-review) paths.
6. Delete the branch after; the testbed accumulates no history of value.

## Not yet possible (until Ansh pushes)

Nothing has been pushed anywhere. Creating the GitHub repo and pushing
(`gh repo create anshace/code-review-testbed --private --source . --push`)
is a **manual, Ansh-only step** — Claude never pushes (shared machine rule).
Until then, dummy PRs exist only as local branches; the workflow file is in
place but dormant, with the real bot invocation commented out inside it
(the bot repo also has to be on GitHub before that step can be un-commented).
