import { finiteNumber, printToolJson } from "./tool.js";

export async function runWhatsup(rawArgs: string[]): Promise<void> {
  await printToolJson(rawArgs, "synapse_whatsup", (flags, defaults) => ({
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    limit: finiteNumber(flags.limit)
  }));
}
