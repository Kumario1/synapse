import { commandDefaults, parseFlags } from "../config.js";
import { postJson } from "../http.js";

export async function runSession(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const action = (rawArgs.find((arg) => !arg.startsWith("--")) ?? "heartbeat") as
    | "start"
    | "end"
    | "heartbeat";
  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_session`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    action,
    task: flags.task
  });
  console.log(JSON.stringify(response, null, 2));
}

