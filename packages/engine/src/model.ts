/**
 * Thin model-provider layer (design decision 4). One unified scheme covers
 * three API PROTOCOLS — "openai" (any OpenAI-compatible /chat/completions
 * endpoint: OpenAI, OpenRouter, DeepSeek, Together, Groq, local/Ollama, …),
 * "anthropic" (any Anthropic-compatible /v1/messages endpoint), and "gemini"
 * (Google AI Studio) — plus a MockProvider for tests/dev. Providers use plain
 * `fetch` (injectable) — no SDK dependencies in the engine.
 *
 * "provider" means the wire PROTOCOL, not the vendor: `openai` is any server
 * that speaks the OpenAI chat-completions shape, wherever it is hosted.
 */
import type { FetchLike } from "./diff";

export interface ModelRequest {
  system: string;
  user: string;
  /**
   * Optional per-call sampling temperature. When set it overrides the
   * provider's own default — used by self-consistency voting (report item #15)
   * to draw independent samples at temperature > 0. Omitted → provider default.
   */
  temperature?: number;
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

/** Strip a single trailing slash so `${base}/path` never doubles up. */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiOptions {
  /** Defaults to env GEMINI_API_KEY, read at call time. */
  apiKey?: string;
  model?: string;
  /** Endpoint override; defaults to Google AI Studio. */
  baseUrl?: string;
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
    const base = stripTrailingSlash(this.opts.baseUrl ?? GEMINI_BASE);

    const res = await fetchImpl(`${base}/${this.name}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: { temperature: req.temperature ?? 0.2, responseMimeType: "application/json" },
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
  /** Endpoint host; defaults to the Anthropic API. `/v1/messages` is appended. */
  baseUrl?: string;
  maxTokens?: number;
  fetchImpl?: FetchLike;
}

/**
 * Anthropic Messages API provider — Claude Haiku 4.5 by default (design
 * decision 4: quality default from M2). The stable system prompt block gets
 * `cache_control: {type: "ephemeral"}` so repeat reviews hit the prompt cache.
 * `baseUrl` lets it target any Anthropic-compatible endpoint.
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
    const base = stripTrailingSlash(this.opts.baseUrl ?? "https://api.anthropic.com");

    const res = await fetchImpl(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.name,
        max_tokens: this.opts.maxTokens ?? 8192,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
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

/**
 * Known OpenAI-compatible base URLs. A base-url input may be one of these
 * preset keywords OR a full http(s):// URL (used verbatim). Add more freely —
 * any server speaking the chat-completions shape works via a full URL too.
 */
export const OPENAI_COMPATIBLE_PRESETS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com",
  together: "https://api.together.xyz/v1",
};

/**
 * Resolve a base-url input to a URL: a full http(s):// value is used verbatim
 * (trailing slash stripped); a bare keyword is looked up in the preset map;
 * an unknown keyword throws a clear error. Defaults to the OpenAI preset.
 */
export function resolveOpenAIBaseUrl(value?: string): string {
  const raw = (value ?? "openai").trim();
  if (/^https?:\/\//i.test(raw)) return stripTrailingSlash(raw);
  const preset = OPENAI_COMPATIBLE_PRESETS[raw.toLowerCase()];
  if (preset) return preset;
  throw new Error(
    `unknown base-url "${raw}" — pass a full http(s):// URL or one of: ${Object.keys(OPENAI_COMPATIBLE_PRESETS).join(", ")}`,
  );
}

export interface OpenAICompatibleOptions {
  /** Full base URL (already resolved). `/chat/completions` is appended. */
  baseUrl: string;
  model: string;
  /** Defaults to env[apiKeyEnv] (LLM_API_KEY by default), read at call time. */
  apiKey?: string;
  /** Env var to fall back to and name in the missing-key error. Default LLM_API_KEY. */
  apiKeyEnv?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Send `response_format: {type: "json_object"}`. Default ON; some
   * OpenAI-compatible servers reject the field, so it can be disabled.
   */
  responseFormat?: boolean;
  extraHeaders?: Record<string, string>;
  fetchImpl?: FetchLike;
}

/**
 * Provider for any OpenAI-compatible chat-completions endpoint. POSTs to
 * `${baseUrl}/chat/completions` with a Bearer key. baseUrl is used as given
 * (no forced `/v1`), so both `.../v1` and bare-host endpoints work.
 */
export class OpenAICompatibleProvider implements ReviewModel {
  readonly name: string;
  private readonly opts: OpenAICompatibleOptions;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.name = opts.model;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const apiKeyEnv = this.opts.apiKeyEnv ?? "LLM_API_KEY";
    const apiKey = this.opts.apiKey ?? process.env[apiKeyEnv];
    if (!apiKey) throw new Error(`${apiKeyEnv} is not set and no apiKey was provided`);
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = `${stripTrailingSlash(this.opts.baseUrl)}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.name,
      max_tokens: this.opts.maxTokens ?? 8192,
      temperature: req.temperature ?? this.opts.temperature ?? 0.2,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    };
    if (this.opts.responseFormat ?? true) {
      body.response_format = { type: "json_object" };
    }

    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...this.opts.extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`OpenAI-compatible API error: HTTP ${res.status} ${text}`);
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

export interface GroqOptions {
  /** Defaults to env GROQ_API_KEY, read at call time. */
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  fetchImpl?: FetchLike;
}

/**
 * Groq — a thin preset of OpenAICompatibleProvider (kept for back-compat).
 * Free Llama fallback; reads GROQ_API_KEY when no apiKey is provided.
 */
export class GroqProvider extends OpenAICompatibleProvider {
  constructor(opts: GroqOptions = {}) {
    super({
      baseUrl: OPENAI_COMPATIBLE_PRESETS.groq,
      model: opts.model ?? "llama-3.3-70b-versatile",
      apiKey: opts.apiKey,
      apiKeyEnv: "GROQ_API_KEY",
      maxTokens: opts.maxTokens,
      fetchImpl: opts.fetchImpl,
    });
  }
}

/** Provider choices selectable via config/env (REVIEW_MODEL). Back-compat shortcuts. */
export type ProviderChoice = "gemini" | "haiku" | "groq";

/** The free-tier mode provider (design: $0/mo must stay achievable). */
export const FREE_TIER_PROVIDER: ProviderChoice = "gemini";

/** Read REVIEW_MODEL from the environment; default is haiku (quality default). */
export function resolveProviderChoice(env: Record<string, string | undefined>): ProviderChoice {
  const raw = (env.REVIEW_MODEL ?? "haiku").toLowerCase();
  if (raw === "gemini" || raw === "haiku" || raw === "groq") return raw;
  return "haiku";
}

/** The unified provider protocol (the API wire shape, not the vendor). */
export type ProviderProtocol = "openai" | "anthropic" | "gemini";

export interface BuildProviderConfig {
  provider: ProviderProtocol;
  model?: string;
  /** Preset keyword or full URL (openai protocol); endpoint override otherwise. */
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  /** Env used for the apiKey fallback chain (default process.env). */
  env?: Record<string, string | undefined>;
}

/**
 * apiKey resolution: explicit → LLM_API_KEY → provider-specific vars, in order.
 * Returns undefined when nothing is set (the provider then reads its own env
 * var at call time, or throws a clear missing-key error).
 */
function resolveApiKey(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
  ...providerVars: string[]
): string | undefined {
  if (explicit) return explicit;
  if (env.LLM_API_KEY) return env.LLM_API_KEY;
  for (const v of providerVars) {
    if (env[v]) return env[v];
  }
  return undefined;
}

/** The buildProvider config for a back-compat REVIEW_MODEL shortcut. */
export function providerChoiceConfig(choice: ProviderChoice): BuildProviderConfig {
  switch (choice) {
    case "gemini":
      return { provider: "gemini" };
    case "haiku":
      return { provider: "anthropic", model: "claude-haiku-4-5" };
    case "groq":
      return { provider: "openai", baseUrl: "groq", model: "llama-3.3-70b-versatile" };
  }
}

/**
 * Unified provider builder. `provider` selects the wire protocol; the rest is
 * configuration. The openai protocol requires an explicit model (no silent
 * default for an arbitrary endpoint) and resolves baseUrl via the preset map.
 */
export function buildProvider(cfg: BuildProviderConfig): ReviewModel {
  const env = cfg.env ?? process.env;
  switch (cfg.provider) {
    case "gemini":
      return new GeminiFlashProvider({
        model: cfg.model,
        apiKey: resolveApiKey(cfg.apiKey, env, "GEMINI_API_KEY"),
        baseUrl: cfg.baseUrl,
        fetchImpl: cfg.fetchImpl,
      });
    case "anthropic":
      return new AnthropicProvider({
        model: cfg.model,
        apiKey: resolveApiKey(cfg.apiKey, env, "ANTHROPIC_API_KEY"),
        baseUrl: cfg.baseUrl,
        fetchImpl: cfg.fetchImpl,
      });
    case "openai": {
      if (!cfg.model) {
        throw new Error(
          'provider "openai" requires an explicit model — set the `model` input (there is no default for an arbitrary OpenAI-compatible endpoint)',
        );
      }
      return new OpenAICompatibleProvider({
        baseUrl: resolveOpenAIBaseUrl(cfg.baseUrl),
        model: cfg.model,
        apiKey: resolveApiKey(
          cfg.apiKey,
          env,
          "OPENAI_API_KEY",
          "OPENROUTER_API_KEY",
          "GROQ_API_KEY",
        ),
        fetchImpl: cfg.fetchImpl,
      });
    }
  }
}

/** Construct the provider for a back-compat shortcut, in terms of buildProvider. */
export function selectProvider(choice: ProviderChoice, fetchImpl?: FetchLike): ReviewModel {
  return buildProvider({ ...providerChoiceConfig(choice), fetchImpl });
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
