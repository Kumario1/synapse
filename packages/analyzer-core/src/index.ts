import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CodeSymbol, SymbolChange } from "@synapse/protocol";

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

function analyzerRequestTimeoutMs(): number {
  const raw = process.env.SYNAPSE_ANALYZER_REQUEST_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  const timeoutMs = Number.parseInt(raw, 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** How to launch a language-analyzer sidecar process and label its errors. */
export interface SidecarConfig {
  /** Resolve the executable to spawn, at start time (e.g. a venv python, a built binary). */
  command: () => string;
  /** Arguments passed to the executable. */
  args: string[];
  /** Working directory for the child process. */
  cwd: string;
  /** Short language label used in error messages, e.g. "python" or "go". */
  label: string;
}

/**
 * Manages a long-lived language-analyzer sidecar process and the
 * newline-delimited JSON-RPC channel to it. Lazily started on first request,
 * restarted automatically if it dies, and shut down via {@link close}.
 *
 * Any failure to start (missing toolchain/deps/binary) surfaces as a rejected
 * request so the daemon can degrade to file-level detection instead of breaking.
 * The Python and Go analyzers share this transport; only the spawn config and
 * the error label differ.
 */
export class Sidecar {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly config: SidecarConfig) {}

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) {
      return this.child;
    }

    const child = spawn(this.config.command(), this.config.args, {
      cwd: this.config.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.on("exit", (code) => this.onExit(child, code));
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
    const pending = this.clearPending(message.id);
    if (!pending) {
      return;
    }
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `${this.config.label} analyzer error`));
    } else {
      pending.resolve(message.result);
    }
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.child === child) {
      this.child = null;
      this.buffer = "";
    }
    if (this.pending.size > 0) {
      this.failAll(new Error(`${this.config.label} analyzer exited (code ${code ?? "unknown"})`));
    }
  }

  private clearPending(id: number): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
    }
    return pending;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  // Returns the raw JSON-RPC `result` as `unknown` on purpose: a sidecar reply
  // is untrusted subprocess output, so the caller must validate it at its trust
  // boundary (see @synapse/protocol parseExtracted*). Casting to a `T` here
  // would silently inject malformed data into the symbol graph.
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.ensureStarted();
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = analyzerRequestTimeoutMs();
      const timer = setTimeout(() => {
        const pending = this.clearPending(id);
        if (!pending) {
          return;
        }
        pending.reject(
          new Error(
            `${this.config.label} analyzer request timed out (method ${method}, id ${id}, timeout ${timeoutMs}ms)`
          )
        );
        if (this.child === child) {
          this.child = null;
          this.buffer = "";
        }
        child.kill();
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(payload, (error) => {
        if (error) {
          const pending = this.clearPending(id);
          if (pending) {
            pending.reject(error);
          }
        }
      });
    });
  }

  close(): void {
    if (this.child && !this.child.killed) {
      this.child.stdin.end();
      this.child.kill();
    }
    this.failAll(new Error(`${this.config.label} analyzer closed`));
    this.child = null;
  }
}

/**
 * Structural contract diff over two symbol sets. Language-neutral: removals,
 * visibility changes, and `sigHash` deltas become `SymbolChange`s; additions are
 * reported too. Shared by the Python and Go analyzers so their changes flow
 * through the same conflict engine. (The TypeScript analyzer layers
 * rename-pairing on top and keeps its own diff.)
 */
export function diffContracts(before: CodeSymbol[], after: CodeSymbol[]): SymbolChange[] {
  const beforeById = bySymbolId(before);
  const afterById = bySymbolId(after);
  const changes: SymbolChange[] = [];

  for (const [raw, beforeSymbol] of beforeById) {
    const afterSymbol = afterById.get(raw);
    if (!afterSymbol) {
      changes.push({
        symbolId: beforeSymbol.id,
        changeKind: "removed",
        before: beforeSymbol,
        after: null
      });
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
      changes.push({
        symbolId: afterSymbol.id,
        changeKind: "added",
        before: null,
        after: afterSymbol
      });
    }
  }

  return changes.sort((a, b) => a.symbolId.raw.localeCompare(b.symbolId.raw));
}

function bySymbolId(symbols: CodeSymbol[]): Map<string, CodeSymbol> {
  return new Map(symbols.map((symbol) => [symbol.id.raw, symbol]));
}
