import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ConflictAction, SynapseCheckResponse, SynapseWhatsupResponse } from "@synapse/protocol";
import { SYNAPSE_COMMAND_CATALOG } from "@synapse/protocol";
import { sessionStartBriefing } from "./briefings.js";
import {
  cliEntrypoint,
  commandCwd,
  commandDefaults,
  normalizePath,
  readLocalConfig
} from "./config.js";
import { postJson } from "./http.js";

/** The shell command Claude Code runs for a given hook stage. */
function hookCommand(stage: "pre" | "post" | "session-start" | "user-prompt"): string {
  return `node "${cliEntrypoint()}" hook ${stage}`;
}

/**
 * Merge Synapse's `PreToolUse`/`PostToolUse` hooks into the repo's
 * `.claude/settings.json` without disturbing existing hooks. Idempotent: a
 * re-join does not duplicate the entries.
 */
export async function installClaudeCodeHooks(repoDir: string): Promise<void> {
  const settingsDir = join(repoDir, ".claude");
  const settingsPath = join(settingsDir, "settings.json");
  await mkdir(settingsDir, { recursive: true });

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      console.warn(`synapse: could not read ${settingsPath}; leaving Claude Code hooks uninstalled.`);
      return;
    }
  }

  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const editMatcher = "Edit|Write|MultiEdit";
  const startMatcher = "startup|resume|clear";

  settings.hooks = {
    ...hooks,
    PreToolUse: withSynapseHook(hooks.PreToolUse, editMatcher, hookCommand("pre"), "pre"),
    PostToolUse: withSynapseHook(hooks.PostToolUse, editMatcher, hookCommand("post"), "post"),
    SessionStart: withSynapseHook(
      hooks.SessionStart,
      startMatcher,
      hookCommand("session-start"),
      "session-start"
    ),
    UserPromptSubmit: withSynapseHookNoMatcher(
      hooks.UserPromptSubmit,
      hookCommand("user-prompt"),
      "user-prompt"
    )
  };

  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`installed Claude Code hooks in ${settingsPath}`);
}

interface HookEntry {
  matcher?: string;
  hooks?: { type: string; command: string }[];
}

/**
 * Return the event's matcher groups with our `synapse hook` command ensured
 * present exactly once under `matcher`, preserving any other groups/commands.
 */
function withSynapseHook(
  existing: unknown,
  matcher: string,
  command: string,
  stage: "pre" | "post" | "session-start"
): HookEntry[] {
  const groups: HookEntry[] = Array.isArray(existing) ? (existing as HookEntry[]).map(cloneEntry) : [];

  // Identify our command for this stage regardless of the embedded absolute path.
  const isOurStage = (value: string): boolean => new RegExp(`\\bhook ${stage}\\b`, "u").test(value);

  let group = groups.find((entry) => entry.matcher === matcher);
  if (!group) {
    group = { matcher, hooks: [] };
    groups.push(group);
  }
  group.hooks ??= [];

  // Drop any prior Synapse command for this stage (handles a moved CLI path),
  // then add the current one. Non-Synapse hooks are untouched.
  group.hooks = group.hooks.filter((hook) => !isOurStage(hook.command));
  group.hooks.push({ type: "command", command });

  return groups;
}

function cloneEntry(entry: HookEntry): HookEntry {
  return { ...entry, hooks: entry.hooks ? entry.hooks.map((hook) => ({ ...hook })) : undefined };
}

interface NoMatcherHookEntry {
  hooks?: { type: string; command: string }[];
}

/**
 * Like {@link withSynapseHook}, but for events that take no `matcher`
 * (`UserPromptSubmit`): a single group of `{ hooks: [...] }`. Idempotent —
 * identifies our command for this stage, drops prior copies (handles a moved
 * CLI path), and preserves any other non-Synapse hooks for the event.
 */
function withSynapseHookNoMatcher(
  existing: unknown,
  command: string,
  stage: "user-prompt"
): NoMatcherHookEntry[] {
  const groups: NoMatcherHookEntry[] = Array.isArray(existing)
    ? (existing as NoMatcherHookEntry[]).map((entry) => ({
        ...entry,
        hooks: entry.hooks ? entry.hooks.map((hook) => ({ ...hook })) : undefined
      }))
    : [];

  // Identify our command for this stage regardless of the embedded absolute path.
  const isOurStage = (value: string): boolean => new RegExp(`\\bhook ${stage}\\b`, "u").test(value);

  let group = groups[0];
  if (!group) {
    group = { hooks: [] };
    groups.push(group);
  }
  group.hooks ??= [];

  // Drop any prior Synapse command for this stage, then add the current one.
  // Non-Synapse hooks are untouched.
  group.hooks = group.hooks.filter((hook) => !isOurStage(hook.command));
  group.hooks.push({ type: "command", command });

  return groups;
}

/**
 * Claude Code hook entrypoint. Invoked by `.claude/settings.json` before
 * (`pre`) and after (`post`) Edit/Write/MultiEdit. Reads the hook JSON on
 * stdin, maps the target file to a repo-relative path, and talks to the local
 * daemon. It must NEVER break the agent: any error, a missing daemon, or an
 * out-of-tree file exits 0 with no decision.
 */
export async function runHook(rawArgs: string[]): Promise<void> {
  const stage = hookStage(rawArgs[0]);
  try {
    const input = parseHookInput(await readStdin());
    const defaults = commandDefaults({});
    const baseUrl = `http://localhost:${defaults.daemonPort}`;

    if (stage === "session-start") {
      await runSessionStartHook(baseUrl, defaults);
      return;
    }

    if (stage === "user-prompt") {
      await runUserPromptHook(baseUrl, defaults, input);
      return;
    }

    const filePath = hookRelativePath(input);
    if (!filePath) {
      return; // Not a file edit we can map — stay silent.
    }

    if (stage === "post") {
      await postJson(`${baseUrl}/tools/synapse_report`, {
        repoId: defaults.repoId,
        sessionId: defaults.sessionId,
        filePath
      }).catch(() => undefined);
      return;
    }

    const result = (await postJson(`${baseUrl}/tools/synapse_check`, {
      repoId: defaults.repoId,
      sessionId: defaults.sessionId,
      files: [filePath]
    }).catch(() => null)) as SynapseCheckResponse | null;

    if (result && result.verdict !== "none" && result.conflicts.length > 0) {
      process.stdout.write(`${JSON.stringify(preToolUseDecision(filePath, result))}\n`);
    }
  } catch {
    // Swallow everything — a hook must not interrupt or fail the edit.
  }
}

function hookStage(value: string | undefined): "pre" | "post" | "session-start" | "user-prompt" {
  if (value === "post") {
    return "post";
  }
  if (value === "session-start") {
    return "session-start";
  }
  if (value === "user-prompt") {
    return "user-prompt";
  }
  return "pre";
}

/**
 * SessionStart hook: greet a starting session with a catch-up on what changed
 * while it was away — recent pushes, teammates' unpushed contract changes, and
 * recent session summaries — injected as Claude Code context. Silent when there
 * is nothing new or the daemon is unreachable.
 */
async function runSessionStartHook(
  baseUrl: string,
  defaults: { repoId: string; sessionId: string }
): Promise<void> {
  const briefing = (await postJson(`${baseUrl}/tools/synapse_whatsup`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId
  }).catch(() => null)) as SynapseWhatsupResponse | null;
  if (!briefing) {
    return;
  }

  const context = sessionStartBriefing(briefing, defaults.sessionId);
  if (!context) {
    return; // All caught up — stay silent.
  }

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context }
    })}\n`
  );
}

/**
 * UserPromptSubmit hook: record the developer's prompt as this session's task so
 * teammates' briefings describe intent, not just file churn. Best-effort and
 * silent — never writes to stdout (the prompt proceeds unchanged) and never
 * throws. SYNAPSE_TASK_CAPTURE=0 disables it.
 */
async function runUserPromptHook(
  baseUrl: string,
  defaults: { repoId: string; sessionId: string },
  input: HookInput
): Promise<void> {
  if (process.env.SYNAPSE_TASK_CAPTURE === "0") {
    return;
  }
  const task = (input.prompt ?? "").replace(/\s+/gu, " ").trim().slice(0, 200);
  if (!task) {
    return;
  }
  await postJson(`${baseUrl}/tools/synapse_session`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    action: "heartbeat",
    task
  }).catch(() => undefined);
}

/**
 * Build the Claude Code `PreToolUse` response that surfaces a conflict. Default
 * is `ask` so the developer decides (proceed/adjust/ping) — the "agents query,
 * humans decide" principle — never an auto-block. Set `SYNAPSE_HOOK_NONBLOCKING=1`
 * to instead inject the heads-up as context and proceed without a prompt.
 */
function preToolUseDecision(filePath: string, result: SynapseCheckResponse): unknown {
  const heading = `⚠ Synapse: ${result.conflicts.length} potential conflict(s) before editing ${filePath}`;
  const lines = result.conflicts.flatMap((conflict, index) => {
    const who = conflict.counterpart.memberLogin;
    const detail = conflict.analysis?.assessment ?? conflict.detail;
    const next = conflict.suggestion ? ` → ${conflict.suggestion}` : "";
    const line = `• [${conflict.rule}] ${detail} (with ${who})${next}`;

    // Keep the message compact for the permission prompt: only the first 3
    // conflicts get the extra command-suggestion line(s).
    if (index >= 3) {
      return [line];
    }

    const actionLines = (conflict.analysis?.actions ?? [])
      .filter((action) => action.audience === "you" || action.audience === "both")
      .slice(0, 2)
      .map(renderActionLine);

    return [line, ...actionLines];
  });
  const message = [heading, ...lines].join("\n");

  if (process.env.SYNAPSE_HOOK_NONBLOCKING === "1") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext: message
      }
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: message
    }
  };
}

/**
 * Render one action as "    ↳ <step> [→ run: <cli>]" — the runnable form
 * substitutes the catalog entry's `usage` template's `<argName>` placeholders
 * with the action's `command.args` values; placeholders with no matching arg
 * stay literal. Omits the bracketed part when the action has no `command`.
 */
function renderActionLine(action: ConflictAction): string {
  if (!action.command) {
    return `    ↳ ${action.step}`;
  }

  const spec = SYNAPSE_COMMAND_CATALOG.find((entry) => entry.tool === action.command?.tool);
  if (!spec) {
    return `    ↳ ${action.step}`;
  }

  const args = action.command.args ?? {};
  const usage = spec.usage.replace(/<([a-zA-Z0-9_]+)>/g, (placeholder, argName: string) =>
    argName in args ? args[argName]! : placeholder
  );

  return `    ↳ ${action.step} [→ run: ${usage}]`;
}

/** Map a hook payload's absolute `file_path` to a path relative to the worktree. */
function hookRelativePath(input: HookInput): string | null {
  const absolute = input.toolInput?.file_path;
  if (!absolute || typeof absolute !== "string") {
    return null;
  }

  const worktreeRoot = readLocalConfig().worktreeRoot ?? input.cwd ?? commandCwd();
  const relativePath = normalizePath(relative(worktreeRoot, absolute));
  // Outside the worktree (".." prefix) or empty → not ours to check.
  if (!relativePath || relativePath.startsWith("..")) {
    return null;
  }

  return relativePath;
}

interface HookInput {
  toolName?: string;
  cwd?: string;
  toolInput?: { file_path?: unknown };
  prompt?: string;
}

function parseHookInput(raw: string): HookInput {
  if (!raw.trim()) {
    return {};
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const toolInput = isRecord(parsed.tool_input) ? parsed.tool_input : undefined;
  return {
    toolName: typeof parsed.tool_name === "string" ? parsed.tool_name : undefined,
    cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
    toolInput: toolInput as HookInput["toolInput"],
    prompt: typeof parsed.prompt === "string" ? parsed.prompt : undefined
  };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

