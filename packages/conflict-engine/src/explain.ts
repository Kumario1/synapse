import { createHash } from "node:crypto";
import type {
  Conflict,
  ConflictAction,
  ConflictAnalysis,
  ConflictRecommendation,
  ContractChange,
  ContractDelta,
  ProposedResolution,
  Signature
} from "@synapse/protocol";
import { isKnownSynapseCommand } from "@synapse/protocol";
import { renderSignature } from "./compare.js";
import { extractJsonObject } from "./openrouter.js";

/**
 * Attach a command suggestion to the first action matching `audience`
 * (deterministic floor command grounding, plan 016). Leaves every other
 * action untouched; if no action matches, the list is returned as-is.
 */
function withCommand(
  actions: ConflictAction[],
  audience: ConflictAction["audience"][],
  command: NonNullable<ConflictAction["command"]>
): ConflictAction[] {
  const index = actions.findIndex((action) => audience.includes(action.audience));
  if (index === -1) {
    return actions;
  }

  return actions.map((action, i) => (i === index ? { ...action, command } : action));
}

/**
 * Input handed to an {@link AnalysisProvider}. It carries the structured facts
 * the engine derived deterministically for *both* sides of the conflict, plus
 * the deterministic analysis as a guaranteed fallback.
 */
export interface ConflictAnalysisInput {
  rule: Conflict["rule"];
  targetSymbol: string;
  counterpart: string;
  /** The checking agent's current task, when provided to `synapse_check`. */
  task?: string;
  /** The other agent's diff (before -> after). */
  counterpartChange?: ContractChange;
  /** Your current local contract for the symbol — the base you are coding against. */
  selfSignature?: Signature | null;
  /** Your own diff, if you have also edited the symbol. */
  selfChange?: ContractChange | null;
  /** The deterministic analysis; return this (or null) to keep it. */
  deterministic: ConflictAnalysis;
}

/** Extra both-sides context the daemon supplies when enriching conflicts. */
export interface AnalysisContext {
  task?: string;
  /** Your current local signature for each symbol, keyed by raw symbol id. */
  selfSignatureBySymbol?: Map<string, Signature | null>;
  /** Your own unpushed change for each symbol, keyed by raw symbol id. */
  selfChangeBySymbol?: Map<string, ContractChange | null>;
}

/**
 * Pluggable, OPTIONAL analysis layer. Detection stays fully deterministic in
 * the engine; a provider only produces a richer, actionable {@link
 * ConflictAnalysis} by reasoning over the code diffs from both sides. Providers
 * must never affect correctness — a thrown error or null keeps the
 * deterministic analysis.
 */
export interface AnalysisProvider {
  analyzeConflict(input: ConflictAnalysisInput): Promise<ConflictAnalysis | null>;
}

const recommendationByRule: Record<Conflict["rule"], ConflictAnalysis["recommendation"]> = {
  contract_divergent: "warn",
  same_symbol_unpushed: "warn",
  same_symbol_active: "warn",
  dependency_changed: "warn",
  transitive_dependency: "info",
  stale_base: "warn",
  same_file_no_overlap: "info"
};

/**
 * The recommendation scale, weakest → strongest. `ConflictRecommendation`
 * (protocol) is the source of truth for membership; this fixes the order and
 * feeds {@link asRecommendation}. The rank table below is checked exhaustive by
 * its `Record<ConflictRecommendation, …>` type, so the two cannot disagree.
 */
export const RECOMMENDATIONS = [
  "proceed",
  "info",
  "warn",
  "block"
] as const satisfies readonly ConflictRecommendation[];

const recommendationRank: Record<ConflictRecommendation, number> = {
  proceed: 0,
  info: 1,
  warn: 2,
  block: 3
};

/** Accept a model-supplied recommendation, or null if it is off the scale. */
function asRecommendation(value: unknown): ConflictRecommendation | null {
  return RECOMMENDATIONS.includes(value as ConflictRecommendation)
    ? (value as ConflictRecommendation)
    : null;
}

/**
 * Validate a model reply into a {@link ConflictAnalysis}, or null if it is
 * unusable (so the caller keeps the deterministic analysis). Canonical here in
 * the engine so every provider — the CLI today, the server or another client
 * later — validates a model's analysis identically, instead of duplicating it
 * in an app.
 */
export function parseConflictAnalysis(
  content: string | undefined,
  model: string
): ConflictAnalysis | null {
  const record = extractJsonObject(content);
  if (!record) {
    return null;
  }

  const assessment = typeof record.assessment === "string" ? record.assessment.trim() : "";
  const recommendation = asRecommendation(record.recommendation);
  const actions = asActions(record.actions);

  if (!assessment || !recommendation || actions.length === 0) {
    return null;
  }

  return { assessment, recommendation, actions, source: model };
}

export function asActions(value: unknown): ConflictAction[] {
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
      const command = asCommand(record.command);
      actions.push(command ? { audience, step, command } : { audience, step });
    }
  }

  return actions;
}

/**
 * Validate a model-supplied `command` against the catalog allowlist. An unknown
 * tool drops the whole `command` (the action's step text is kept regardless — a
 * bad command suggestion must never fail the analysis).
 */
function asCommand(value: unknown): ConflictAction["command"] | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const tool = typeof record.tool === "string" ? record.tool : "";
  if (!tool || !isKnownSynapseCommand(tool)) {
    return undefined;
  }

  if (record.args === undefined || record.args === null || typeof record.args !== "object") {
    return { tool };
  }

  const args: Record<string, string> = {};
  for (const [key, val] of Object.entries(record.args as Record<string, unknown>)) {
    if (typeof val === "string") {
      args[key] = val;
    }
  }

  return Object.keys(args).length > 0 ? { tool, args } : { tool };
}

/**
 * Validate a model reply into a {@link ProposedResolution}, or null if it is
 * unusable (so the caller falls back to the deterministic escalate). Canonical
 * here alongside {@link parseConflictAnalysis} for the same layering reason.
 */
export function parseProposedResolution(
  content: string | undefined,
  model: string
): ProposedResolution | null {
  const record = extractJsonObject(content);
  if (!record) {
    return null;
  }

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

/**
 * Deterministic, dependency-free actionable analysis. Always available, always
 * the fallback. Reads from the structured `change` so it states *what* changed,
 * whether it breaks the other side, and what each agent should do next.
 */
export function deterministicAnalysis(conflict: Conflict): ConflictAnalysis {
  const counterpart = conflict.counterpart.memberLogin;
  const symbol = conflict.targetSymbol.raw;
  const change = conflict.change;
  const reasons = change?.breakingReasons ?? [];
  const reasonText = reasons.length ? ` (${reasons.join(" ")})` : "";

  const base: ConflictAnalysis = {
    assessment: conflict.detail,
    recommendation: recommendationByRule[conflict.rule],
    actions: [],
    source: "deterministic"
  };

  switch (conflict.rule) {
    case "contract_divergent":
      return {
        ...base,
        assessment: `You and ${counterpart} have both rewritten ${symbol} to different, incompatible contracts${reasonText}. Whoever merges second has to rebase onto the other's shape.`,
        actions: [
          {
            audience: "both",
            step: `Agree on the final signature of ${symbol} before either side continues.`
          },
          {
            audience: "you",
            step: `Rebase your change onto the agreed contract, then re-run your checks.`
          },
          {
            audience: "counterpart",
            step: `Share or push your intended contract for ${symbol} so it can be reconciled.`
          }
        ],
        resolution: deterministicResolution(conflict)
      };

    case "same_symbol_unpushed": {
      if (change?.compatibility === "breaking") {
        return {
          ...base,
          assessment: `${counterpart} has an unpushed breaking change to ${symbol}${reasonText}. Code you write against the current contract will not match theirs.`,
          actions: withCommand(
            [
              {
                audience: "you",
                step: `Pull or inspect ${counterpart}'s branch and build against the new contract${change?.after ? ` ${renderSignature(change.after)}` : ""}.`
              },
              {
                audience: "counterpart",
                step: `Push the change or broadcast the new contract so others can adapt.`
              }
            ],
            ["you", "both"],
            { tool: "synapse_whatsup" }
          ),
          resolution: deterministicResolution(conflict)
        };
      }
      if (change?.compatibility === "compatible" || change?.compatibility === "identical") {
        return {
          ...base,
          recommendation: "proceed",
          assessment: `${counterpart} has an unpushed but backward-compatible change to ${symbol}${reasonText}. It should not break your edit.`,
          actions: withCommand(
            [
              {
                audience: "you",
                step: `Proceed; no action required, but keep ${counterpart}'s change in mind.`
              }
            ],
            ["you", "both"],
            { tool: "synapse_whatsup" }
          ),
          resolution: deterministicResolution(conflict)
        };
      }
      return {
        ...base,
        assessment: `${counterpart} has an unpushed change to ${symbol} that could not be classified automatically.`,
        actions: withCommand(
          [
            {
              audience: "you",
              step: `Inspect ${counterpart}'s change to ${symbol} before editing the same contract.`
            }
          ],
          ["you", "both"],
          { tool: "synapse_whatsup" }
        ),
        resolution: deterministicResolution(conflict)
      };
    }

    case "dependency_changed":
      return {
        ...base,
        assessment: `${counterpart} changed ${symbol}, which your edit depends on${reasonText}.`,
        actions: withCommand(
          [
            { audience: "you", step: `Adjust your code to the new contract of ${symbol}.` },
            {
              audience: "counterpart",
              step: `Confirm downstream callers of ${symbol} have been accounted for.`
            }
          ],
          ["you", "both"],
          { tool: "synapse_why", args: { question: symbol } }
        )
      };

    case "transitive_dependency":
      return {
        ...base,
        assessment: `${counterpart} changed a transitive dependency of ${symbol}. Likely safe.`,
        actions: [
          {
            audience: "you",
            step: `Glance at the change; proceed if it is unrelated to your edit.`
          }
        ]
      };

    case "same_symbol_active":
      return {
        ...base,
        assessment: `${counterpart} is actively editing ${symbol} right now.`,
        actions: withCommand(
          [{ audience: "both", step: `Coordinate before you both write to ${symbol}.` }],
          ["both", "you"],
          { tool: "synapse_whatsup" }
        )
      };

    case "stale_base":
      return {
        ...base,
        assessment: `A recent push touched ${symbol}; your base may be stale.`,
        actions: withCommand(
          [{ audience: "you", step: `Pull the latest base before continuing.` }],
          ["you", "both"],
          { tool: "synapse_why", args: { question: symbol } }
        )
      };

    case "same_file_no_overlap":
      return {
        ...base,
        assessment: `${counterpart} is editing the same file but a different symbol.`,
        actions: [{ audience: "you", step: `Proceed if your work is unrelated to theirs.` }]
      };
  }
}

/**
 * One contributing side of a contract resolution: a single agent's competing
 * change to the symbol. Sides are sorted by `sessionId` so the inputs hash and
 * the "side A / side B" ordering are identical on every machine, regardless of
 * which agent is the "self".
 */
export interface ResolutionSide {
  sessionId: string;
  member: string;
  before: string | null;
  after: string | null;
}

/**
 * Deterministic, dependency-free resolution for the two "same code" rules.
 * Always available, always the fallback when no `ResolutionProvider` is wired:
 *
 * - `contract_divergent` → escalate (`reconciled:false`, `recommendation:"block"`):
 *   both sides rewrote the symbol, so no merge can be derived without an LLM.
 * - `same_symbol_unpushed` → adopt the counterpart's contract (`reconciled:true`):
 *   only one side changed it, so the other simply conforms — no round-trip.
 *
 * Returns `undefined` for every other rule.
 */
export function deterministicResolution(conflict: Conflict): ProposedResolution | undefined {
  const symbol = conflict.targetSymbol.raw;
  const counterpart = conflict.counterpart.memberLogin;

  if (conflict.rule === "contract_divergent") {
    const sides = [
      { sessionId: conflict.selfSessionId ?? "self", after: conflict.selfChange?.after ?? null },
      { sessionId: conflict.counterpart.sessionId, after: conflict.change?.after ?? null }
    ].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    const sideA = renderSignature(sides[0].after);
    const sideB = renderSignature(sides[1].after);

    return {
      reconciled: false,
      proposedContract: null,
      rationale: `Both sides rewrote ${symbol} to different contracts; a safe merge cannot be derived deterministically.`,
      recommendation: "block",
      instruction: `Agree on one signature for ${symbol}: side A = ${sideA} vs side B = ${sideB}.`,
      source: "deterministic"
    };
  }

  if (conflict.rule === "same_symbol_unpushed") {
    const after = conflict.change?.after ?? null;
    return {
      reconciled: after?.raw != null,
      proposedContract: after?.raw ?? null,
      rationale: `Only ${counterpart} changed ${symbol}; conform to their contract so both sides match.`,
      recommendation: "warn",
      instruction: `Adopt the counterpart's contract: ${renderSignature(after)}.`,
      source: "deterministic"
    };
  }

  return undefined;
}

/**
 * Build the canonical, side-ordered inputs for a symbol's resolution from the
 * shared unpushed deltas. Keeps only the latest unpushed delta per session and
 * sorts by `sessionId`, so the daemon (building a request) and the server
 * (invalidating stale resolutions) derive exactly the same sides — and thus the
 * same {@link resolutionInputsHash}.
 */
export function resolutionSidesForSymbol(
  deltas: ContractDelta[],
  symbolRaw: string
): ResolutionSide[] {
  const latestBySession = new Map<string, ContractDelta>();

  for (const delta of deltas) {
    if (delta.symbolId.raw !== symbolRaw || delta.pushedAt !== null) {
      continue;
    }

    const existing = latestBySession.get(delta.sessionId);
    if (!existing || delta.createdAt >= existing.createdAt) {
      latestBySession.set(delta.sessionId, delta);
    }
  }

  return [...latestBySession.values()]
    .map((delta) => ({
      sessionId: delta.sessionId,
      member: delta.sessionId,
      before: delta.before?.raw ?? null,
      after: delta.after?.raw ?? null
    }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/**
 * Canonical, symmetric hash of the two contributing diffs behind a resolution.
 * Sides are sorted by `sessionId` before hashing, so Alice and Bob compute the
 * same value for the same pair of changes. Lives in the engine so both daemons
 * (and the server's invalidation logic) derive it identically.
 */
export function resolutionInputsHash(symbol: string, sides: ResolutionSide[]): string {
  const ordered = [...sides]
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    .map((side) => ({ sessionId: side.sessionId, before: side.before, after: side.after }));

  return createHash("sha256")
    .update(JSON.stringify({ symbol, sides: ordered }))
    .digest("hex");
}

/**
 * Input handed to a {@link ResolutionProvider}. Carries the deterministically
 * derived, side-ordered facts plus optional code context for the computing
 * agent's file and its dependency-graph neighbors.
 */
export interface ResolutionRequest {
  symbol: string;
  inputsHash: string;
  /** Both sides, already sorted by `sessionId` (symmetric across machines). */
  sides: ResolutionSide[];
  /** The computing agent's full file, for a caller-aware merge. */
  fileContext?: string;
  /** Dependency-graph neighbors (callers/types) and their signatures. */
  neighbors?: { symbol: string; signature: string }[];
}

/**
 * Pluggable, OPTIONAL resolution layer. Like {@link AnalysisProvider}, it never
 * affects correctness: a thrown error or `null` keeps the engine's deterministic
 * resolution. Used only for the narrow `contract_divergent` case where a merged
 * contract must be synthesized.
 */
export interface ResolutionProvider {
  proposeResolution(req: ResolutionRequest): Promise<ProposedResolution | null>;
}

/**
 * A short, deterministic one-liner kept on `conflict.explanation` for backward
 * compatibility and quick display. The richer, actionable output is `analysis`.
 */
export function templateExplanation(conflict: Conflict): string {
  return deterministicAnalysis(conflict).assessment;
}

/**
 * Replace each conflict's deterministic `analysis` with a provider-supplied one
 * where available, feeding the provider both sides' diffs. Never throws: a
 * failing provider call leaves the deterministic analysis in place. Meant to be
 * called off the correctness-critical path (the verdict is already decided).
 */
export async function enrichConflicts(
  conflicts: Conflict[],
  provider: AnalysisProvider,
  context: AnalysisContext = {}
): Promise<Conflict[]> {
  return Promise.all(
    conflicts.map(async (conflict) => {
      const deterministic = conflict.analysis ?? deterministicAnalysis(conflict);
      const symbol = conflict.targetSymbol.raw;

      try {
        const enriched = await provider.analyzeConflict({
          rule: conflict.rule,
          targetSymbol: symbol,
          counterpart: conflict.counterpart.memberLogin,
          task: context.task,
          counterpartChange: conflict.change,
          selfSignature: context.selfSignatureBySymbol?.get(symbol) ?? null,
          selfChange: context.selfChangeBySymbol?.get(symbol) ?? null,
          deterministic
        });

        // The analysis provider only upgrades the prose/steps; carry the
        // deterministic merged-contract resolution across so it is not lost.
        const analysis = enriched
          ? {
              ...enriched,
              recommendation: strongestRecommendation(
                deterministic.recommendation,
                enriched.recommendation
              ),
              resolution: enriched.resolution ?? deterministic.resolution
            }
          : deterministic;

        return { ...conflict, analysis };
      } catch {
        return { ...conflict, analysis: deterministic };
      }
    })
  );
}

function strongestRecommendation(
  deterministic: ConflictAnalysis["recommendation"],
  enriched: ConflictAnalysis["recommendation"]
): ConflictAnalysis["recommendation"] {
  return recommendationRank[enriched] >= recommendationRank[deterministic]
    ? enriched
    : deterministic;
}
