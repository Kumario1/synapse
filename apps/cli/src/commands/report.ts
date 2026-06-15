import type { SynapseReportRequest } from "@synapse/protocol";
import { commandDefaults, parseFlags, requiredFlag } from "../config.js";
import { postToolWith, printJson } from "./tool.js";

export async function runReport(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  const file = requiredFlag(flags, "file");
  const symbol = flags.symbol ? { raw: flags.symbol } : undefined;
  printJson(
    await postToolWith(defaults, "synapse_report", {
      repoId: defaults.repoId,
      sessionId: defaults.sessionId,
      filePath: file,
      symbolId: symbol,
      summary: flags.summary,
      baseSha: flags["base-sha"],
      changeKind: flags["change-kind"] as SynapseReportRequest["changeKind"] | undefined
    })
  );
}
