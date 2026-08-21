/**
 * Proveedor de LLM tras una interfaz mínima.
 *
 * Sin SDK de proveedor: la API de mensajes es un POST con JSON y meter un SDK
 * ata el dominio a un vendedor por comodidad. Cambiar de proveedor es escribir
 * otra clase de treinta líneas.
 */

export interface LlmMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

interface AnthropicOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-sonnet-4-5";
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1/messages";
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens ?? 300,
          temperature: request.temperature ?? 0.4,
          system: request.system,
          messages: request.messages,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`LLM devolvió ${response.status}`);
      }

      const body = (await response.json()) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
        model?: string;
      };

      const text = (body.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("")
        .trim();

      return {
        text,
        model: body.model ?? this.model,
        tokensIn: body.usage?.input_tokens ?? 0,
        tokensOut: body.usage?.output_tokens ?? 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Proveedor de test: devuelve lo que se le diga, sin red ni coste. */
export class ScriptedProvider implements LlmProvider {
  readonly name = "scripted";
  private index = 0;

  constructor(private readonly replies: readonly string[]) {}

  async complete(): Promise<LlmResponse> {
    const text = this.replies[Math.min(this.index, this.replies.length - 1)] ?? "";
    this.index += 1;
    return { text, model: "scripted", tokensIn: 0, tokensOut: 0 };
  }
}
