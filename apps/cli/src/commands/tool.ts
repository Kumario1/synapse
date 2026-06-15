import { commandDefaults, parseFlags } from "../config.js";
import { postJson } from "../http.js";

export type ToolFlags = Record<string, string>;
export type ToolDefaults = ReturnType<typeof commandDefaults>;

export function finiteNumber(value: string | undefined): number | undefined {
  const parsed = value ? Number(value) : undefined;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function postTool(
  rawArgs: string[],
  tool: string,
  body: (flags: ToolFlags, defaults: ToolDefaults) => unknown
): Promise<unknown> {
  const flags = parseFlags(rawArgs);
  const defaults = commandDefaults(flags);
  return postToolWith(defaults, tool, body(flags, defaults));
}

export function postToolWith(defaults: ToolDefaults, tool: string, body: unknown): Promise<unknown> {
  return postJson(`http://localhost:${defaults.daemonPort}/tools/${tool}`, body);
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function printToolJson(
  rawArgs: string[],
  tool: string,
  body: (flags: ToolFlags, defaults: ToolDefaults) => unknown
): Promise<void> {
  printJson(await postTool(rawArgs, tool, body));
}
