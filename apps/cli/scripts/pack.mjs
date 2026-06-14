#!/usr/bin/env node
// Compatibility wrapper for callers that still invoke the old CLI-local pack
// script. The public package is built only by scripts/build-package.mjs.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(cliRoot, "../..");
const destFlag = process.argv.indexOf("--dest");
const args = [join(repoRoot, "scripts/build-package.mjs")];
if (destFlag !== -1 && process.argv[destFlag + 1]) {
  args.push("--dest", resolve(process.argv[destFlag + 1]));
}

const result = spawnSync(process.execPath, args, {
  cwd: repoRoot,
  encoding: "utf8"
});

process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
