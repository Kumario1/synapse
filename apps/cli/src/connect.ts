import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderCommandCatalogMarkdown } from "@synapse/protocol";

/** The key Synapse registers itself under in every MCP client config. */
export const SYNAPSE_MCP_SERVER_KEY = "synapse";

/**
 * The single source of truth for "how an agent should use Synapse". This is the
 * cross-agent equivalent of the Claude Code `PreToolUse` / `PostToolUse` /
 * `SessionStart` hooks: agents that cannot run those hooks read this guidance —
 * surfaced both as the MCP server's `instructions` and as on-disk rules files —
 * and call the matching tools at the same moments the hooks would fire.
 */
export const SYNAPSE_AGENT_GUIDANCE = `Synapse is a realtime coordination layer that stops your edits from colliding with other agents and teammates working the same repository. Use these MCP tools automatically — do not wait to be asked. This mirrors the Claude Code PreToolUse/PostToolUse/SessionStart hooks for agents that do not run those hooks.

For passive context, prefer MCP resources when your client exposes them: read \`synapse://briefing\` for the onboarding/team digest, \`synapse://team-state\` for current sessions, locks, deltas, pushes, and resolutions, and \`synapse://decisions\` for recent cited decisions and memories. Use tools for actions, checks, and context that needs arguments.

1. SESSION START — at the start of a task, read \`synapse://briefing\` if resources are available; otherwise call \`synapse_whatsup\` once to get a team catch-up: recent pushes, teammates' unpushed contract changes, edit locks, and recent session summaries. (Equivalent to the SessionStart hook.)
2. BEFORE EDITING — before you create, edit, or refactor a file, call \`synapse_check\` with that file (and the symbol(s) you intend to change). If another live session already holds the same symbol's edit lock (\`same_symbol_active\`), do not edit until the lock clears or the human redirects you. All other conflicts stay advisory: surface them to the user and decide together before proceeding. (Equivalent to the PreToolUse hook on Edit/Write/MultiEdit.)
3. AFTER EDITING — immediately after you finish writing a file, call \`synapse_report\` with that file path so your contract-level changes broadcast to the rest of the team. (Equivalent to the PostToolUse hook.)
4. AFTER PUSHING — after you commit or push, call \`synapse_push\` with the affected files and the sha so shared state can clear stale deltas and edit locks.
5. FEEDBACK (optional) — call \`synapse_feedback\` to record whether a surfaced conflict was acted on or dismissed; this is telemetry only and never changes verdicts.
6. WHEN YOU NEED CONTEXT — Synapse is also your team memory; query it instead of guessing. If a check surfaces a conflict you don't understand, or you wonder why a contract looks the way it does, call \`synapse_why\` with a plain-language question — it searches durable team history and answers with cited sources. On your FIRST session in a repository, call \`synapse_onboard\` once instead of \`synapse_whatsup\` for a deep briefing: the full team digest plus the room's cited decision history.

Conflict analyses may include \`actions[].command\`, a suggested next Synapse tool call for resolving that specific conflict — when present, prefer making that exact call next.

Command reference (every Synapse tool, with its CLI form):
${renderCommandCatalogMarkdown()}

Identity (repoId, sessionId, daemon port) resolves automatically from \`.synapse/config.json\`, so you usually do not need to pass it.`;

const MANAGED_BEGIN = "<!-- BEGIN SYNAPSE (managed by `synapse connect`) -->";
const MANAGED_END = "<!-- END SYNAPSE (managed by `synapse connect`) -->";

export interface ConnectOptions {
  /** Repository root to write integration files into. */
  repoDir: string;
  /** Absolute path to the Synapse CLI entrypoint, embedded in the MCP command. */
  cliEntrypoint: string;
  /** Restrict to these integration ids; empty/undefined writes every integration. */
  only?: string[];
}

export interface ConnectResult {
  id: string;
  label: string;
  kind: "mcp" | "rules";
  /** Repo-relative path of the file written. */
  path: string;
  status: "wrote" | "updated" | "unchanged";
}

interface ApplyContext {
  /** Executable the agent launches for the stdio MCP server (always `node`). */
  command: string;
  /** Arguments after the executable, e.g. [<cli entrypoint>, "mcp"]. */
  args: string[];
}

interface Integration {
  id: string;
  label: string;
  kind: "mcp" | "rules";
  /** Repo-relative file path. */
  file: string;
  /** Merge our config into the file's prior contents (null when absent). */
  apply(existing: string | null, ctx: ApplyContext): string;
}

/**
 * The agents Synapse can wire up. Each entry either registers the stdio MCP
 * server in that client's config (so connecting is one command, never manual
 * JSON surgery) or drops a rules file carrying {@link SYNAPSE_AGENT_GUIDANCE}.
 * Every `apply` is idempotent and preserves unrelated content.
 */
const INTEGRATIONS: Integration[] = [
  {
    id: "cursor",
    label: "Cursor (MCP server)",
    kind: "mcp",
    file: ".cursor/mcp.json",
    apply: (existing, ctx) => mergeMcpServers(existing, ctx, "mcpServers")
  },
  {
    id: "cursor",
    label: "Cursor (project rule)",
    kind: "rules",
    file: ".cursor/rules/synapse.mdc",
    apply: () => cursorRule()
  },
  {
    id: "vscode",
    label: "VS Code / Copilot (MCP server)",
    kind: "mcp",
    file: ".vscode/mcp.json",
    apply: (existing, ctx) => mergeMcpServers(existing, ctx, "servers", { type: "stdio" })
  },
  {
    id: "mcp",
    label: "Claude Code & generic MCP clients (project MCP server)",
    kind: "mcp",
    file: ".mcp.json",
    apply: (existing, ctx) => mergeMcpServers(existing, ctx, "mcpServers")
  },
  {
    id: "gemini",
    label: "Gemini CLI (MCP server)",
    kind: "mcp",
    file: ".gemini/settings.json",
    apply: (existing, ctx) => mergeMcpServers(existing, ctx, "mcpServers")
  },
  {
    id: "windsurf",
    label: "Windsurf (workspace rule)",
    kind: "rules",
    file: ".windsurf/rules/synapse.md",
    apply: (existing) => upsertManagedBlock(existing, markdownBlock())
  },
  {
    id: "agents",
    label: "AGENTS.md (cross-agent guidance)",
    kind: "rules",
    file: "AGENTS.md",
    apply: (existing) => upsertManagedBlock(existing, markdownBlock())
  }
];

/** All integration ids, de-duplicated, in declaration order. */
export function integrationIds(): string[] {
  return [...new Set(INTEGRATIONS.map((entry) => entry.id))];
}

/**
 * Wire the requested agents up to the local Synapse MCP server. Writes each
 * integration's config/rules file under `repoDir`, skipping files that are
 * already current. Returns one {@link ConnectResult} per file considered.
 */
export async function connectAgents(options: ConnectOptions): Promise<ConnectResult[]> {
  const ctx: ApplyContext = {
    command: "node",
    args: [options.cliEntrypoint, "mcp"]
  };

  const selected = options.only?.length
    ? INTEGRATIONS.filter((entry) => options.only?.includes(entry.id))
    : INTEGRATIONS;

  const results: ConnectResult[] = [];
  for (const integration of selected) {
    const absolute = join(options.repoDir, integration.file);
    const existing = await readFileOrNull(absolute);
    const next = ensureTrailingNewline(integration.apply(existing, ctx));

    let status: ConnectResult["status"];
    if (existing === null) {
      status = "wrote";
    } else if (existing === next) {
      status = "unchanged";
    } else {
      status = "updated";
    }

    if (status !== "unchanged") {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, next);
    }

    results.push({
      id: integration.id,
      label: integration.label,
      kind: integration.kind,
      path: integration.file,
      status
    });
  }

  return results;
}

/**
 * Merge the Synapse stdio server into a JSON MCP config without disturbing other
 * servers. `shapeKey` is the wrapper VS Code uses `servers`, everyone else
 * `mcpServers`; `extra` carries client-specific fields (VS Code wants `type`).
 */
function mergeMcpServers(
  existing: string | null,
  ctx: ApplyContext,
  shapeKey: "mcpServers" | "servers",
  extra: Record<string, unknown> = {}
): string {
  const root = parseJsonObject(existing);
  const servers = isRecord(root[shapeKey]) ? { ...(root[shapeKey] as Record<string, unknown>) } : {};

  servers[SYNAPSE_MCP_SERVER_KEY] = {
    ...extra,
    command: ctx.command,
    args: [...ctx.args]
  };

  root[shapeKey] = servers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** A Cursor `.mdc` rule file is wholly Synapse-owned, so we overwrite it. */
function cursorRule(): string {
  return `---
description: Synapse realtime coordination — query before edits, report after
alwaysApply: true
---

${SYNAPSE_AGENT_GUIDANCE}
`;
}

/** The shared markdown body inserted into AGENTS.md / Windsurf rules. */
function markdownBlock(): string {
  return `## Synapse — realtime team coordination

${SYNAPSE_AGENT_GUIDANCE}`;
}

/**
 * Insert or replace our managed block inside a possibly user-authored markdown
 * file, leaving everything outside the markers untouched. Idempotent.
 */
function upsertManagedBlock(existing: string | null, body: string): string {
  const block = `${MANAGED_BEGIN}\n${body}\n${MANAGED_END}`;
  if (existing === null || existing.trim() === "") {
    return `${block}\n`;
  }

  const begin = existing.indexOf(MANAGED_BEGIN);
  const end = existing.indexOf(MANAGED_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + MANAGED_END.length);
    return `${before}${block}${after}`;
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${block}\n`;
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw || raw.trim() === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? { ...parsed } : {};
  } catch {
    // A malformed config is replaced rather than silently corrupted further.
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
