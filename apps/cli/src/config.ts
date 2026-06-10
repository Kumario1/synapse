import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentType } from "@synapse/protocol";
import { normalizeRemoteUrl } from "./identity.js";

/**
 * Absolute path to this CLI's entrypoint (`dist/index.js`), for embedding in
 * hook commands and locating the package root. Resolved as a sibling of this
 * compiled module so it stays correct from any importer.
 */
export function cliEntrypoint(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

export interface RuntimeConfig {
  repoId: string;
  member: string;
  sessionId: string;
  agentType: AgentType;
  daemonPort: number;
  serverUrl: string;
  worktreeRoot: string;
  /** Shared auth token for the server, if the server requires one. */
  authToken: string;
}

interface LocalConfig {
  repoId?: string;
  member?: string;
  sessionId?: string;
  agentType?: AgentType;
  daemonPort?: number;
  serverUrl?: string;
  worktreeRoot?: string;
}

/** Committed, shared, non-secret team config (`.synapse/team.json`). */
interface TeamConfig {
  schemaVersion?: number;
  serverUrl?: string;
  repoId?: string;
}

/** Merge updates into the committed `.synapse/team.json` (read-merge-write). */
export async function writeTeamConfig(update: { serverUrl?: string; repoId?: string }): Promise<void> {
  const dir = join(commandCwd(), ".synapse");
  await mkdir(dir, { recursive: true });
  const existing = readTeamConfig();
  const merged: TeamConfig = {
    schemaVersion: 1,
    serverUrl: update.serverUrl ?? existing.serverUrl,
    repoId: update.repoId ?? existing.repoId
  };
  await writeFile(
    join(dir, "team.json"),
    `${JSON.stringify(omitUndefined(merged), null, 2)}\n`
  );
  console.log(`wrote ${join(dir, "team.json")} (commit this so teammates inherit the server URL)`);
}

function omitUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

/**
 * The name in this CLI's own package.json. `@synapse/cli` when running from the
 * monorepo; the published package name when installed from npm.
 */
export function ownPackageName(): string {
  try {
    const packageRoot = dirname(dirname(cliEntrypoint()));
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      name?: string;
    };
    return manifest.name ?? "@synapse/cli";
  } catch {
    return "@synapse/cli";
  }
}

export function configFromArgs(rawArgs: string[]): RuntimeConfig {
  const flags = parseFlags(rawArgs);
  const localConfig = readLocalConfig();
  const teamConfig = readTeamConfig();
  const member =
    flags.member ?? process.env.SYNAPSE_MEMBER ?? localConfig.member ?? gitMember();

  return {
    repoId:
      flags["repo-id"] ??
      process.env.SYNAPSE_REPO_ID ??
      localConfig.repoId ??
      teamConfig.repoId ??
      (gitRepoId() || "local"),
    member,
    sessionId:
      flags.session ??
      process.env.SYNAPSE_SESSION_ID ??
      localConfig.sessionId ??
      `${member}-${randomUUID()}`,
    agentType: agentType(flags.agent ?? process.env.SYNAPSE_AGENT ?? localConfig.agentType ?? "other"),
    daemonPort: numberDefault(flags.port, process.env.SYNAPSE_DAEMON_PORT, localConfig.daemonPort, 4011),
    serverUrl:
      flags.server ??
      process.env.SYNAPSE_SERVER_URL ??
      localConfig.serverUrl ??
      teamConfig.serverUrl ??
      "ws://localhost:4010",
    worktreeRoot: resolve(
      flags["worktree-root"] ??
        process.env.SYNAPSE_WORKTREE_ROOT ??
        localConfig.worktreeRoot ??
        gitWorktreeRoot()
    ),
    // Sourced from flag/env only — never persisted to .synapse/config.json so a
    // secret credential does not land on disk. A project key (--key /
    // SYNAPSE_PROJECT_KEY) and a shared token (--token / SYNAPSE_AUTH_TOKEN) both
    // ride this field; the server decides which it is by its own auth mode.
    authToken:
      flags.key ??
      process.env.SYNAPSE_PROJECT_KEY ??
      flags.token ??
      process.env.SYNAPSE_AUTH_TOKEN ??
      ""
  };
}

export function commandDefaults(flags: Record<string, string>): {
  repoId: string;
  sessionId: string;
  daemonPort: number;
} {
  const localConfig = readLocalConfig();
  const teamConfig = readTeamConfig();

  return {
    // Same chain as configFromArgs so the hook-driven check/report resolve the
    // exact room the daemon joined. `.synapse/config.json` (written by join/up)
    // carries repoId, so the hot path never shells out to git in steady state.
    repoId:
      flags["repo-id"] ??
      process.env.SYNAPSE_REPO_ID ??
      localConfig.repoId ??
      teamConfig.repoId ??
      (gitRepoId() || "local"),
    sessionId: flags.session ?? process.env.SYNAPSE_SESSION_ID ?? localConfig.sessionId ?? "local",
    daemonPort: numberDefault(flags.port, process.env.SYNAPSE_DAEMON_PORT, localConfig.daemonPort, 4011)
  };
}

/** Run a read-only git command from the command cwd; "" on any failure. */
function git(gitArgs: string[]): string {
  try {
    const result = spawnSync("git", gitArgs, {
      cwd: commandCwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return result.status === 0 ? (result.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

/**
 * Canonical `host/owner/repo` slug from the git origin remote (falling back to
 * the first remote), or "" when there is no usable remote. This is what lets two
 * clones of the same repo share a coordination room with zero configuration.
 */
function gitRepoId(): string {
  const origin = git(["config", "--get", "remote.origin.url"]);
  const url = origin || firstRemoteUrl();
  return url ? normalizeRemoteUrl(url) : "";
}

function firstRemoteUrl(): string {
  const remotes = git(["remote"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return remotes.length > 0 ? git(["config", "--get", `remote.${remotes[0]}.url`]) : "";
}

/** The git worktree root, or the command cwd when not inside a git tree. */
function gitWorktreeRoot(): string {
  return git(["rev-parse", "--show-toplevel"]) || commandCwd();
}

/**
 * The current branch of the daemon's worktree (the `git rev-parse --abbrev-ref
 * HEAD` answer), or undefined when unknown: detached HEAD, not a git repo, or
 * an unreadable layout. Reads `.git/HEAD` directly instead of spawning git
 * because this also runs on the `synapse_check` hot path (p95 ≤ 50ms budget),
 * and it must resolve against `worktreeRoot` — not the command cwd, which for
 * a daemon can be a different directory entirely.
 */
export function currentGitBranch(worktreeRoot: string): string | undefined {
  try {
    const dotGit = resolve(worktreeRoot, ".git");
    let gitDir = dotGit;

    if (statSync(dotGit).isFile()) {
      // Linked worktree/submodule: `.git` is a pointer file, `gitdir: <path>`.
      const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(dotGit, "utf8"));
      if (!pointer) {
        return undefined;
      }
      gitDir = resolve(worktreeRoot, pointer[1]);
    }

    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/u.exec(head);
    return ref ? ref[1] : undefined;
  } catch {
    return undefined;
  }
}

/** Best display name for this member: git identity, then $USER, then "local". */
function gitMember(): string {
  return (
    git(["config", "user.name"]) ||
    git(["config", "user.email"]) ||
    process.env.USER ||
    "local"
  );
}

export function readLocalConfig(): LocalConfig {
  const path = join(commandCwd(), ".synapse", "config.json");
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }

  const rawAgentType = stringValue(parsed.agentType);

  return {
    repoId: stringValue(parsed.repoId),
    member: stringValue(parsed.member),
    sessionId: stringValue(parsed.sessionId),
    agentType: rawAgentType ? agentType(rawAgentType) : undefined,
    daemonPort: numberValue(parsed.daemonPort),
    serverUrl: stringValue(parsed.serverUrl),
    worktreeRoot: stringValue(parsed.worktreeRoot)
  };
}

/**
 * Read `.synapse/team.json` — the committed, shared, non-secret team config that
 * carries the coordination server URL (and optional repoId) so a teammate
 * inherits them on checkout. A missing file is fine (returns {}); a malformed
 * committed file is loud (rethrows) so the team notices a bad commit.
 */
function readTeamConfig(): TeamConfig {
  const path = join(commandCwd(), ".synapse", "team.json");
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }

  return {
    schemaVersion: numberValue(parsed.schemaVersion),
    serverUrl: stringValue(parsed.serverUrl),
    repoId: stringValue(parsed.repoId)
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function numberDefault(...values: Array<number | string | undefined>): number {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  throw new Error("missing numeric default");
}

export function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

export function parseFlags(rawArgs: string[]): Record<string, string> {
  const flags: Record<string, string> = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg?.startsWith("--")) {
      continue;
    }

    const name = arg.slice(2);
    const next = rawArgs[index + 1];
    if (!next || next.startsWith("--")) {
      flags[name] = "true";
      continue;
    }

    flags[name] = next;
    index += 1;
  }

  return flags;
}

export function requiredFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) {
    throw new Error(`--${name} is required`);
  }

  return value;
}

export function filesFromFlags(flags: Record<string, string>): string[] {
  const values = [flags.file, flags.files].filter((value): value is string => Boolean(value));
  return values.flatMap((value) =>
    value
      .split(",")
      .map((file) => file.trim())
      .filter(Boolean)
  );
}

export function agentType(value: string): AgentType {
  const allowed = new Set<AgentType>(["claude-code", "cursor", "cline", "aider", "other"]);
  return allowed.has(value as AgentType) ? (value as AgentType) : "other";
}

export function commandCwd(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

