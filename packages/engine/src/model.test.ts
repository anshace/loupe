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

import {
  AnthropicProvider,
  GroqProvider,
  OpenAICompatibleProvider,
  OPENAI_COMPATIBLE_PRESETS,
  buildProvider,
  resolveOpenAIBaseUrl,
  resolveProviderChoice,
  selectProvider,
  GeminiFlashProvider as Gemini,
} from "./model";

const ANTHROPIC_RESPONSE = JSON.stringify({
  content: [{ type: "text", text: "[]" }],
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 900,
    cache_read_input_tokens: 2000,
  },
});

describe("AnthropicProvider", () => {
  it("calls the Messages API with version header and cached system block", async () => {
    const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
    const fake: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => ANTHROPIC_RESPONSE };
    };
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl: fake });

    const res = await provider.complete({ system: "sys", user: "usr" });

    expect(provider.name).toBe("claude-haiku-4-5");
    expect(res.text).toBe("[]");
    // Real total input = uncached + cache writes + cache reads.
    expect(res.inputTokens).toBe(3000);
    expect(res.outputTokens).toBe(20);

    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].init?.headers?.["x-api-key"]).toBe("k");
    expect(calls[0].init?.headers?.["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(calls[0].init?.body ?? "{}");
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    expect(body.messages).toEqual([{ role: "user", content: "usr" }]);
  });

  it("throws a descriptive error on non-ok responses", async () => {
    const fake: FetchLike = async () => ({ ok: false, status: 529, text: async () => "overloaded" });
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl: fake });
    await expect(provider.complete({ system: "s", user: "u" })).rejects.toThrow(/HTTP 529 overloaded/);
  });

  it("throws when no API key is available", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const provider = new AnthropicProvider({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }) });
      await expect(provider.complete({ system: "s", user: "u" })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe("GroqProvider", () => {
  it("calls the OpenAI-compatible chat completions endpoint", async () => {
    const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
    const fake: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: '[{"severity":"low"}]' } }],
            usage: { prompt_tokens: 321, completion_tokens: 12 },
          }),
      };
    };
    const provider = new GroqProvider({ apiKey: "gk", fetchImpl: fake });

    const res = await provider.complete({ system: "sys", user: "usr" });

    expect(provider.name).toBe("llama-3.3-70b-versatile");
    expect(res).toEqual({ text: '[{"severity":"low"}]', inputTokens: 321, outputTokens: 12 });
    expect(calls[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0].init?.headers?.authorization).toBe("Bearer gk");
    const body = JSON.parse(calls[0].init?.body ?? "{}");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
  });

  it("throws when no API key is available", async () => {
    const prev = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      const provider = new GroqProvider({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }) });
      await expect(provider.complete({ system: "s", user: "u" })).rejects.toThrow(/GROQ_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.GROQ_API_KEY = prev;
    }
  });
});

describe("provider selection", () => {
  it("defaults to haiku and honors REVIEW_MODEL", () => {
    expect(resolveProviderChoice({})).toBe("haiku");
    expect(resolveProviderChoice({ REVIEW_MODEL: "gemini" })).toBe("gemini");
    expect(resolveProviderChoice({ REVIEW_MODEL: "GROQ" })).toBe("groq");
    expect(resolveProviderChoice({ REVIEW_MODEL: "gpt-99" })).toBe("haiku");
  });

  it("constructs the matching provider (groq maps onto the OpenAI-compatible protocol)", () => {
    expect(selectProvider("haiku")).toBeInstanceOf(AnthropicProvider);
    expect(selectProvider("gemini")).toBeInstanceOf(Gemini);
    const groq = selectProvider("groq");
    expect(groq).toBeInstanceOf(OpenAICompatibleProvider);
    expect(groq.name).toBe("llama-3.3-70b-versatile");
  });
});

const OPENAI_RESPONSE = JSON.stringify({
  choices: [{ message: { content: '[{"severity":"medium"}]' } }],
  usage: { prompt_tokens: 42, completion_tokens: 7 },
});

describe("OpenAICompatibleProvider", () => {
  it("POSTs baseUrl + /chat/completions with a bearer key and parses content + usage", async () => {
    const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
    const fake: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => OPENAI_RESPONSE };
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKey: "sk-test",
      fetchImpl: fake,
    });

    const res = await provider.complete({ system: "sys", user: "usr" });

    expect(provider.name).toBe("gpt-4o-mini");
    expect(res).toEqual({ text: '[{"severity":"medium"}]', inputTokens: 42, outputTokens: 7 });
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].init?.headers?.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(calls[0].init?.body ?? "{}");
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
    // response_format is ON by default.
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("omits response_format when disabled and normalizes a trailing-slash bare-host baseUrl", async () => {
    const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
    const fake: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => OPENAI_RESPONSE };
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.deepseek.com/", // trailing slash, no /v1
      model: "deepseek-chat",
      apiKey: "k",
      responseFormat: false,
      fetchImpl: fake,
    });

    await provider.complete({ system: "s", user: "u" });

    // Trailing slash stripped; /v1 is NOT forced.
    expect(calls[0].url).toBe("https://api.deepseek.com/chat/completions");
    const body = JSON.parse(calls[0].init?.body ?? "{}");
    expect(body.response_format).toBeUndefined();
  });

  it("sends extra headers and falls back to LLM_API_KEY at call time", async () => {
    const prev = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = "env-key";
    try {
      const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
      const fake: FetchLike = async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, text: async () => OPENAI_RESPONSE };
      };
      const provider = new OpenAICompatibleProvider({
        baseUrl: "https://openrouter.ai/api/v1",
        model: "deepseek/deepseek-chat",
        extraHeaders: { "HTTP-Referer": "https://example.com" },
        fetchImpl: fake,
      });
      await provider.complete({ system: "s", user: "u" });
      expect(calls[0].init?.headers?.authorization).toBe("Bearer env-key");
      expect(calls[0].init?.headers?.["HTTP-Referer"]).toBe("https://example.com");
    } finally {
      if (prev !== undefined) process.env.LLM_API_KEY = prev;
      else delete process.env.LLM_API_KEY;
    }
  });

  it("throws naming the configured env var when no key is available", async () => {
    const prev = process.env.LLM_API_KEY;
    delete process.env.LLM_API_KEY;
    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }),
      });
      await expect(provider.complete({ system: "s", user: "u" })).rejects.toThrow(/LLM_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.LLM_API_KEY = prev;
    }
  });
});

describe("resolveOpenAIBaseUrl", () => {
  it("resolves preset keywords to URLs", () => {
    expect(resolveOpenAIBaseUrl("openai")).toBe("https://api.openai.com/v1");
    expect(resolveOpenAIBaseUrl("openrouter")).toBe("https://openrouter.ai/api/v1");
    expect(resolveOpenAIBaseUrl("groq")).toBe("https://api.groq.com/openai/v1");
    expect(resolveOpenAIBaseUrl("deepseek")).toBe("https://api.deepseek.com");
    expect(resolveOpenAIBaseUrl("together")).toBe("https://api.together.xyz/v1");
    expect(resolveOpenAIBaseUrl(undefined)).toBe(OPENAI_COMPATIBLE_PRESETS.openai);
  });

  it("uses a full http(s) URL verbatim (trailing slash stripped)", () => {
    expect(resolveOpenAIBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(resolveOpenAIBaseUrl("https://my-host.example/api/")).toBe("https://my-host.example/api");
  });

  it("throws on an unknown keyword", () => {
    expect(() => resolveOpenAIBaseUrl("not-a-preset")).toThrow(/unknown base-url/);
  });
});

describe("AnthropicProvider baseUrl override", () => {
  it("targets ${baseUrl}/v1/messages", async () => {
    const calls: string[] = [];
    const fake: FetchLike = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => ANTHROPIC_RESPONSE };
    };
    const provider = new AnthropicProvider({
      apiKey: "k",
      baseUrl: "https://anthropic.example.com/proxy/",
      fetchImpl: fake,
    });
    await provider.complete({ system: "s", user: "u" });
    expect(calls[0]).toBe("https://anthropic.example.com/proxy/v1/messages");
  });
});

describe("buildProvider", () => {
  const noKeyEnv: Record<string, string | undefined> = {};

  it("builds the gemini protocol with its default model", () => {
    const m = buildProvider({ provider: "gemini", env: { GEMINI_API_KEY: "k" } });
    expect(m).toBeInstanceOf(Gemini);
    expect(m.name).toBe("gemini-2.5-flash");
  });

  it("builds the anthropic protocol with its default model", () => {
    const m = buildProvider({ provider: "anthropic", env: { ANTHROPIC_API_KEY: "k" } });
    expect(m).toBeInstanceOf(AnthropicProvider);
    expect(m.name).toBe("claude-haiku-4-5");
  });

  it("builds the openai protocol, resolving a preset base-url", async () => {
    const calls: string[] = [];
    const fake: FetchLike = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => OPENAI_RESPONSE };
    };
    const m = buildProvider({
      provider: "openai",
      baseUrl: "openrouter",
      model: "deepseek/deepseek-chat",
      apiKey: "k",
      fetchImpl: fake,
    });
    expect(m).toBeInstanceOf(OpenAICompatibleProvider);
    await m.complete({ system: "s", user: "u" });
    expect(calls[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("throws when the openai protocol has no model", () => {
    expect(() => buildProvider({ provider: "openai", env: noKeyEnv })).toThrow(/requires an explicit model/);
  });

  it("resolves apiKey via LLM_API_KEY then provider-specific vars", async () => {
    // explicit apiKey wins
    const explicit = buildProvider({
      provider: "openai",
      model: "x",
      apiKey: "explicit",
      env: { LLM_API_KEY: "unified", OPENAI_API_KEY: "specific" },
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => OPENAI_RESPONSE }),
    });
    // LLM_API_KEY over the provider-specific var
    let seen = "";
    const capture: FetchLike = async (_url, init) => {
      seen = String(init?.headers?.authorization);
      return { ok: true, status: 200, text: async () => OPENAI_RESPONSE };
    };
    const unified = buildProvider({
      provider: "openai",
      model: "x",
      env: { LLM_API_KEY: "unified", OPENAI_API_KEY: "specific" },
      fetchImpl: capture,
    });
    await unified.complete({ system: "s", user: "u" });
    expect(seen).toBe("Bearer unified");

    // provider-specific var when LLM_API_KEY is absent
    const specific = buildProvider({
      provider: "openai",
      model: "x",
      env: { OPENROUTER_API_KEY: "or-key" },
      fetchImpl: capture,
    });
    await specific.complete({ system: "s", user: "u" });
    expect(seen).toBe("Bearer or-key");
    expect(explicit).toBeInstanceOf(OpenAICompatibleProvider);
  });
});
