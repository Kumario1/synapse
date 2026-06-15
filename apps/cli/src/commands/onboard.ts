import { finiteNumber, printToolJson } from "./tool.js";

export async function runOnboard(rawArgs: string[]): Promise<void> {
  await printToolJson(rawArgs, "synapse_onboard", (flags, defaults) => ({
    repoId: defaults.repoId,
    sessionId: defaults.sessionId,
    limit: finiteNumber(flags.limit)
  }));
}
