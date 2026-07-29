import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "@code-review/engine";
import { InstallationTokenCache, createAppJwt } from "./appAuth";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;

const APP_ID = "123456";
const NOW_MS = Date.parse("2026-07-29T12:00:00Z");

function b64urlToJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("createAppJwt", () => {
  it("produces an RS256 JWT whose signature verifies against the public key", async () => {
    const jwt = await createAppJwt(APP_ID, PRIVATE_PEM, NOW_MS);
    const [header, payload, signature] = jwt.split(".");
    expect(b64urlToJson(header)).toEqual({ alg: "RS256", typ: "JWT" });

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(PUBLIC_PEM, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("sets iss to the App ID, backdates iat for clock drift, and expires within 10 minutes", async () => {
    const jwt = await createAppJwt(APP_ID, PRIVATE_PEM, NOW_MS);
    const claims = b64urlToJson(jwt.split(".")[1]) as { iss: string; iat: number; exp: number };
    const nowSec = NOW_MS / 1000;
    expect(claims.iss).toBe(APP_ID);
    expect(claims.iat).toBe(nowSec - 60); // drift allowance
    expect(claims.exp).toBeGreaterThan(nowSec);
    expect(claims.exp - nowSec).toBeLessThanOrEqual(10 * 60); // GitHub's hard cap
  });

  it("rejects a PKCS#1 (BEGIN RSA PRIVATE KEY) key with a pointed error", async () => {
    const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    await expect(createAppJwt(APP_ID, pkcs1, NOW_MS)).rejects.toThrow(/PKCS#8/);
  });
});

interface RecordedCall {
  url: string;
  authorization?: string;
}

function mockGitHub(expiresInSeconds: number, clock: () => number) {
  const calls: RecordedCall[] = [];
  let counter = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, authorization: init?.headers?.authorization });
    counter += 1;
    return {
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          token: `installation-token-${counter}`,
          expires_at: new Date(clock() + expiresInSeconds * 1000).toISOString(),
        }),
    };
  };
  return { calls, fetchImpl };
}

describe("InstallationTokenCache", () => {
  it("mints a token via POST /app/installations/{id}/access_tokens with a Bearer JWT", async () => {
    let now = NOW_MS;
    const { calls, fetchImpl } = mockGitHub(3600, () => now);
    const cache = new InstallationTokenCache({
      appId: APP_ID,
      privateKeyPem: PRIVATE_PEM,
      fetchImpl,
      now: () => now,
    });

    const token = await cache.getToken(777);
    expect(token).toBe("installation-token-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/app/installations/777/access_tokens");
    expect(calls[0].authorization).toMatch(/^Bearer ey/);
  });

  it("serves the cached token while more than 5 minutes remain", async () => {
    let now = NOW_MS;
    const { calls, fetchImpl } = mockGitHub(3600, () => now);
    const cache = new InstallationTokenCache({ appId: APP_ID, privateKeyPem: PRIVATE_PEM, fetchImpl, now: () => now });

    await cache.getToken(777);
    now += 30 * 60 * 1000; // 30 min later, 30 min validity left
    expect(await cache.getToken(777)).toBe("installation-token-1");
    expect(calls).toHaveLength(1);
  });

  it("refreshes when less than 5 minutes of validity remain", async () => {
    let now = NOW_MS;
    const { calls, fetchImpl } = mockGitHub(3600, () => now);
    const cache = new InstallationTokenCache({ appId: APP_ID, privateKeyPem: PRIVATE_PEM, fetchImpl, now: () => now });

    await cache.getToken(777);
    now += 56 * 60 * 1000; // 4 min of validity left
    expect(await cache.getToken(777)).toBe("installation-token-2");
    expect(calls).toHaveLength(2);
  });

  it("caches per installation id", async () => {
    let now = NOW_MS;
    const { calls, fetchImpl } = mockGitHub(3600, () => now);
    const cache = new InstallationTokenCache({ appId: APP_ID, privateKeyPem: PRIVATE_PEM, fetchImpl, now: () => now });

    const a = await cache.getToken(1);
    const b = await cache.getToken(2);
    expect(a).not.toBe(b);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/app/installations/1/access_tokens",
      "https://api.github.com/app/installations/2/access_tokens",
    ]);
  });

  it("shares a single mint across concurrent callers (webhook bursts)", async () => {
    let now = NOW_MS;
    const { calls, fetchImpl } = mockGitHub(3600, () => now);
    const cache = new InstallationTokenCache({ appId: APP_ID, privateKeyPem: PRIVATE_PEM, fetchImpl, now: () => now });

    const [a, b] = await Promise.all([cache.getToken(777), cache.getToken(777)]);
    expect(a).toBe("installation-token-1");
    expect(b).toBe("installation-token-1");
    expect(calls).toHaveLength(1);
  });

  it("throws (and does not cache) on a non-2xx minting response", async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 401, text: async () => "bad credentials" });
    const cache = new InstallationTokenCache({ appId: APP_ID, privateKeyPem: PRIVATE_PEM, fetchImpl, now: () => NOW_MS });
    await expect(cache.getToken(777)).rejects.toThrow(/HTTP 401/);
  });
});
