import { commandDefaults, parseFlags, requiredFlag } from "../config.js";
import { postJson } from "../http.js";

export async function runCheck(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const file = requiredFlag(flags, "file");
  const symbol = flags.symbol ? { raw: flags.symbol } : undefined;
  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_check`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    files: [file],
    symbols: symbol ? [symbol] : undefined,
    task: flags.task
  });
  console.log(JSON.stringify(response, null, 2));
}

