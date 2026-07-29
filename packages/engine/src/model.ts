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
