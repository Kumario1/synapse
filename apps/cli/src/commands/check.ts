import { commandDefaults, parseFlags, requiredFlag } from "../config.js";
import { postToolWith, printJson } from "./tool.js";

export async function runCheck(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const file = requiredFlag(flags, "file");
  const symbol = flags.symbol ? { raw: flags.symbol } : undefined;
  printJson(
    await postToolWith(defaults, "synapse_check", {
      repoId: defaults.repoId,
      sessionId: defaults.sessionId,
      files: [file],
      symbols: symbol ? [symbol] : undefined,
      task: flags.task
    })
  );
}
