import type { AffectedSite, ContractDelta, Direction, SymbolId } from "@synapse/protocol";

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
