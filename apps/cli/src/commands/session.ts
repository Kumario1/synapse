import { commandDefaults, parseFlags } from "../config.js";
import { postJson } from "../http.js";

const SESSION_ACTIONS = ["start", "end", "heartbeat"] as const;
type SessionAction = (typeof SESSION_ACTIONS)[number];

export async function runSession(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const action = sessionAction(rawArgs, flags);
  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_session`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    action,
    task: flags.task
  });
  console.log(JSON.stringify(response, null, 2));
}

export function sessionAction(rawArgs: string[], flags = parseFlags(rawArgs)): SessionAction {
  const action = flags.action ?? positionalAction(rawArgs) ?? "heartbeat";
  if (isSessionAction(action)) {
    return action;
  }

  throw new Error(
    `Invalid session action "${action}". Expected one of: ${SESSION_ACTIONS.join(", ")}.`
  );
}

function positionalAction(rawArgs: string[]): string | undefined {
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg) {
      continue;
    }

    if (arg.startsWith("--")) {
      const next = rawArgs[index + 1];
      if (next && !next.startsWith("--")) {
        index += 1;
      }
      continue;
    }

    return arg;
  }

  return undefined;
}

function isSessionAction(action: string): action is SessionAction {
  return SESSION_ACTIONS.includes(action as SessionAction);
}
