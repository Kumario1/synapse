import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeSymbol, SymbolChange, SymbolId } from "@synapse/protocol";

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

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Manages the long-lived Go analyzer sidecar (plan M12) and the
 * newline-delimited JSON-RPC channel to it — the same wire protocol and
 * lifecycle as the Python sidecar. Lazily started on first use, restarted
 * automatically if it dies, shut down via {@link closeGoAnalyzer}.
 *
 * Any failure to start (binary not built, no Go toolchain ever ran
 * `setup-go.mjs`) surfaces as a rejected request so the daemon degrades to
 * file-level detection instead of breaking.
 */
class GoSidecar {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  private resolveBinary(): string {
    const override = process.env.SYNAPSE_GO_ANALYZER_BIN;
    if (override && existsSync(override)) {
      return override;
    }
    const isWindows = process.platform === "win32";
    return join(packageRoot, "bin", isWindows ? "synapse-analyzer-go.exe" : "synapse-analyzer-go");
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) {
      return this.child;
    }

    const child = spawn(this.resolveBinary(), [], {
      cwd: packageRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.on("exit", (code) => this.onExit(code));
    child.on("error", (error) => this.failAll(error));

    this.child = child;
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        this.onMessage(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private onMessage(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? "go analyzer error"));
    } else {
      pending.resolve(message.result);
    }
  }

  private onExit(code: number | null): void {
    this.child = null;
    this.buffer = "";
    if (this.pending.size > 0) {
      this.failAll(new Error(`go analyzer exited (code ${code ?? "unknown"})`));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const child = this.ensureStarted();
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      child.stdin.write(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  close(): void {
    if (this.child && !this.child.killed) {
      this.child.stdin.end();
      this.child.kill();
    }
    this.failAll(new Error("go analyzer closed"));
    this.child = null;
  }
}

let sidecar: GoSidecar | null = null;

function getSidecar(): GoSidecar {
  if (!sidecar) {
    sidecar = new GoSidecar();
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
 * Structural contract diff over two symbol sets. Language-neutral — identical
 * to the TypeScript/Python analyzers' diff — so a Go change flows through the
 * same conflict engine.
 */
export function diffGoContracts(before: CodeSymbol[], after: CodeSymbol[]): SymbolChange[] {
  const beforeById = bySymbolId(before);
  const afterById = bySymbolId(after);
  const changes: SymbolChange[] = [];

  for (const [raw, beforeSymbol] of beforeById) {
    const afterSymbol = afterById.get(raw);
    if (!afterSymbol) {
      changes.push({ symbolId: beforeSymbol.id, changeKind: "removed", before: beforeSymbol, after: null });
      continue;
    }
    if (beforeSymbol.visibility !== afterSymbol.visibility) {
      changes.push({
        symbolId: beforeSymbol.id,
        changeKind: "visibility_changed",
        before: beforeSymbol,
        after: afterSymbol
      });
      continue;
    }
    if (beforeSymbol.sigHash !== afterSymbol.sigHash) {
      changes.push({
        symbolId: beforeSymbol.id,
        changeKind: "signature_changed",
        before: beforeSymbol,
        after: afterSymbol
      });
    }
  }

  for (const [raw, afterSymbol] of afterById) {
    if (!beforeById.has(raw)) {
      changes.push({ symbolId: afterSymbol.id, changeKind: "added", before: null, after: afterSymbol });
    }
  }

  return changes.sort((a, b) => a.symbolId.raw.localeCompare(b.symbolId.raw));
}

/** Shut down the shared sidecar (tests, daemon shutdown). */
export function closeGoAnalyzer(): void {
  if (sidecar) {
    sidecar.close();
    sidecar = null;
  }
}

function bySymbolId(symbols: CodeSymbol[]): Map<string, CodeSymbol> {
  return new Map(symbols.map((symbol) => [symbol.id.raw, symbol]));
}
