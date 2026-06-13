import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import {
  extractGoContracts,
  extractGoDependencyGraph
} from "@synapse/analyzer-go";
import {
  extractPythonContracts,
  extractPythonDependencyGraph
} from "@synapse/analyzer-py";
import {
  extractTypeScriptContracts,
  extractTypeScriptDependencyGraph
} from "@synapse/analyzer-ts";
import {
  contractChangeFor,
  emptyDependencyGraph,
  symbolForFile,
  type DependencyGraph,
  type DependencyHop
} from "@synapse/conflict-engine";
import type {
  ContractDelta,
  CodeSymbol,
  ContractChange,
  Signature,
  SynapseCheckRequest,
  TeamState
} from "@synapse/protocol";
import { normalizePath, type RuntimeConfig } from "./config.js";
import { resolveWorktreePath } from "./path-safety.js";

export interface AnalysisCache {
  symbolsByFile: Map<string, CachedSymbols>;
  graph: CachedGraph | null;
  /**
   * When false, the cached graph is known current and warm checks may reuse
   * it without re-fingerprinting the source tree. Marked true by every path
   * that can change local sources (reports, watcher events); only cleared
   * after a build, and only while `graphTrusted` is set.
   */
  graphDirty: boolean;
  /**
   * True only while a file watcher is actively observing the worktree (set
   * on watch-ready). Without it, "not dirty" is meaningless — manual edits
   * would go unseen — so builds never clear `graphDirty` and every call
   * falls back to the fingerprint comparison (the pre-cache behavior).
   */
  graphTrusted: boolean;
  /** Observability hook: called when a warm check reuses the clean graph. */
  onGraphReuse?: () => void;
}

/** Mark the cached dependency graph stale; the next check rebuilds or re-fingerprints. */
export function markGraphDirty(cache?: AnalysisCache): void {
  if (cache) {
    cache.graphDirty = true;
  }
}

interface CachedSymbols {
  fingerprint: string;
  symbols: CodeSymbol[];
}

interface CachedGraph {
  fingerprint: string;
  value: DaemonGraph;
}

export interface SourceFileFingerprint {
  filePath: string;
  mtimeMs: number;
  size: number;
}

export interface SourceFileContent extends SourceFileFingerprint {
  source: string;
}

/** Run the analyzer-py venv setup script, resolved from the installed package. */
export function setupPythonAnalyzerVenv(): void {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("@synapse/analyzer-py/package.json");
    const script = join(dirname(packageJson), "scripts", "setup-venv.mjs");
    const result = spawnSync(process.execPath, [script], { stdio: "inherit" });
    if (result.status !== 0) {
      console.warn("synapse: Python analyzer setup skipped; .py files will use file-level detection.");
    }
  } catch {
    console.warn("synapse: Python analyzer package not found; .py files will use file-level detection.");
  }
}

/** Build the analyzer-go sidecar binary, resolved from the installed package. */
export function setupGoAnalyzerBinary(): void {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("@synapse/analyzer-go/package.json");
    const script = join(dirname(packageJson), "scripts", "setup-go.mjs");
    const result = spawnSync(process.execPath, [script], { stdio: "inherit" });
    if (result.status !== 0) {
      console.warn("synapse: Go analyzer setup skipped; .go files will use file-level detection.");
    }
  } catch {
    console.warn("synapse: Go analyzer package not found; .go files will use file-level detection.");
  }
}
export interface CheckTarget {
  filePath: string;
  symbolId: ContractDelta["symbolId"];
  /** The checking agent's current local signature for the symbol, if known. */
  selfSignature?: Signature | null;
}

export async function resolveCheckTargets(
  config: RuntimeConfig,
  body: Partial<SynapseCheckRequest>,
  cache?: AnalysisCache
): Promise<CheckTarget[]> {
  const files = body.files ?? [];
  const targets: CheckTarget[] = [];

  for (const [index, filePath] of files.entries()) {
    const explicitSymbol = body.symbols?.[index];
    if (explicitSymbol) {
      targets.push({ filePath, symbolId: explicitSymbol });
      continue;
    }

    if (!isAnalyzable(filePath)) {
      targets.push({ filePath, symbolId: symbolForFile(filePath) });
      continue;
    }

    const symbols = await extractSymbolsForFile(config, filePath, cache);
    if (symbols.length === 0) {
      targets.push({ filePath, symbolId: symbolForFile(filePath) });
      continue;
    }

    for (const symbol of symbols) {
      targets.push({ filePath, symbolId: symbol.id, selfSignature: symbol.signature });
    }
  }

  return targets;
}

/** The checking agent's local signature per symbol, for both-sides analysis. */
export function selfSignatures(targets: CheckTarget[]): Map<string, Signature | null> {
  const signatures = new Map<string, Signature | null>();
  for (const target of targets) {
    signatures.set(target.symbolId.raw, target.selfSignature ?? null);
  }

  return signatures;
}

/** The checking agent's own unpushed change per symbol, for both-sides analysis. */
export function selfChanges(state: TeamState, selfSessionId: string): Map<string, ContractChange | null> {
  const changes = new Map<string, ContractChange | null>();
  for (const delta of state.unpushedDeltas) {
    if (delta.sessionId === selfSessionId && delta.pushedAt === null) {
      changes.set(delta.symbolId.raw, contractChangeFor(delta));
    }
  }

  return changes;
}

export interface DaemonGraph {
  graph: DependencyGraph;
  /** A symbol's dependency-graph neighbors (it imports / is imported by) and
   * their signatures, for caller-aware resolution context. */
  neighborsOf(symbolRaw: string): { symbol: string; signature: string }[];
}

export async function buildDependencyGraph(
  config: RuntimeConfig,
  cache?: AnalysisCache
): Promise<DaemonGraph> {
  // Warm fast path: a clean cached graph under an active watcher skips the
  // recursive source-tree fingerprint scan entirely. Correctness beats cache
  // cleverness: any report or watcher event marks the graph dirty, and
  // without a watcher the flag never clears (fingerprints run every call).
  if (cache?.graph && !cache.graphDirty) {
    cache.onGraphReuse?.();
    return cache.graph.value;
  }

  // Build each language's graph locally, then merge. Symbol ids are
  // language-prefixed (`ts:` / `py:` / `go:`), so the union never collides and the
  // conflict engine sees one graph spanning both.
  const [tsFingerprints, pyFingerprints, goFingerprints] = await Promise.all([
    readSourceFileFingerprints(config.worktreeRoot, isTypeScriptLike),
    readSourceFileFingerprints(config.worktreeRoot, isPythonLike),
    readSourceFileFingerprints(config.worktreeRoot, isGoLike)
  ]);
  const graphFingerprint = sourceSetFingerprint([
    ...tsFingerprints,
    ...pyFingerprints,
    ...goFingerprints
  ]);
  if (cache?.graph?.fingerprint === graphFingerprint) {
    // The scan just proved the cached graph current — under an active
    // watcher the next check can take the fast path above.
    cache.graphDirty = !cache.graphTrusted;
    return cache.graph.value;
  }

  const [tsFiles, pyFiles, goFiles] = await Promise.all([
    readSourceFiles(config.worktreeRoot, isTypeScriptLike),
    readSourceFiles(config.worktreeRoot, isPythonLike),
    readSourceFiles(config.worktreeRoot, isGoLike)
  ]);

  const symbols: CodeSymbol[] = [];
  const edges: { from: ContractDelta["symbolId"]; to: ContractDelta["symbolId"] }[] = [];

  if (tsFiles.length > 0) {
    const tsGraph = extractTypeScriptDependencyGraph({ files: tsFiles });
    symbols.push(...tsGraph.symbols);
    edges.push(...tsGraph.edges);
  }

  if (pyFiles.length > 0) {
    try {
      const pyGraph = await extractPythonDependencyGraph({ files: pyFiles });
      symbols.push(...pyGraph.symbols);
      edges.push(...pyGraph.edges);
    } catch (error) {
      warnAnalyzerDegraded("python", "dependency graph", error);
    }
  }

  if (goFiles.length > 0) {
    try {
      const goGraph = await extractGoDependencyGraph({ files: goFiles });
      symbols.push(...goGraph.symbols);
      edges.push(...goGraph.edges);
    } catch (error) {
      warnAnalyzerDegraded("go", "dependency graph", error);
    }
  }

  if (symbols.length === 0 && edges.length === 0) {
    const empty = { graph: emptyDependencyGraph, neighborsOf: () => [] };
    if (cache) {
      cache.graph = { fingerprint: graphFingerprint, value: empty };
      cache.graphDirty = !cache.graphTrusted;
    }
    return empty;
  }

  const adjacency = new Map<string, ContractDelta["symbolId"][]>();
  const signatureBySymbol = new Map<string, string>();

  for (const symbol of symbols) {
    signatureBySymbol.set(symbol.id.raw, symbol.signature?.raw ?? symbol.name);
  }

  for (const edge of edges) {
    const dependencies = adjacency.get(edge.from.raw) ?? [];
    dependencies.push(edge.to);
    adjacency.set(edge.from.raw, dependencies);
  }

  const neighborsOf = (symbolRaw: string): { symbol: string; signature: string }[] => {
    const related = new Set<string>();
    for (const edge of edges) {
      if (edge.from.raw === symbolRaw) {
        related.add(edge.to.raw);
      } else if (edge.to.raw === symbolRaw) {
        related.add(edge.from.raw);
      }
    }

    return [...related].map((raw) => ({
      symbol: raw,
      signature: signatureBySymbol.get(raw) ?? raw
    }));
  };

  const dependencyGraph: DependencyGraph = {
    dependenciesOf(symbolId, maxHops): DependencyHop[] {
      const result: DependencyHop[] = [];
      const seen = new Set<string>([symbolId.raw]);
      const queue: { symbolId: ContractDelta["symbolId"]; hops: number }[] = [
        { symbolId, hops: 0 }
      ];

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || current.hops >= maxHops) {
          continue;
        }

        for (const dependency of adjacency.get(current.symbolId.raw) ?? []) {
          if (seen.has(dependency.raw)) {
            continue;
          }

          const hops = current.hops + 1;
          seen.add(dependency.raw);
          result.push({ symbolId: dependency, hops });
          queue.push({ symbolId: dependency, hops });
        }
      }

      return result;
    }
  };

  const value = { graph: dependencyGraph, neighborsOf };
  if (cache) {
    cache.graph = { fingerprint: graphFingerprint, value };
    cache.graphDirty = !cache.graphTrusted;
  }
  return value;
}

/**
 * Attach a converged merged-contract resolution to every `contract_divergent`
 * conflict. Order of preference: (1) the server-canonical resolution already
 * stored for this exact `(symbol, inputsHash)` — so both agents read the same
 * object; (2) a freshly generated one from the LLM resolver, validated and then
 * published so it becomes canonical; (3) the engine's deterministic escalate,
 * which is already on `conflict.analysis.resolution`.
 */
export function isTypeScriptLike(filePath: string): boolean {
  // `.cjs` is deliberately excluded: `module.exports` assignments are invisible
  // to the extractor, so treating .cjs as analyzable would silence its changes
  // entirely — the file-level fallback at least reports that the file moved.
  return /\.(cts|mts|tsx?|jsx?|mjs)$/u.test(filePath);
}

export function isPythonLike(filePath: string): boolean {
  return /\.pyi?$/u.test(filePath);
}

export function isGoLike(filePath: string): boolean {
  return /\.go$/u.test(filePath);
}

/** A file Synapse can extract a contract from (any supported analyzer). */
export function isAnalyzable(filePath: string): boolean {
  return isTypeScriptLike(filePath) || isPythonLike(filePath) || isGoLike(filePath);
}

/**
 * Extract a file's contract symbols with the right per-language analyzer.
 * Python runs in the sidecar (tree-sitter + jedi); if it is unavailable
 * (no venv/deps) the call returns `[]`, so callers degrade to file-level
 * detection exactly as they do for an unsupported language.
 */
export async function extractSymbolsForFile(
  config: RuntimeConfig,
  filePath: string,
  cache?: AnalysisCache
): Promise<CodeSymbol[]> {
  const fullPath = await resolveWorktreePath(config.worktreeRoot, filePath);
  const fingerprint = await fileFingerprint(fullPath);
  const cached = cache?.symbolsByFile.get(filePath);
  if (cached?.fingerprint === fingerprint) {
    return cached.symbols;
  }

  const source = await readFile(fullPath, "utf8");

  if (isPythonLike(filePath)) {
    try {
      const symbols = (await extractPythonContracts({ filePath, source })).symbols;
      cache?.symbolsByFile.set(filePath, { fingerprint, symbols });
      return symbols;
    } catch (error) {
      warnAnalyzerDegraded("python", filePath, error);
      return [];
    }
  }

  if (isGoLike(filePath)) {
    try {
      const symbols = (await extractGoContracts({ filePath, source })).symbols;
      cache?.symbolsByFile.set(filePath, { fingerprint, symbols });
      return symbols;
    } catch (error) {
      warnAnalyzerDegraded("go", filePath, error);
      return [];
    }
  }

  const symbols = extractTypeScriptContracts({ filePath, source }).symbols;
  cache?.symbolsByFile.set(filePath, { fingerprint, symbols });
  return symbols;
}

const degradedWarned = new Set<string>();

/** Warn once per language that its analyzer is degraded — keeps logs quiet on repeat. */
export function warnAnalyzerDegraded(lang: string, filePath: string, error: unknown): void {
  if (degradedWarned.has(lang)) {
    return;
  }
  degradedWarned.add(lang);
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(
    `synapse: ${lang} analyzer unavailable (${reason}); falling back to file-level detection for ${filePath}`
  );
}

export async function readSourceFiles(
  root: string,
  matches: (filePath: string) => boolean,
  currentDir: string = root
): Promise<SourceFileContent[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: SourceFileContent[] = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectory(entry.name)) {
        continue;
      }

      files.push(...(await readSourceFiles(root, matches, fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const filePath = normalizePath(relative(root, fullPath));
    if (!matches(filePath)) {
      continue;
    }

    const stats = await stat(fullPath);
    files.push({
      filePath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      source: await readFile(fullPath, "utf8")
    });
  }

  return files;
}

export async function readSourceFileFingerprints(
  root: string,
  matches: (filePath: string) => boolean,
  currentDir: string = root
): Promise<SourceFileFingerprint[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: SourceFileFingerprint[] = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectory(entry.name)) {
        continue;
      }

      files.push(...(await readSourceFileFingerprints(root, matches, fullPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const filePath = normalizePath(relative(root, fullPath));
    if (!matches(filePath)) {
      continue;
    }

    const stats = await stat(fullPath);
    files.push({
      filePath,
      mtimeMs: stats.mtimeMs,
      size: stats.size
    });
  }

  return files;
}

async function fileFingerprint(fullPath: string): Promise<string> {
  const stats = await stat(fullPath);
  return `${stats.mtimeMs}:${stats.size}`;
}

function sourceSetFingerprint(files: SourceFileFingerprint[]): string {
  return files
    .map((file) => `${file.filePath}:${file.mtimeMs}:${file.size}`)
    .sort()
    .join("|");
}

export function ignoredDirectory(name: string): boolean {
  return new Set([
    ".git",
    ".turbo",
    ".synapse",
    "dist",
    "node_modules",
    "coverage",
    // Python: never index virtualenvs, caches, or build output — a venv's
    // site-packages is tens of thousands of files and is not the user's code.
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".tox",
    "site-packages",
    "build"
  ]).has(name);
}
