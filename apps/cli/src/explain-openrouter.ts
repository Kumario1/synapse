import type {
  AnalysisProvider,
  ConflictAnalysisInput,
  ResolutionProvider,
  ResolutionRequest
} from "@synapse/conflict-engine";
import type {
  ConflictAction,
  ConflictAnalysis,
  ConflictRecommendation,
  ProposedResolution
} from "@synapse/protocol";

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

/**
 * Optional LLM *resolution* provider backed by OpenRouter. Where the analysis
 * provider produces advice, this synthesizes ONE merged contract both agents
 * adopt — used only for the narrow `contract_divergent` case.
 *
 * Determinism is required for convergence (two machines may both generate), so:
 *   - temperature is 0 (vs 0.2 for analysis),
 *   - the prompt is symmetric: sides are labelled A/B by their pre-sorted order,
 *     never "you"/"counterpart", so it is identical on both machines,
 *   - results are cached by `inputsHash`.
 *
 * Configuration mirrors the analysis provider; `SYNAPSE_LLM_RESOLVE=0`
 * force-disables it even when a key is present. Returns `null` on any failure
 * (missing key, bad response, timeout, parse failure) so the daemon falls back
 * to the deterministic resolution and never breaks a `synapse_check`.
 */
export function createOpenRouterResolutionProvider(): ResolutionProvider | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || process.env.SYNAPSE_LLM_RESOLVE === "0") {
    return null;
  }

  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = process.env.SYNAPSE_LLM_MODEL ?? "anthropic/claude-haiku-4.5";
  const timeoutMs = Number(process.env.SYNAPSE_LLM_TIMEOUT_MS ?? 8000);
  const cache = new Map<string, ProposedResolution>();

  return {
    async proposeResolution(req: ResolutionRequest): Promise<ProposedResolution | null> {
      const cached = cache.get(req.inputsHash);
      if (cached) {
        return cached;
      }

      // Retry once: a strict-JSON contract is brittle, and a single retry
      // recovers most malformed first responses without affecting the verdict.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const content = await requestCompletion(baseUrl, apiKey, model, timeoutMs, req);
        const resolution = parseResolution(content, model);
        if (resolution) {
          cache.set(req.inputsHash, resolution);
          return resolution;
        }
      }

      return null;
    }
  };
}

async function requestCompletion(
  baseUrl: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
  req: ResolutionRequest
): Promise<string | undefined> {
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
        temperature: 0,
        messages: [
          { role: "system", content: RESOLUTION_SYSTEM_PROMPT },
          { role: "user", content: buildResolutionPrompt(req) }
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

const RESOLUTION_SYSTEM_PROMPT = [
  "You reconcile two AI coding agents that have each rewritten the SAME symbol to a different, incompatible contract.",
  "You are given both sides labelled A and B (order is fixed; never assume one is the reader), the computing agent's file, and dependency-graph neighbors.",
  "Synthesize ONE merged signature that BOTH sides can adopt verbatim so their edits converge. Consider the neighbors so callers still type-check.",
  "If the two intents cannot be safely reconciled into one signature, DO NOT guess: set reconciled=false and explain why one side must yield.",
  "Reply with STRICT JSON only (no markdown, no prose outside the object) of the shape:",
  '{"reconciled": boolean, "proposedContract": string|null, "rationale": string,',
  '"recommendation": "warn"|"block", "instruction": string}',
  "proposedContract must be a complete TypeScript declaration (so it parses standalone) when reconciled=true, else null.",
  "instruction is identical for both sides ('write exactly this'). Use recommendation 'warn' when merged, 'block' when escalating."
].join(" ");

function buildResolutionPrompt(req: ResolutionRequest): string {
  const [a, b] = req.sides;
  return JSON.stringify(
    {
      symbol: req.symbol,
      sideA: a ? { before: a.before, after: a.after } : null,
      sideB: b ? { before: b.before, after: b.after } : null,
      computingAgentFile: req.fileContext ?? null,
      neighbors: req.neighbors ?? []
    },
    null,
    2
  );
}

function parseResolution(content: string | undefined, model: string): ProposedResolution | null {
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
  const reconciled = record.reconciled === true;
  const rationale = typeof record.rationale === "string" ? record.rationale.trim() : "";
  const instruction = typeof record.instruction === "string" ? record.instruction.trim() : "";
  const proposedContract =
    typeof record.proposedContract === "string" && record.proposedContract.trim()
      ? record.proposedContract.trim()
      : null;
  const recommendation =
    record.recommendation === "block" || record.recommendation === "warn"
      ? record.recommendation
      : reconciled
        ? "warn"
        : "block";

  if (!rationale || !instruction) {
    return null;
  }

  // A reconciled result with no contract is self-contradictory; reject so the
  // caller falls back to the deterministic escalate.
  if (reconciled && !proposedContract) {
    return null;
  }

  return {
    reconciled,
    proposedContract: reconciled ? proposedContract : null,
    rationale,
    recommendation,
    instruction,
    source: model
  };
}

/** One contract change a session produced, as input to summarization. */
export interface SessionSummaryDelta {
  symbol: string;
  changeKind: string;
  before: string | null;
  after: string | null;
  summary: string;
}

export interface SessionSummaryInput {
  member: string;
  task: string | null;
  deltas: SessionSummaryDelta[];
}

/**
 * Optional LLM session summarizer (Layer II). Distills a session's contract
 * deltas into 2-3 teammate-facing sentences. Like the other providers it is
 * fully optional: `null` without a key (or with `SYNAPSE_LLM_SUMMARY=0`), and a
 * timeout/bad response yields `null` so the daemon keeps its deterministic
 * summary. It never runs in the edit hot path — only on session end.
 */
export interface SummaryProvider {
  readonly model: string;
  summarizeSession(input: SessionSummaryInput): Promise<string | null>;
}

export function createOpenRouterSummaryProvider(): SummaryProvider | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || process.env.SYNAPSE_LLM_SUMMARY === "0") {
    return null;
  }

  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = process.env.SYNAPSE_LLM_MODEL ?? "anthropic/claude-haiku-4.5";
  const timeoutMs = Number(process.env.SYNAPSE_LLM_TIMEOUT_MS ?? 8000);

  return {
    model,
    async summarizeSession(input: SessionSummaryInput): Promise<string | null> {
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
            max_tokens: 220,
            temperature: 0.3,
            messages: [
              { role: "system", content: SUMMARY_SYSTEM_PROMPT },
              { role: "user", content: buildSummaryPrompt(input) }
            ]
          })
        });

        if (!response.ok) {
          return null;
        }

        const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
        const content = data.choices?.[0]?.message?.content?.trim();
        return content && content.length > 0 ? content : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

const SUMMARY_SYSTEM_PROMPT = [
  "You summarize one coding session's contract changes for teammates catching up.",
  "Write 2-3 plain sentences: what the session changed at the contract level and why it might matter to others.",
  "Be concrete about signatures that changed (before -> after). No preamble, no markdown, no bullet list — just the prose."
].join(" ");

function buildSummaryPrompt(input: SessionSummaryInput): string {
  const lines = input.deltas.map((delta) => {
    const shape = delta.before && delta.after ? `${delta.before} -> ${delta.after}` : delta.after ?? delta.before ?? "";
    return `- ${delta.symbol} (${delta.changeKind})${shape ? `: ${shape}` : ""}`;
  });

  return [
    `Member: ${input.member}`,
    `Task: ${input.task ?? "(none stated)"}`,
    `Contract changes (${input.deltas.length}):`,
    lines.length > 0 ? lines.join("\n") : "(none)"
  ].join("\n");
}
