/**
 * Thin model-provider interface (design decision 4) plus the Gemini 2.5 Flash
 * free-tier provider and a MockProvider for tests/dev. Providers use plain
 * `fetch` (injectable) — no SDK dependencies in the engine.
 */
import type { FetchLike } from "./diff";

export interface ModelRequest {
  system: string;
  user: string;
}

export interface ModelResponse {
  text: string;
  /** Real token counts from the provider response — never char estimates. */
  inputTokens: number;
  outputTokens: number;
}

export interface ReviewModel {
  name: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiOptions {
  /** Defaults to env GEMINI_API_KEY, read at call time. */
  apiKey?: string;
  model?: string;
  fetchImpl?: FetchLike;
}

/** Google AI Studio REST provider for gemini-2.5-flash (free tier). */
export class GeminiFlashProvider implements ReviewModel {
  readonly name: string;
  private readonly opts: GeminiOptions;

  constructor(opts: GeminiOptions = {}) {
    this.opts = opts;
    this.name = opts.model ?? "gemini-2.5-flash";
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const apiKey = this.opts.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set and no apiKey was provided");
    const fetchImpl = this.opts.fetchImpl ?? fetch;

    const res = await fetchImpl(`${GEMINI_BASE}/${this.name}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Gemini API error: HTTP ${res.status} ${body}`);
    }

    const json = JSON.parse(await res.text()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    return {
      text,
      inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}

export interface AnthropicOptions {
  /** Defaults to env ANTHROPIC_API_KEY, read at call time. */
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  fetchImpl?: FetchLike;
}

/**
 * Anthropic Messages API provider — Claude Haiku 4.5 by default (design
 * decision 4: quality default from M2). The stable system prompt block gets
 * `cache_control: {type: "ephemeral"}` so repeat reviews hit the prompt cache.
 */
export class AnthropicProvider implements ReviewModel {
  readonly name: string;
  private readonly opts: AnthropicOptions;

  constructor(opts: AnthropicOptions = {}) {
    this.opts = opts;
    this.name = opts.model ?? "claude-haiku-4-5";
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const apiKey = this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set and no apiKey was provided");
    const fetchImpl = this.opts.fetchImpl ?? fetch;

    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.name,
        max_tokens: this.opts.maxTokens ?? 8192,
        system: [
          { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: req.user }],
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Anthropic API error: HTTP ${res.status} ${body}`);
    }

    const json = JSON.parse(await res.text()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const usage = json.usage ?? {};
    return {
      text,
      // Total real input = uncached + cache writes + cache reads.
      inputTokens:
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
    };
  }
}

export interface GroqOptions {
  /** Defaults to env GROQ_API_KEY, read at call time. */
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  fetchImpl?: FetchLike;
}

/** Groq (OpenAI-compatible chat completions) provider — free Llama fallback. */
export class GroqProvider implements ReviewModel {
  readonly name: string;
  private readonly opts: GroqOptions;

  constructor(opts: GroqOptions = {}) {
    this.opts = opts;
    this.name = opts.model ?? "llama-3.3-70b-versatile";
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const apiKey = this.opts.apiKey ?? process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set and no apiKey was provided");
    const fetchImpl = this.opts.fetchImpl ?? fetch;

    const res = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.name,
        max_tokens: this.opts.maxTokens ?? 8192,
        temperature: 0.2,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Groq API error: HTTP ${res.status} ${body}`);
    }

    const json = JSON.parse(await res.text()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
  }
}

/** Provider choices selectable via config/env (REVIEW_MODEL). */
export type ProviderChoice = "gemini" | "haiku" | "groq";

/** The free-tier mode provider (design: $0/mo must stay achievable). */
export const FREE_TIER_PROVIDER: ProviderChoice = "gemini";

/** Read REVIEW_MODEL from the environment; default is haiku (quality default). */
export function resolveProviderChoice(env: Record<string, string | undefined>): ProviderChoice {
  const raw = (env.REVIEW_MODEL ?? "haiku").toLowerCase();
  if (raw === "gemini" || raw === "haiku" || raw === "groq") return raw;
  return "haiku";
}

/** Construct the provider for a choice. Provider swaps are config, not code. */
export function selectProvider(choice: ProviderChoice, fetchImpl?: FetchLike): ReviewModel {
  switch (choice) {
    case "gemini":
      return new GeminiFlashProvider({ fetchImpl });
    case "groq":
      return new GroqProvider({ fetchImpl });
    case "haiku":
      return new AnthropicProvider({ fetchImpl });
  }
}

/** Canned-response provider for tests and offline dev. Never touches the network. */
export class MockProvider implements ReviewModel {
  readonly name = "mock";
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly cannedText: string = "[]",
    private readonly tokens: { inputTokens: number; outputTokens: number } = {
      inputTokens: 0,
      outputTokens: 0,
    },
  ) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    return { text: this.cannedText, ...this.tokens };
  }
}
