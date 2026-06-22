import type {
  AffectedSite,
  ContractDelta,
  Direction,
  ResolutionProposal,
  SymbolId
} from "@synapse/protocol";
import { compareSignatures } from "./compare.js";

export type ConflictClass = "mechanical" | "semantic";

export interface MediatorResolutionRequest {
  proposalId: string;
  symbol: string;
  conflictClass: ConflictClass;
  keep: {
    sessionId: string;
    before: string | null;
    after: string | null;
    filePath: string;
    summary: string;
  };
  adapt: {
    sessionId: string;
    before: string | null;
    after: string | null;
    filePath: string | null;
    summary: string | null;
  };
  affectedSites: AffectedSite[];
  deterministicSummary: string;
}

export interface MediatorResolutionProse {
  adaptSummary: string;
}

export interface MediatorResolutionProvider {
  proposeResolution(req: MediatorResolutionRequest): Promise<MediatorResolutionProse | null>;
}

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

export function buildMediatorResolutionRequest(
  proposal: ResolutionProposal,
  keepDelta: ContractDelta,
  adaptDelta: ContractDelta | undefined
): MediatorResolutionRequest | null {
  if (proposal.status !== "resolving") {
    return null;
  }
  if (proposal.symbol.raw !== keepDelta.symbolId.raw) {
    return null;
  }

  const keepDirection = proposal.directions.find(
    (direction) => direction.role === "keep" && direction.sessionId === keepDelta.sessionId
  );
  const adaptDirection = proposal.directions.find((direction) => direction.role === "adapt");
  if (!keepDirection || !adaptDirection) {
    return null;
  }
  if (adaptDelta && adaptDirection.sessionId !== adaptDelta.sessionId) {
    return null;
  }

  return {
    proposalId: proposal.id,
    symbol: proposal.symbol.raw,
    conflictClass: proposal.conflictClass,
    keep: {
      sessionId: keepDelta.sessionId,
      before: keepDelta.before?.raw ?? null,
      after: keepDelta.after?.raw ?? null,
      filePath: keepDelta.filePath,
      summary: keepDelta.summary
    },
    adapt: {
      sessionId: adaptDirection.sessionId,
      before: adaptDelta?.before?.raw ?? null,
      after: adaptDelta?.after?.raw ?? null,
      filePath: adaptDelta?.filePath ?? null,
      summary: adaptDelta?.summary ?? null
    },
    affectedSites: adaptDirection.affectedSites,
    deterministicSummary: adaptDirection.summary
  };
}

export function applyMediatorResolutionProse(
  proposal: ResolutionProposal,
  request: MediatorResolutionRequest,
  prose: MediatorResolutionProse | null
): boolean {
  if (proposal.status !== "resolving" || !prose) {
    return false;
  }
  if (proposal.id !== request.proposalId || proposal.symbol.raw !== request.symbol) {
    return false;
  }

  const summary = groundedMediatorAdaptSummary(request, prose.adaptSummary);
  if (!summary || summary === request.deterministicSummary) {
    return false;
  }

  const adaptDirection = proposal.directions.find(
    (direction) => direction.role === "adapt" && direction.sessionId === request.adapt.sessionId
  );
  if (!adaptDirection || adaptDirection.summary !== request.deterministicSummary) {
    return false;
  }

  adaptDirection.summary = summary;
  return true;
}

export function groundedMediatorAdaptSummary(
  request: MediatorResolutionRequest,
  candidate: string
): string | null {
  const summary = candidate.trim();
  if (!summary) {
    return null;
  }
  if (!summary.includes(request.symbol)) {
    return null;
  }
  if (request.keep.after && !summary.includes(request.keep.after)) {
    return null;
  }
  for (const site of request.affectedSites) {
    if (!summary.includes(site.filePath)) {
      return null;
    }
  }
  if (mentionsUnknownFilePath(summary, request)) {
    return null;
  }
  if (mentionsUnknownSymbolId(summary, request)) {
    return null;
  }
  if (mentionsUnknownSignatureSnippet(summary, request)) {
    return null;
  }
  return summary;
}

/** Drop the `lang:` prefix from a symbol id (`ts:src/x.ts#fn` -> `src/x.ts#fn`). */
function languageStripped(raw: string): string {
  return raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
}

function filePathOf(symbolId: SymbolId): string {
  const stripped = languageStripped(symbolId.raw);
  return stripped.split("#", 1)[0] ?? stripped;
}

function mentionsUnknownFilePath(text: string, request: MediatorResolutionRequest): boolean {
  const allowed = allowedFilePaths(request);
  const symbolIds = allowedSymbolIds(request);
  for (const candidate of text.matchAll(/\b[\w.-]+(?:\/[\w.-]+)+(?:#[\w$.-]+)?/g)) {
    const token = stripTrailingPunctuation(candidate[0]);
    // Exact match only. A substring test (`symbolId.includes(token)`) let any
    // hallucinated fragment that happened to sit inside an allowed symbol id
    // (e.g. "rc/aut" inside "ts:src/auth/token.ts#validate") pass as grounded.
    // The legitimate case — the file path embedded in a symbol id — is now an
    // explicit member of `allowed` via filePathOf.
    if (!allowed.has(token) && !symbolIds.has(token)) {
      return true;
    }
  }
  return false;
}

function mentionsUnknownSymbolId(text: string, request: MediatorResolutionRequest): boolean {
  const allowed = allowedSymbolIds(request);
  for (const candidate of text.matchAll(/\b[a-z][\w+.-]*:[^\s`'",;!?()]+#[^\s`'",;!?()]+/gi)) {
    const token = stripTrailingPunctuation(candidate[0]);
    if (!allowed.has(token)) {
      return true;
    }
  }
  return false;
}

function mentionsUnknownSignatureSnippet(
  text: string,
  request: MediatorResolutionRequest
): boolean {
  const allowed = allowedSignatures(request);
  for (const candidate of text.matchAll(/`([^`]+)`/g)) {
    const snippet = candidate[1]?.trim() ?? "";
    if (looksSignatureLike(snippet) && !allowed.has(snippet)) {
      return true;
    }
  }
  return false;
}

function allowedFilePaths(request: MediatorResolutionRequest): Set<string> {
  const symbolIdRaws = [...allowedSymbolIds(request)];
  return new Set(
    [
      request.keep.filePath,
      request.adapt.filePath,
      ...request.affectedSites.map((site) => site.filePath),
      // A path-like token in the prose can come from a bare path mention
      // (src/x.ts) or a full symbol-id mention, which the path regex surfaces
      // with its language prefix stripped (src/x.ts#fn). Allow both exact forms
      // for every allowed symbol id — sound, unlike the old substring test.
      ...symbolIdRaws.map((raw) => filePathOf({ raw })),
      ...symbolIdRaws.map(languageStripped)
    ].filter((value): value is string => Boolean(value))
  );
}

function allowedSymbolIds(request: MediatorResolutionRequest): Set<string> {
  return new Set([request.symbol, ...request.affectedSites.map((site) => site.symbolId.raw)]);
}

function allowedSignatures(request: MediatorResolutionRequest): Set<string> {
  return new Set(
    [request.keep.before, request.keep.after, request.adapt.before, request.adapt.after].filter(
      (value): value is string => Boolean(value)
    )
  );
}

function looksSignatureLike(snippet: string): boolean {
  return snippet.includes("=>") || (snippet.includes("(") && snippet.includes(")"));
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;:!?]+$/g, "");
}
