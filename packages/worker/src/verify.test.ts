import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhookBody, verifyWebhookSignature } from "./verify";

const SECRET = "s3cret-webhook-token";
const BODY = JSON.stringify({ action: "opened", number: 7 });

function nodeSignature(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("signWebhookBody", () => {
  it("matches node:crypto's HMAC-SHA256 for the same secret and body", async () => {
    expect(await signWebhookBody(SECRET, BODY)).toBe(nodeSignature(SECRET, BODY));
  });
});

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature over the raw body", async () => {
    const header = nodeSignature(SECRET, BODY);
    expect(await verifyWebhookSignature(SECRET, BODY, header)).toBe(true);
  });

  it("rejects a signature computed over a different (tampered) body", async () => {
    const header = nodeSignature(SECRET, BODY);
    expect(await verifyWebhookSignature(SECRET, BODY + " ", header)).toBe(false);
  });

  it("rejects a signature made with the wrong secret (forged)", async () => {
    const header = nodeSignature("attacker-guess", BODY);
    expect(await verifyWebhookSignature(SECRET, BODY, header)).toBe(false);
  });

  it("rejects a missing header", async () => {
    expect(await verifyWebhookSignature(SECRET, BODY, undefined)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, BODY, null)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, BODY, "")).toBe(false);
  });

  it("rejects a header without the sha256= prefix", async () => {
    const bareHex = nodeSignature(SECRET, BODY).slice("sha256=".length);
    expect(await verifyWebhookSignature(SECRET, BODY, bareHex)).toBe(false);
    expect(await verifyWebhookSignature(SECRET, BODY, "sha1=" + bareHex)).toBe(false);
  });

  it("rejects malformed hex and wrong-length signatures", async () => {
    expect(await verifyWebhookSignature(SECRET, BODY, "sha256=nothex!")).toBe(false);
    expect(await verifyWebhookSignature(SECRET, BODY, "sha256=abcd")).toBe(false);
    expect(await verifyWebhookSignature(SECRET, BODY, "sha256=" + "ab".repeat(31))).toBe(false);
  });

  it("rejects everything when the configured secret is empty", async () => {
    const header = nodeSignature("", BODY);
    expect(await verifyWebhookSignature("", BODY, header)).toBe(false);
  });
});
