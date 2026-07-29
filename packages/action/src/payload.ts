/** Pure extraction of the fields M0 needs from a pull_request event payload. */

export interface PrEventInfo {
  prNumber: number;
  headSha: string;
  fileCount: number;
  additions: number;
  deletions: number;
}

export function extractPrEventInfo(payload: unknown): PrEventInfo {
  const pr = (payload as { pull_request?: unknown } | null)?.pull_request as
    | Record<string, unknown>
    | undefined;
  if (!pr) throw new Error("event payload has no pull_request — is this a pull_request event?");

  const num = (key: string): number => {
    const v = pr[key];
    if (typeof v !== "number") throw new Error(`pull_request.${key} is missing or not a number`);
    return v;
  };
  const headSha = (pr.head as Record<string, unknown> | undefined)?.sha;
  if (typeof headSha !== "string") throw new Error("pull_request.head.sha is missing");

  return {
    prNumber: num("number"),
    headSha,
    fileCount: num("changed_files"),
    additions: num("additions"),
    deletions: num("deletions"),
  };
}
