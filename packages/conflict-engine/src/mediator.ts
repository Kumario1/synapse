import type { AffectedSite, ContractDelta, Direction, SymbolId } from "@synapse/protocol";
import { compareSignatures } from "./compare.js";

export type ConflictClass = "mechanical" | "semantic";

/**
 * Deterministic classification of a contested symbol. Semantic means both sides
 * changed the contract to mutually exclusive signatures; otherwise the loser
 * can mechanically adapt to the keep side's call-site list.
 */
export function classifyCollision(
  keepDelta: ContractDelta,
  adaptDelta: ContractDelta | undefined
): ConflictClass {
  if (!adaptDelta) {
    return "mechanical";
  }

  const comparison = compareSignatures(keepDelta.after, adaptDelta.after);
  return comparison.compatibility === "identical" ? "mechanical" : "semantic";
}

/** Call-sites a contesting side must update = the keep delta's dependents. */
export function affectedSitesFromDelta(keepDelta: ContractDelta): AffectedSite[] {
  return keepDelta.dependents.map((symbolId) => ({
    symbolId,
    filePath: filePathOf(symbolId)
  }));
}

/** The keep/adapt direction pair for a mechanical collision (templated prose). */
export function buildMechanicalDirections(
  keepSessionId: string,
  adaptSessionId: string,
  keepDelta: ContractDelta
): Direction[] {
  const sites = affectedSitesFromDelta(keepDelta);
  const symbol = keepDelta.symbolId.raw;

  return [
    {
      sessionId: keepSessionId,
      role: "keep",
      summary: `Keep your change to ${symbol}.`,
      affectedSites: []
    },
    {
      sessionId: adaptSessionId,
      role: "adapt",
      summary: `Update ${sites.length} call-site(s) to match ${symbol}'s new signature.`,
      affectedSites: sites
    }
  ];
}

function filePathOf(symbolId: SymbolId): string {
  const withoutLanguage = symbolId.raw.includes(":")
    ? symbolId.raw.slice(symbolId.raw.indexOf(":") + 1)
    : symbolId.raw;
  return withoutLanguage.split("#", 1)[0] ?? withoutLanguage;
}
