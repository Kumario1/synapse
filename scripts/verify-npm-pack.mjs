import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

console.log("verify:npm-pack delegates to verify:package; scripts/build-package.mjs is the canonical package builder.");
const result = spawnSync("npm", ["run", "verify:package"], {
  cwd: rootDir,
  env: process.env,
  stdio: "inherit"
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
