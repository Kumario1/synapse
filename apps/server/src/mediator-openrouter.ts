import { createHash } from "node:crypto";
import type {
  MediatorResolutionProse,
  MediatorResolutionProvider,
  MediatorResolutionRequest
} from "@synapse/conflict-engine";

interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export function createOpenRouterMediatorProvider(): MediatorResolutionProvider | null {
  const config = openRouterConfig();
  if (!config) {
    return null;
  }

  const cache = new Map<string, MediatorResolutionProse>();

  return {
    async proposeResolution(req: MediatorResolutionRequest): Promise<MediatorResolutionProse | null> {
      const key = mediatorResolutionCacheKey(req);
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }

      const prose = parseMediatorResolutionProse(
        await requestCompletion(config, MEDIATOR_SYSTEM_PROMPT, buildMediatorPrompt(req))
      );
      if (!prose) {
        return null;
      }

      cache.set(key, prose);
      return prose;
    }
  };
}

export function parseMediatorResolutionProse(
  content: string | undefined
): MediatorResolutionProse | null {
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

  const adaptSummary = (parsed as Record<string, unknown>).adaptSummary;
  if (typeof adaptSummary !== "string" || !adaptSummary.trim()) {
    return null;
  }

  return { adaptSummary: adaptSummary.trim() };
}

export function mediatorResolutionCacheKey(req: MediatorResolutionRequest): string {
  return createHash("sha256").update(JSON.stringify(req)).digest("hex");
}

function openRouterConfig(): OpenRouterConfig | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  return !apiKey || process.env.SYNAPSE_LLM_RESOLVE === "0"
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

async function requestCompletion(
  config: OpenRouterConfig,
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
        max_tokens: 180,
        temperature: 0.2,
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

const MEDIATOR_SYSTEM_PROMPT = [
  "You help coordinate AI coding agents working on the same repository.",
  "You are given deterministic mediator facts for one already-decided resolution proposal.",
  "Write only concise adapt guidance for the losing side.",
  "Do not choose a winner, change the verdict or status, propose a merged contract, claim code was edited, or invent files, symbols, signatures, or code.",
  "Use only the supplied symbol, signatures, summaries, sessions, and affected call-site facts.",
  "Include the target symbol, winner after-signature, and every affected call-site file path exactly as supplied.",
  "Reply with STRICT JSON only (no markdown, no prose outside the object):",
  '{"adaptSummary":"..."}'
].join(" ");

function buildMediatorPrompt(req: MediatorResolutionRequest): string {
  return JSON.stringify(req, null, 2);
}
