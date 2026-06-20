import { createHash } from "node:crypto";
import {
  extractJsonObject,
  openRouterConfig,
  requestCompletion,
  type MediatorResolutionProse,
  type MediatorResolutionProvider,
  type MediatorResolutionRequest
} from "@synapse/conflict-engine";

export function createOpenRouterMediatorProvider(): MediatorResolutionProvider | null {
  const config = openRouterConfig("SYNAPSE_LLM_RESOLVE");
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
        await requestCompletion(
          config,
          { maxTokens: 180, temperature: 0.2 },
          MEDIATOR_SYSTEM_PROMPT,
          buildMediatorPrompt(req)
        )
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
  const record = extractJsonObject(content);
  if (!record) {
    return null;
  }

  const adaptSummary = record.adaptSummary;
  if (typeof adaptSummary !== "string" || !adaptSummary.trim()) {
    return null;
  }

  return { adaptSummary: adaptSummary.trim() };
}

export function mediatorResolutionCacheKey(req: MediatorResolutionRequest): string {
  return createHash("sha256").update(JSON.stringify(req)).digest("hex");
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
