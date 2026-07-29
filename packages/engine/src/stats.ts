/** M0 helpers: the static stats comment. */

/** Basic PR stats as reported by the pull_request event payload. */
export interface PrStats {
  fileCount: number;
  additions: number;
  deletions: number;
}

/** M0: build the static stats comment body. The adapter posts it. */
export function buildStatsComment(stats: PrStats): string {
  return `👋 review bot was here — ${stats.fileCount} files, +${stats.additions}/−${stats.deletions}`;
}
