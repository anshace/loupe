import { describe, expect, it } from "vitest";
import type { FetchLike } from "./diff";
import { GeminiFlashProvider, MockProvider } from "./model";

const GEMINI_RESPONSE = JSON.stringify({
  candidates: [{ content: { parts: [{ text: '[{"severity":"high"' }, { text: "}]" }] } }],
  usageMetadata: { promptTokenCount: 1234, candidatesTokenCount: 56 },
});

describe("GeminiFlashProvider", () => {
  it("calls the AI Studio REST endpoint and returns text plus real token counts", async () => {
    const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
    const fake: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => GEMINI_RESPONSE };
    };
    const provider = new GeminiFlashProvider({ apiKey: "test-key", fetchImpl: fake });

    const res = await provider.complete({ system: "sys", user: "usr" });

    expect(res.text).toBe('[{"severity":"high"}]');
    expect(res.inputTokens).toBe(1234);
    expect(res.outputTokens).toBe(56);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(calls[0].init?.headers?.["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(calls[0].init?.body ?? "{}");
    expect(body.systemInstruction.parts[0].text).toBe("sys");
    expect(body.contents[0].parts[0].text).toBe("usr");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("throws a descriptive error on non-ok responses", async () => {
    const fake: FetchLike = async () => ({
      ok: false,
      status: 429,
      text: async () => "quota exceeded",
    });
    const provider = new GeminiFlashProvider({ apiKey: "k", fetchImpl: fake });
    await expect(provider.complete({ system: "s", user: "u" })).rejects.toThrow(
      /HTTP 429 quota exceeded/,
    );
  });

  it("throws when no API key is available", async () => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const provider = new GeminiFlashProvider({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }) });
      await expect(provider.complete({ system: "s", user: "u" })).rejects.toThrow(/GEMINI_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
    }
  });

  it("defaults missing usage metadata to zero, never estimates", async () => {
    const fake: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "[]" }] } }] }),
    });
    const provider = new GeminiFlashProvider({ apiKey: "k", fetchImpl: fake });
    const res = await provider.complete({ system: "s", user: "u" });
    expect(res).toEqual({ text: "[]", inputTokens: 0, outputTokens: 0 });
  });
});

describe("MockProvider", () => {
  it("returns the canned text and records requests", async () => {
    const mock = new MockProvider('{"findings": []}', { inputTokens: 10, outputTokens: 2 });
    const res = await mock.complete({ system: "a", user: "b" });
    expect(res).toEqual({ text: '{"findings": []}', inputTokens: 10, outputTokens: 2 });
    expect(mock.requests).toEqual([{ system: "a", user: "b" }]);
  });
});
