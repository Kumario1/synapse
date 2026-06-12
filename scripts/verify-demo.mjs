import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `synapse demo` is the productized version of verify-dependency-ts-check.mjs's
// orchestration. This verify runs the built CLI's `demo --json`, checks the
// step 2 JSON contract, and mechanically confirms the sandbox and child
// processes are gone after exit (no lingering state, no leftover ports).
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(rootDir, "apps/cli/dist/index.js");

const { stdout, code } = await runDemo();

assert.equal(code, 0, `demo --json exited ${code}, stderr/stdout:\n${stdout}`);

const result = JSON.parse(stdout.trim());

assert.equal(result.ok, true, "demo reports ok: true");
assert.ok(result.conflict, "demo reports a conflict");
assert.equal(result.conflict.rule, "dependency_changed", "conflict rule is dependency_changed");
assert.deepEqual(
  result.steps,
  ["server-up", "join", "clean-check", "baseline", "delta", "conflict"],
  "demo walks through all six steps"
);

assert.equal(existsSync(result.sandbox), false, `sandbox ${result.sandbox} was cleaned up`);

for (const [name, port] of Object.entries(result.ports)) {
  const response = await fetch(`http://localhost:${port}/health`).catch(() => null);
  assert.equal(response, null, `${name} port ${port} no longer accepts connections`);
}

console.log("Demo verification passed:");
console.log(JSON.stringify(result, null, 2));

function runDemo() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, "demo", "--json"], {
      cwd: rootDir,
      env: { ...process.env, OPENROUTER_API_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({ stdout: stdout || stderr, code: code ?? 1 }));
  });
}
