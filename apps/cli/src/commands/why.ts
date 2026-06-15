import { commandDefaults, parseFlags } from "../config.js";
import { finiteNumber, postToolWith, printJson } from "./tool.js";

export async function runWhy(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const question = flags.question ?? flags.q ?? rawArgs.filter((arg) => !arg.startsWith("--")).join(" ");
  if (!question) {
    throw new Error("--question is required");
  }

  printJson(
    await postToolWith(defaults, "synapse_why", {
      repoId: defaults.repoId,
      sessionId: defaults.sessionId,
      question,
      limit: finiteNumber(flags.limit)
    })
  );
}
