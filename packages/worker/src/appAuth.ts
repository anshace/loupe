/**
 * GitHub App authentication (task 5.5).
 *
 * App JWT (RS256 via WebCrypto: importKey PKCS#8 + sign) → installation
 * access token, with an in-memory per-installation cache that refreshes
 * when less than 5 minutes of validity remain. Fetch and clock are
 * injectable so tests never touch the network or real time.
 */
import type { FetchLike } from "@code-review/engine";

const GITHUB_API = "https://api.github.com";

/** JWT lifetime: GitHub caps App JWTs at 10 minutes. */
const JWT_TTL_SECONDS = 9 * 60;
/** Backdate `iat` to tolerate clock drift between us and GitHub. */
const JWT_DRIFT_SECONDS = 60;
/** Refresh a cached installation token when it has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // btoa exists in Workers and Node 18+.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromJson(value: unknown): string {
  return base64UrlFromBytes(encoder.encode(JSON.stringify(value)));
}

/** Decode a `-----BEGIN PRIVATE KEY-----` (PKCS#8) PEM to raw DER bytes. */
function pemToPkcs8Der(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) throw new Error("GITHUB_APP_PRIVATE_KEY is empty or not a PEM");
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is PKCS#1 (BEGIN RSA PRIVATE KEY); convert to PKCS#8 — see docs/github-app-setup.md",
    );
  }
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der;
}

/** Mint a short-lived RS256 App JWT for `appId` at time `nowMs`. */
export async function createAppJwt(appId: string, privateKeyPem: string, nowMs: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Der(privateKeyPem) as unknown as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const nowSec = Math.floor(nowMs / 1000);
  const header = base64UrlFromJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlFromJson({
    iat: nowSec - JWT_DRIFT_SECONDS,
    exp: nowSec + JWT_TTL_SECONDS,
    iss: appId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput)),
  );
  return `${signingInput}.${base64UrlFromBytes(signature)}`;
}

export interface AppAuthOptions {
  appId: string;
  privateKeyPem: string;
  fetchImpl?: FetchLike;
  /** Millisecond clock, injectable for tests. */
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Mints and caches installation access tokens, one per installation id.
 * Cache is in-memory only (per Worker isolate) — a cold isolate simply
 * re-mints, which is cheap and correct.
 */
export class InstallationTokenCache {
  /** In-flight promises are cached too, so concurrent deliveries share one mint. */
  private readonly cache = new Map<number, Promise<CachedToken>>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: AppAuthOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async getToken(installationId: number): Promise<string> {
    const pending = this.cache.get(installationId);
    if (pending) {
      try {
        const cached = await pending;
        if (cached.expiresAtMs - this.now() > REFRESH_MARGIN_MS) return cached.token;
      } catch {
        // a failed mint is never served from cache — fall through and retry
      }
    }
    const minted = this.mint(installationId);
    this.cache.set(installationId, minted);
    try {
      return (await minted).token;
    } catch (err) {
      this.cache.delete(installationId);
      throw err;
    }
  }

  private async mint(installationId: number): Promise<CachedToken> {
    const jwt = await createAppJwt(this.opts.appId, this.opts.privateKeyPem, this.now());
    const res = await this.fetchImpl(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "code-review-worker",
      },
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`minting installation token for ${installationId} failed: HTTP ${res.status} ${body}`);
    }
    const json = JSON.parse(await res.text()) as { token?: string; expires_at?: string };
    if (typeof json.token !== "string") {
      throw new Error("installation token response has no token field");
    }
    const expiresAtMs = json.expires_at ? Date.parse(json.expires_at) : this.now() + 60 * 60 * 1000;
    return { token: json.token, expiresAtMs };
  }
}
