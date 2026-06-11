import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closeGoAnalyzer, extractGoContracts } from "@synapse/analyzer-go";
import { closePythonAnalyzer, extractPythonContracts } from "@synapse/analyzer-py";
import { extractTypeScriptContracts } from "@synapse/analyzer-ts";
import { isGoLike, isPythonLike } from "../analysis.js";
import { commandCwd, parseFlags, requiredFlag } from "../config.js";

export async function runAnalyze(rawArgs: string[]): Promise<void> {
  const flags = parseFlags(rawArgs);
  const filePath = requiredFlag(flags, "file");
  const source = await readFile(resolve(commandCwd(), filePath), "utf8");
  const result = isPythonLike(filePath)
    ? await extractPythonContracts({ filePath, source })
    : isGoLike(filePath)
      ? await extractGoContracts({ filePath, source })
      : extractTypeScriptContracts({ filePath, source });
  if (isPythonLike(filePath)) {
    closePythonAnalyzer();
  }
  if (isGoLike(filePath)) {
    closeGoAnalyzer();
  }
  console.log(JSON.stringify(result, null, 2));
}

