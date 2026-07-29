/**
 * Webhook signature verification (task 5.3, spec: "Webhook signature
 * verification").
 *
 * HMAC-SHA256 over the RAW request body, compared against the
 * `X-Hub-Signature-256` header — verified BEFORE any JSON.parse of the
 * payload. Uses WebCrypto (`crypto.subtle`), which exists both in the
 * Cloudflare Workers runtime and in Node 18+ (so unit tests run unmodified).
 *
 * `crypto.subtle.verify("HMAC", ...)` recomputes the MAC and performs a
 * constant-time comparison internally, so no hand-rolled timing-safe
 * equality is needed.
 */

const encoder = new TextEncoder();

const SIGNATURE_PREFIX = "sha256=";
const HMAC_SHA256_BYTES = 32;

/** Strict hex → bytes; returns undefined on any malformed input. */
function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * True only when `signatureHeader` is a well-formed `sha256=<hex>` header
 * whose MAC matches `rawBody` under `secret`. Missing/malformed/forged → false.
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
): Promise<boolean> {
  if (!secret || !signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;
  const claimed = hexToBytes(signatureHeader.slice(SIGNATURE_PREFIX.length));
  if (!claimed || claimed.length !== HMAC_SHA256_BYTES) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, claimed as unknown as ArrayBuffer, encoder.encode(rawBody));
}

/** Compute the `sha256=<hex>` header value for a body (dev tooling + tests). */
export async function signWebhookBody(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));
  let hex = "";
  for (const byte of mac) hex += byte.toString(16).padStart(2, "0");
  return SIGNATURE_PREFIX + hex;
}
