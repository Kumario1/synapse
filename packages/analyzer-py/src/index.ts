import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Sidecar, diffContracts } from "@synapse/analyzer-core";
import type { CodeSymbol, SymbolId } from "@synapse/protocol";

export interface ExtractPythonContractsInput {
  filePath: string;
  source: string;
}

export interface ExtractPythonContractsResult {
  symbols: CodeSymbol[];
}

export interface ExtractPythonDependencyGraphInput {
  files: ExtractPythonContractsInput[];
}

export interface PythonDependencyEdge {
  from: SymbolId;
  to: SymbolId;
  kind: "references";
}

export interface ExtractPythonDependencyGraphResult {
  symbols: CodeSymbol[];
  edges: PythonDependencyEdge[];
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pythonDir = join(packageRoot, "python");

/**
 * Resolve the Python interpreter: explicit override, then the package venv, then
 * a system interpreter (which may lack the pinned deps — the first request then
 * rejects and the daemon falls back to file-level detection).
 */
function resolvePythonExecutable(): string {
  const override = process.env.SYNAPSE_PYTHON;
  if (override && existsSync(override)) {
    return override;
  }
  const isWindows = process.platform === "win32";
  const venvPython = join(
    packageRoot,
    ".venv",
    isWindows ? "Scripts" : "bin",
    isWindows ? "python.exe" : "python3"
  );
  if (existsSync(venvPython)) {
    return venvPython;
  }
  return isWindows ? "python" : "python3";
}

let sidecar: Sidecar | null = null;

function getSidecar(): Sidecar {
  if (!sidecar) {
    sidecar = new Sidecar({
      command: resolvePythonExecutable,
      args: ["-m", "synapse_analyzer.server"],
      cwd: pythonDir,
      label: "python"
    });
  }
  return sidecar;
}

/** Probe the sidecar; `false` means the daemon should use file-level fallback. */
export async function pythonAnalyzerAvailable(): Promise<boolean> {
  try {
    const health = await getSidecar().request<{ ok?: boolean }>("health", {});
    return health.ok === true;
  } catch {
    return false;
  }
}

export async function extractPythonContracts(
  input: ExtractPythonContractsInput
): Promise<ExtractPythonContractsResult> {
  return getSidecar().request<ExtractPythonContractsResult>("extractFile", {
    filePath: input.filePath,
    source: input.source
  });
}

export async function extractPythonDependencyGraph(
  input: ExtractPythonDependencyGraphInput
): Promise<ExtractPythonDependencyGraphResult> {
  return getSidecar().request<ExtractPythonDependencyGraphResult>("indexGraph", {
    files: input.files
  });
}

/**
 * Language-neutral structural contract diff, shared with the Go analyzer via
 * `@synapse/analyzer-core`, so a Python change flows through the same conflict
 * engine as every other language.
 */
export const diffPythonContracts = diffContracts;

/** Shut down the shared sidecar (tests, daemon shutdown). */
export function closePythonAnalyzer(): void {
  if (sidecar) {
    sidecar.close();
    sidecar = null;
  }
}
