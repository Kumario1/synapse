import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Sidecar, diffContracts } from "@synapse/analyzer-core";
import type { CodeSymbol, SymbolId } from "@synapse/protocol";

export interface ExtractGoContractsInput {
  filePath: string;
  source: string;
}

export interface ExtractGoContractsResult {
  symbols: CodeSymbol[];
}

export interface ExtractGoDependencyGraphInput {
  files: ExtractGoContractsInput[];
}

export interface GoDependencyEdge {
  from: SymbolId;
  to: SymbolId;
  kind: "references";
}

export interface ExtractGoDependencyGraphResult {
  symbols: CodeSymbol[];
  edges: GoDependencyEdge[];
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Resolve the Go analyzer binary: explicit override, else the binary built by
 * `setup-go.mjs` under `bin/`. A missing or unbuilt binary surfaces as a
 * rejected request so the daemon degrades to file-level detection.
 */
function resolveBinary(): string {
  const override = process.env.SYNAPSE_GO_ANALYZER_BIN;
  if (override && existsSync(override)) {
    return override;
  }
  const isWindows = process.platform === "win32";
  return join(packageRoot, "bin", isWindows ? "synapse-analyzer-go.exe" : "synapse-analyzer-go");
}

let sidecar: Sidecar | null = null;

function getSidecar(): Sidecar {
  if (!sidecar) {
    sidecar = new Sidecar({
      command: resolveBinary,
      args: [],
      cwd: packageRoot,
      label: "go"
    });
  }
  return sidecar;
}

/** Probe the sidecar; `false` means the daemon should use file-level fallback. */
export async function goAnalyzerAvailable(): Promise<boolean> {
  try {
    const health = await getSidecar().request<{ ok?: boolean }>("health", {});
    return health.ok === true;
  } catch {
    return false;
  }
}

export async function extractGoContracts(
  input: ExtractGoContractsInput
): Promise<ExtractGoContractsResult> {
  return getSidecar().request<ExtractGoContractsResult>("extractFile", {
    filePath: input.filePath,
    source: input.source
  });
}

export async function extractGoDependencyGraph(
  input: ExtractGoDependencyGraphInput
): Promise<ExtractGoDependencyGraphResult> {
  return getSidecar().request<ExtractGoDependencyGraphResult>("indexGraph", {
    files: input.files
  });
}

/**
 * Language-neutral structural contract diff, shared with the Python analyzer via
 * `@synapse/analyzer-core`, so a Go change flows through the same conflict engine.
 */
export const diffGoContracts = diffContracts;

/** Shut down the shared sidecar (tests, daemon shutdown). */
export function closeGoAnalyzer(): void {
  if (sidecar) {
    sidecar.close();
    sidecar = null;
  }
}
