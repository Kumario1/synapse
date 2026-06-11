import { relative } from "node:path";
import { watch } from "chokidar";
import { ignoredDirectory } from "./analysis.js";
import { normalizePath } from "./config.js";

/**
 * File watcher (plan M10, spec §1): the daemon only learns about edits an
 * agent reports — manual edits between agent turns were invisible. Watching
 * the worktree closes that gap: a changed file flows through the exact same
 * report path as `synapse_report`, so manual edits emit contract deltas with
 * no agent involvement.
 *
 * Scope mirrors the analyzer's source scan (the same ignored-directory set —
 * node_modules, .git, venvs, build output — that approximates .gitignore
 * everywhere else in the product), and only files the caller deems reportable
 * (analyzable sources) are forwarded. Events are debounced per file so a
 * save-burst becomes one report. `SYNAPSE_FILE_WATCHER=0` disables.
 */
export interface FileWatcherOptions {
  worktreeRoot: string;
  /** Per-file quiet window before a change is reported. */
  debounceMs: number;
  /** Only paths this returns true for are reported (e.g. analyzable files). */
  shouldReport: (relativePath: string) => boolean;
  onChange: (relativePath: string) => Promise<void>;
  onError: (error: unknown) => void;
}

export interface FileWatcher {
  close(): Promise<void>;
}

export function startFileWatcher(options: FileWatcherOptions): FileWatcher {
  const timers = new Map<string, NodeJS.Timeout>();

  const watcher = watch(options.worktreeRoot, {
    ignoreInitial: true,
    ignored: (path: string) =>
      relative(options.worktreeRoot, path)
        .split(/[\\/]/u)
        .some((segment) => ignoredDirectory(segment))
  });

  const schedule = (absolutePath: string): void => {
    const relativePath = normalizePath(relative(options.worktreeRoot, absolutePath));
    if (!relativePath || relativePath.startsWith("..") || !options.shouldReport(relativePath)) {
      return;
    }

    const existing = timers.get(relativePath);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      timers.delete(relativePath);
      void options.onChange(relativePath).catch(options.onError);
    }, options.debounceMs);
    timer.unref();
    timers.set(relativePath, timer);
  };

  watcher.on("add", schedule);
  watcher.on("change", schedule);
  watcher.on("error", options.onError);

  return {
    close: async () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      await watcher.close();
    }
  };
}
