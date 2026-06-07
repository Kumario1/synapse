import type {
  Conflict,
  ConflictAnalysis,
  ContractChange,
  Signature
} from "@synapse/protocol";
import { renderSignature } from "./compare.js";

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
          { audience: "both", step: `Agree on the final signature of ${symbol} before either side continues.` },
          { audience: "you", step: `Rebase your change onto the agreed contract, then re-run your checks.` },
          { audience: "counterpart", step: `Share or push your intended contract for ${symbol} so it can be reconciled.` }
        ]
      };

    case "same_symbol_unpushed": {
      if (change?.compatibility === "breaking") {
        return {
          ...base,
          assessment: `${counterpart} has an unpushed breaking change to ${symbol}${reasonText}. Code you write against the current contract will not match theirs.`,
          actions: [
            {
              audience: "you",
              step: `Pull or inspect ${counterpart}'s branch and build against the new contract${change?.after ? ` ${renderSignature(change.after)}` : ""}.`
            },
            { audience: "counterpart", step: `Push the change or broadcast the new contract so others can adapt.` }
          ]
        };
      }
      if (change?.compatibility === "compatible" || change?.compatibility === "identical") {
        return {
          ...base,
          recommendation: "proceed",
          assessment: `${counterpart} has an unpushed but backward-compatible change to ${symbol}${reasonText}. It should not break your edit.`,
          actions: [
            { audience: "you", step: `Proceed; no action required, but keep ${counterpart}'s change in mind.` }
          ]
        };
      }
      return {
        ...base,
        assessment: `${counterpart} has an unpushed change to ${symbol} that could not be classified automatically.`,
        actions: [
          { audience: "you", step: `Inspect ${counterpart}'s change to ${symbol} before editing the same contract.` }
        ]
      };
    }

    case "dependency_changed":
      return {
        ...base,
        assessment: `${counterpart} changed ${symbol}, which your edit depends on${reasonText}.`,
        actions: [
          { audience: "you", step: `Adjust your code to the new contract of ${symbol}.` },
          { audience: "counterpart", step: `Confirm downstream callers of ${symbol} have been accounted for.` }
        ]
      };

    case "transitive_dependency":
      return {
        ...base,
        assessment: `${counterpart} changed a transitive dependency of ${symbol}. Likely safe.`,
        actions: [{ audience: "you", step: `Glance at the change; proceed if it is unrelated to your edit.` }]
      };

    case "same_symbol_active":
      return {
        ...base,
        assessment: `${counterpart} is actively editing ${symbol} right now.`,
        actions: [{ audience: "both", step: `Coordinate before you both write to ${symbol}.` }]
      };

    case "stale_base":
      return {
        ...base,
        assessment: `A recent push touched ${symbol}; your base may be stale.`,
        actions: [{ audience: "you", step: `Pull the latest base before continuing.` }]
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

        return { ...conflict, analysis: enriched ?? deterministic };
      } catch {
        return { ...conflict, analysis: deterministic };
      }
    })
  );
}
