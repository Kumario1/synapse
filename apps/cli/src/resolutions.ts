import { readFile } from "node:fs/promises";
import { extractTypeScriptContracts } from "@synapse/analyzer-ts";
import {
  resolutionInputsHash,
  resolutionSidesForSymbol,
  type Conflict,
  type ResolutionProvider,
  type ResolutionSide
} from "@synapse/conflict-engine";
import type {
  ClientMessage,
  ContractResolution,
  ProposedResolution,
  TeamState
} from "@synapse/protocol";
import type { AffectedSite } from "./analysis.js";
import type { RuntimeConfig } from "./config.js";
import { resolveWorktreePath } from "./path-safety.js";

export type ConflictWithAffectedSites = Conflict & {
  analysis?: NonNullable<Conflict["analysis"]> & {
    affectedSites?: AffectedSite[];
  };
};

export function attachAffectedSites(
  conflicts: Conflict[],
  dependentsOf: (symbolRaw: string) => AffectedSite[]
): ConflictWithAffectedSites[] {
  return conflicts.map((conflict) => {
    if (
      (conflict.rule !== "contract_divergent" &&
        conflict.rule !== "dependency_changed" &&
        conflict.rule !== "transitive_dependency") ||
      !conflict.analysis
    ) {
      return conflict;
    }

    const affectedSites = dependentsOf(conflict.targetSymbol.raw);
    if (affectedSites.length === 0) {
      return conflict;
    }

    return {
      ...conflict,
      analysis: {
        ...conflict.analysis,
        affectedSites
      }
    };
  });
}

export async function attachResolutions(
  config: RuntimeConfig,
  conflicts: Conflict[],
  teamState: TeamState,
  resolutionProvider: ResolutionProvider | null,
  neighborsOf: (symbolRaw: string) => { symbol: string; signature: string }[],
  sendToServer: (type: ClientMessage["type"], payload: unknown) => void
): Promise<Conflict[]> {
  return Promise.all(
    conflicts.map(async (conflict) => {
      if (conflict.rule !== "contract_divergent" || !conflict.analysis) {
        return conflict;
      }

      const symbol = conflict.targetSymbol.raw;
      const sides = labelSides(
        resolutionSidesForSymbol(teamState.unpushedDeltas, symbol),
        teamState
      );
      const inputsHash = resolutionInputsHash(symbol, sides);

      // (1) Convergence: a resolution for this exact pair already exists.
      const stored = teamState.resolutions.find(
        (resolution) => resolution.symbol.raw === symbol && resolution.inputsHash === inputsHash
      );
      if (stored) {
        return withResolution(conflict, toProposed(stored));
      }

      if (!resolutionProvider) {
        return conflict; // (3) keep the deterministic escalate.
      }

      // (2) Generate, validate, publish.
      const filePath = teamState.unpushedDeltas.find(
        (delta) => delta.symbolId.raw === symbol
      )?.filePath;
      const fileContext = filePath ? await readFileContext(config, filePath) : undefined;

      let proposed: ProposedResolution | null = null;
      try {
        proposed = await resolutionProvider.proposeResolution({
          symbol,
          inputsHash,
          sides,
          fileContext,
          neighbors: neighborsOf(symbol)
        });
      } catch {
        proposed = null;
      }

      if (!proposed) {
        return conflict; // resolver failed → deterministic escalate stands.
      }

      // A reconciled contract that does not parse cannot be trusted; fall back
      // to the deterministic escalate rather than handing agents broken code.
      if (proposed.reconciled && !contractParses(proposed.proposedContract)) {
        return conflict;
      }

      const record: ContractResolution = {
        ...proposed,
        repoId: config.repoId,
        symbol: conflict.targetSymbol,
        inputsHash,
        createdAt: new Date().toISOString()
      };
      sendToServer("resolution.propose", { repoId: config.repoId, resolution: record });

      return withResolution(conflict, proposed);
    })
  );
}

/** Replace `member` on each side with its session's display login, if known. */
export function labelSides(sides: ResolutionSide[], state: TeamState): ResolutionSide[] {
  return sides.map((side) => {
    const session = state.sessions.find((candidate) => candidate.id === side.sessionId);
    return { ...side, member: session?.memberLogin ?? session?.memberId ?? side.member };
  });
}

export function withResolution(conflict: Conflict, resolution: ProposedResolution): Conflict {
  return {
    ...conflict,
    analysis: conflict.analysis ? { ...conflict.analysis, resolution } : conflict.analysis
  };
}

export function toProposed(resolution: ContractResolution): ProposedResolution {
  return {
    reconciled: resolution.reconciled,
    proposedContract: resolution.proposedContract,
    rationale: resolution.rationale,
    recommendation: resolution.recommendation,
    instruction: resolution.instruction,
    source: resolution.source
  };
}

export async function readFileContext(
  config: RuntimeConfig,
  filePath: string
): Promise<string | undefined> {
  try {
    return await readFile(await resolveWorktreePath(config.worktreeRoot, filePath), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * A proposed merged contract is trusted only if the real analyzer can parse it.
 * We probe leniently: a full declaration is extracted directly; anything else
 * is wrapped as a type alias so a bare signature still has a chance to parse.
 */
export function contractParses(proposedContract: string | null): boolean {
  if (!proposedContract) {
    return false;
  }

  const isDeclaration =
    /^\s*(export\s+)?(declare\s+)?(function|class|interface|type|enum|const)\b/u.test(
      proposedContract
    );
  const source = isDeclaration
    ? proposedContract.replace(/^\s*(export\s+)?/u, "export ")
    : `export type __Resolution = ${proposedContract};`;

  try {
    return extractTypeScriptContracts({ filePath: "__resolution.ts", source }).symbols.length > 0;
  } catch {
    return false;
  }
}
