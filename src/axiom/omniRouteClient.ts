import { getAxiomConfig } from "./axiomConfig";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
}

export class OmniRouteError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OmniRouteError";
  }
}

export class OmniRouteClient {
  async healthCheck(): Promise<{ ok: boolean; url: string; latencyMs?: number; error?: string }> {
    const { gatewayUrl, requestTimeoutMs } = getAxiomConfig();
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(requestTimeoutMs, 5_000));
    try {
      // OpenAI-compatible gateways vary in health endpoints; models is the most useful probe.
      const response = await fetch(`${gatewayUrl}/models`, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        return { ok: false, url: gatewayUrl, latencyMs: Date.now() - started, error: `Gateway returned HTTP ${response.status}` };
      }
      return { ok: true, url: gatewayUrl, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        url: gatewayUrl,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async chat(messages: ChatMessage[], options: ChatCompletionOptions = {}): Promise<string> {
    const config = getAxiomConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    const abortFromCaller = () => controller.abort();
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      const response = await fetch(`${config.gatewayUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          model: options.model ?? config.workerModel,
          messages,
          temperature: options.temperature ?? 0.2,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 1_000);
        throw new OmniRouteError(`OmniRoute request failed (HTTP ${response.status}): ${body}`, response.status);
      }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object") throw new OmniRouteError("Gateway returned a non-object response");
      const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
      const content = choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new OmniRouteError("Gateway response did not contain choices[0].message.content");
      return content;
    } catch (error) {
      if (error instanceof OmniRouteError) throw error;
      throw new OmniRouteError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
