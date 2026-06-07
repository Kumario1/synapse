import type {
  AnalysisProvider,
  ConflictAnalysisInput
} from "@synapse/conflict-engine";
import type { ConflictAction, ConflictAnalysis, ConflictRecommendation } from "@synapse/protocol";

/**
 * Optional LLM analysis provider backed by OpenRouter (Rung 5).
 *
 * Per the build plan, detection is deterministic; the model only reasons over
 * the *code diffs from both sides* to produce actionable steps. OpenRouter is
 * an OpenAI-compatible gateway, so this talks plain `fetch` — no SDK dependency
 * and no lock-in to one model.
 *
 * Configuration (all via environment — the single place to set the key):
 *   OPENROUTER_API_KEY     required; enables the layer
 *   SYNAPSE_LLM_MODEL      OpenRouter model slug (default anthropic/claude-haiku-4.5)
 *   OPENROUTER_BASE_URL    default https://openrouter.ai/api/v1
 *   SYNAPSE_LLM_TIMEOUT_MS default 8000
 *   SYNAPSE_LLM_EXPLAIN=0  force-disable even when a key is present
 *
 * It is deliberately defensive: it returns `null` (→ deterministic analysis)
 * on a missing key, a bad response, a timeout, or any parse failure, so it can
 * never break a `synapse_check`.
 */
export function createOpenRouterAnalysisProvider(): AnalysisProvider | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || process.env.SYNAPSE_LLM_EXPLAIN === "0") {
    return null;
  }

  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = process.env.SYNAPSE_LLM_MODEL ?? "anthropic/claude-haiku-4.5";
  const timeoutMs = Number(process.env.SYNAPSE_LLM_TIMEOUT_MS ?? 8000);
  const cache = new Map<string, ConflictAnalysis>();

  return {
    async analyzeConflict(input: ConflictAnalysisInput): Promise<ConflictAnalysis | null> {
      const key = cacheKey(input);
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            "x-title": "Synapse"
          },
          body: JSON.stringify({
            model,
            max_tokens: 700,
            temperature: 0.2,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: buildUserPrompt(input) }
            ]
          })
        });

        if (!response.ok) {
          return null;
        }

        const data = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = data.choices?.[0]?.message?.content;
        const analysis = parseAnalysis(content, model);
        if (!analysis) {
          return null;
        }

        cache.set(key, analysis);
        return analysis;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

const SYSTEM_PROMPT = [
  "You coordinate AI coding agents working on the same repository.",
  "You are given ONE contract conflict, with the code-level diffs from both sides:",
  "the OTHER agent's change and YOUR current contract / your own change.",
  "Analyze how the two diffs interact and decide what each side must do.",
  "Reply with STRICT JSON only (no markdown, no prose outside the object) of the shape:",
  '{"assessment": string, "recommendation": "block"|"warn"|"info"|"proceed",',
  '"actions": [{"audience": "you"|"counterpart"|"both", "step": string}]}',
  '"you" = the agent running the check; "counterpart" = the other agent.',
  "Be concrete: reference the actual signature change. Keep assessment under 60 words.",
  "Use 'block' only when the two changes are directly incompatible and one must yield."
].join(" ");

function buildUserPrompt(input: ConflictAnalysisInput): string {
  return JSON.stringify(
    {
      rule: input.rule,
      symbol: input.targetSymbol,
      otherAgent: input.counterpart,
      yourTask: input.task ?? null,
      otherAgentDiff: input.counterpartChange ?? null,
      yourCurrentContract: input.selfSignature ?? null,
      yourDiff: input.selfChange ?? null,
      deterministicBaseline: input.deterministic
    },
    null,
    2
  );
}

function parseAnalysis(content: string | undefined, model: string): ConflictAnalysis | null {
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

  const record = parsed as Record<string, unknown>;
  const assessment = typeof record.assessment === "string" ? record.assessment.trim() : "";
  const recommendation = asRecommendation(record.recommendation);
  const actions = asActions(record.actions);

  if (!assessment || !recommendation || actions.length === 0) {
    return null;
  }

  return { assessment, recommendation, actions, source: model };
}

function asRecommendation(value: unknown): ConflictRecommendation | null {
  return value === "block" || value === "warn" || value === "info" || value === "proceed" ? value : null;
}

function asActions(value: unknown): ConflictAction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const actions: ConflictAction[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const step = typeof record.step === "string" ? record.step.trim() : "";
    const audience =
      record.audience === "you" || record.audience === "counterpart" || record.audience === "both"
        ? record.audience
        : "both";

    if (step) {
      actions.push({ audience, step });
    }
  }

  return actions;
}

function cacheKey(input: ConflictAnalysisInput): string {
  return [
    input.rule,
    input.targetSymbol,
    input.counterpart,
    input.counterpartChange?.after?.raw ?? "",
    input.selfSignature?.raw ?? "",
    input.selfChange?.after?.raw ?? ""
  ].join("|");
}
