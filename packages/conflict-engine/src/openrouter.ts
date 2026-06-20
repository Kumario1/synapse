/**
 * Shared OpenRouter transport for the optional LLM adapters (analysis,
 * resolution, mediator prose, session summary). OpenRouter is an
 * OpenAI-compatible gateway, so this talks plain `fetch` — no SDK, no lock-in.
 *
 * Each adapter keeps its own prompts and response parsing; only the config,
 * the request, and the strict-JSON object extraction live here. Everything is
 * deliberately defensive: a missing key, bad response, timeout, or parse
 * failure yields `null`/`undefined` so an adapter can always fall back to its
 * deterministic path and never break a `synapse_check`.
 *
 * Configuration (all via environment — the single place to set the key):
 *   OPENROUTER_API_KEY      required; enables the layer
 *   SYNAPSE_LLM_MODEL       OpenRouter model slug (default anthropic/claude-haiku-4.5)
 *   OPENROUTER_BASE_URL     default https://openrouter.ai/api/v1
 *   SYNAPSE_LLM_TIMEOUT_MS  default 8000
 *   <disableFlag>=0         per-feature kill switch even when a key is present
 */
export interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

/** Build config from the environment, or `null` when no key / disabled. */
export function openRouterConfig(disableFlag: string): OpenRouterConfig | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  return !apiKey || process.env[disableFlag] === "0"
    ? null
    : {
        apiKey,
        baseUrl: (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(
          /\/$/,
          ""
        ),
        model: process.env.SYNAPSE_LLM_MODEL ?? "anthropic/claude-haiku-4.5",
        timeoutMs: Number(process.env.SYNAPSE_LLM_TIMEOUT_MS ?? 8000)
      };
}

export interface CompletionParams {
  maxTokens: number;
  temperature: number;
}

/** POST a system+user chat completion; `undefined` on any failure or timeout. */
export async function requestCompletion(
  config: OpenRouterConfig,
  params: CompletionParams,
  system: string,
  user: string
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
        "x-title": "Synapse"
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract the outermost `{...}` object from model output, or `null`. */
export function extractJsonObject(content: string | undefined): Record<string, unknown> | null {
  if (!content) {
    return null;
  }

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  return parsed as Record<string, unknown>;
}
