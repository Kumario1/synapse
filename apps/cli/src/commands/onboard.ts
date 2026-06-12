import { commandDefaults, parseFlags } from "../config.js";
import { postJson } from "../http.js";

export async function runOnboard(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const limit = flags.limit ? Number(flags.limit) : undefined;
  const response = await postJson(`http://localhost:${defaults.daemonPort}/tools/synapse_onboard`, {
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    limit: Number.isFinite(limit) ? limit : undefined
  });
  console.log(JSON.stringify(response, null, 2));
}
