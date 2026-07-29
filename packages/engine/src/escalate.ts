/**
 * Risk-based model escalation (task 6.5, design decision 4): diffs touching
 * auth / payment / billing / migration / crypto / secret paths get reviewed
 * by Sonnet instead of the default model. Pure path heuristic; overridable
 * via `EngineConfig.escalation: false`. Escalation never applies when the
 * monthly budget has already degraded the run to the free tier — a budget
 * breach outranks a risk bump.
 */

/** The escalation target, via AnthropicProvider with this model id. */
export const ESCALATION_MODEL = "claude-sonnet-5";

// `auth` must not match "author"; `migrat` covers migration/migrations/migrate;
// `crypt` covers crypto/encrypt/decrypt/scrypt; `secret` covers secrets.
const RISKY_PATH = /(auth(?!or)|payment|billing|migrat|crypt|secret)/i;

/** True when a single changed path looks security/money-critical. */
export function isRiskyPath(path: string): boolean {
  return RISKY_PATH.test(path);
}

/** True when any changed path in the diff is risky. */
export function shouldEscalate(paths: readonly string[]): boolean {
  return paths.some(isRiskyPath);
}

/**
 * The subset of changed paths that look risky. The same signal `shouldEscalate`
 * uses for model routing, exposed so the summary comment can disclose WHY a PR
 * is flagged risky (feature #9 risk verdict) instead of discarding it.
 */
export function riskyPaths(paths: readonly string[]): string[] {
  return paths.filter(isRiskyPath);
}
