import { randomUUID } from "node:crypto";
import { diffGoContracts } from "@synapse/analyzer-go";
import { diffPythonContracts } from "@synapse/analyzer-py";
import { diffTypeScriptContracts } from "@synapse/analyzer-ts";
import { symbolForFile } from "@synapse/conflict-engine";
import type {
  CodeSymbol,
  ContractDelta,
  ContractDeltaSummary,
  SynapseCheckRequest,
  SynapseReportRequest
} from "@synapse/protocol";
import {
  buildDependencyGraph,
  extractSymbolsForFile,
  isAnalyzable,
  isGoLike,
  isPythonLike,
  markGraphDirty,
  reservationSeedForSymbol,
  type AnalysisCache,
  type DaemonGraph
} from "./analysis.js";
import type { RuntimeConfig } from "./config.js";

export async function seedContractSnapshotsForFiles(
  config: RuntimeConfig,
  contractSnapshots: Map<string, CodeSymbol[]>,
  body: Partial<SynapseCheckRequest>,
  cache?: AnalysisCache
): Promise<void> {
  const seen = new Set<string>();

  for (const [index, filePath] of (body.files ?? []).entries()) {
    if (seen.has(filePath) || !isAnalyzable(filePath)) {
      continue;
    }
    seen.add(filePath);

    try {
      contractSnapshots.set(filePath, await extractSymbolsForFile(config, filePath, cache));
    } catch (error) {
      if (body.symbols?.[index]) {
        continue;
      }
      throw error;
    }
  }
}

export async function reportContractChanges(
  config: RuntimeConfig,
  contractSnapshots: Map<string, CodeSymbol[]>,
  body: Partial<SynapseReportRequest>,
  cache?: AnalysisCache
): Promise<ContractDelta[]> {
  if (!body.filePath) {
    return [];
  }

  const filePath = body.filePath;
  const analyzable = isAnalyzable(filePath);
  let dependencyGraph: DaemonGraph | null = null;
  // Every reported edit (tool call or watcher event) can change dependency
  // edges — the warm-check graph cache must not outlive it.
  if (analyzable) {
    markGraphDirty(cache);
    dependencyGraph = await buildDependencyGraph(config, cache);
  }

  if (body.symbolId || !analyzable) {
    const symbolId = body.symbolId ?? symbolForFile(filePath);
    const dependents =
      body.dependents ??
      dependencyGraph?.dependentsOf(symbolId.raw).map((site) => site.symbolId) ??
      [];
    return [
      createContractDelta(config, {
        symbolId,
        filePath,
        changeKind: body.changeKind ?? "signature_changed",
        before: null,
        after: null,
        summary: body.summary ?? `Updated ${symbolId.raw}`,
        baseSha: body.baseSha,
        dependents,
        reservation: reservationSeedForReport(symbolId, dependencyGraph, dependents)
      })
    ];
  }

  const current = await extractSymbolsForFile(config, filePath, cache);
  const previous = contractSnapshots.get(filePath);
  contractSnapshots.set(filePath, current);

  if (!previous) {
    return [];
  }

  const changes = isPythonLike(filePath)
    ? diffPythonContracts(previous, current)
    : isGoLike(filePath)
      ? diffGoContracts(previous, current)
      : diffTypeScriptContracts(previous, current, {
          detectRenames: process.env.SYNAPSE_RENAME_TRACKING !== "0"
        });
  return changes.map((change) =>
    createContractDelta(config, {
      symbolId: change.symbolId,
      filePath,
      changeKind: change.changeKind,
      before: change.before?.signature ?? null,
      after: change.after?.signature ?? null,
      summary:
        body.summary ??
        (change.changeKind === "renamed" && change.after
          ? `Renamed ${change.symbolId.raw} to ${change.after.id.raw}`
          : summarizeSymbolChange(change.changeKind, change.symbolId.raw)),
      baseSha: body.baseSha,
      dependents:
        body.dependents ??
        dependencyGraph?.dependentsOf(change.symbolId.raw).map((site) => site.symbolId),
      reservation: reservationSeedForReport(
        change.symbolId,
        dependencyGraph,
        body.dependents ??
          dependencyGraph?.dependentsOf(change.symbolId.raw).map((site) => site.symbolId) ??
          []
      )
    })
  );
}

export function reservationSeedForReport(
  symbolId: ContractDelta["symbolId"],
  graph: DaemonGraph | null,
  dependents: ContractDelta["dependents"]
): ContractDelta["reservation"] {
  if (graph) {
    return reservationSeedForSymbol(symbolId, graph, dependents);
  }

  return {
    radius: 0,
    symbols: uniqueSymbols([symbolId, ...dependents])
  };
}

export function uniqueSymbols(symbols: ContractDelta["symbolId"][]): ContractDelta["symbolId"][] {
  const seen = new Set<string>();
  const result: ContractDelta["symbolId"][] = [];
  for (const symbol of symbols) {
    if (seen.has(symbol.raw)) {
      continue;
    }
    seen.add(symbol.raw);
    result.push(symbol);
  }
  return result;
}

export function createContractDelta(
  config: RuntimeConfig,
  input: Pick<ContractDelta, "symbolId" | "changeKind" | "before" | "after" | "filePath"> & {
    summary: string;
    baseSha?: string;
    dependents?: ContractDelta["dependents"];
    reservation?: ContractDelta["reservation"];
  }
): ContractDelta {
  return {
    id: randomUUID(),
    repoId: config.repoId,
    sessionId: config.sessionId,
    symbolId: input.symbolId,
    changeKind: input.changeKind,
    before: input.before,
    after: input.after,
    summary: input.summary,
    filePath: input.filePath,
    baseSha: input.baseSha ?? "local",
    dependents: input.dependents ?? [],
    createdAt: new Date().toISOString(),
    pushedAt: null,
    ...(input.reservation ? { reservation: input.reservation } : {})
  };
}

export function summarizeDelta(delta: ContractDelta): ContractDeltaSummary {
  return {
    id: delta.id,
    symbolId: delta.symbolId,
    changeKind: delta.changeKind,
    summary: delta.summary,
    filePath: delta.filePath,
    createdAt: delta.createdAt
  };
}

export function summarizeSymbolChange(
  changeKind: ContractDelta["changeKind"],
  rawSymbolId: string
): string {
  switch (changeKind) {
    case "added":
      return `Added ${rawSymbolId}`;
    case "removed":
      return `Removed ${rawSymbolId}`;
    case "signature_changed":
      return `Changed signature for ${rawSymbolId}`;
    case "visibility_changed":
      return `Changed visibility for ${rawSymbolId}`;
    case "moved":
      return `Moved ${rawSymbolId}`;
    case "renamed":
      return `Renamed ${rawSymbolId}`;
  }
}
