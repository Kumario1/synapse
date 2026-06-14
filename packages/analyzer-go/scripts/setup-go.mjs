#!/usr/bin/env node
// Builds the Go analyzer sidecar binary (plan M12), mirroring analyzer-py's
// setup-venv.mjs. Idempotent: a stamp file records the hash of the Go sources,
// so repeat runs are a no-op until they change.
//
// Exits 0 and prints a warning when no Go toolchain is available, so the
// daemon can still start and degrade to file-level detection for .go files.
// When Go is available, build failures are real failures unless explicitly
// opted out for local development with SYNAPSE_ANALYZER_GO_OPTIONAL=1.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const goDir = join(packageRoot, "go");
const binDir = join(packageRoot, "bin");
const isWindows = process.platform === "win32";
const binaryPath = join(binDir, isWindows ? "synapse-analyzer-go.exe" : "synapse-analyzer-go");
const stampPath = join(binDir, ".synapse-stamp");

function log(message) {
  process.stdout.write(`[analyzer-go setup] ${message}\n`);
}

function sourcesHash() {
  const hash = createHash("sha256");
  for (const name of readdirSync(goDir).sort()) {
    if (name.endsWith(".go") || name === "go.mod" || name === "go.sum") {
      hash.update(name);
      hash.update(readFileSync(join(goDir, name)));
    }
  }
  hash.update(process.platform + process.arch);
  return hash.digest("hex");
}

const goProbe = spawnSync("go", ["version"], { encoding: "utf8" });
if (goProbe.status !== 0) {
  log("no Go toolchain found; skipping — .go files will use file-level detection.");
  log("install Go (https://go.dev/dl) and re-run `npm run setup:analyzer-go` to enable it.");
  process.exit(0);
}

const hash = sourcesHash();
if (existsSync(binaryPath) && existsSync(stampPath)) {
  try {
    if (readFileSync(stampPath, "utf8").trim() === hash) {
      log(`binary is current (${binaryPath}).`);
      process.exit(0);
    }
  } catch {
    // fall through to rebuild
  }
}

mkdirSync(binDir, { recursive: true });
log(`building ${binaryPath} with ${goProbe.stdout.trim()}…`);
const build = spawnSync("go", ["build", "-o", binaryPath, "."], {
  cwd: goDir,
  stdio: "inherit",
  env: { ...process.env, CGO_ENABLED: "0" }
});

if (build.status !== 0) {
  if (process.env.SYNAPSE_ANALYZER_GO_OPTIONAL === "1") {
    log(
      "go build failed; continuing because SYNAPSE_ANALYZER_GO_OPTIONAL=1. .go files will use file-level detection until it succeeds."
    );
    process.exit(0);
  }
  log(
    "go build failed; failing because Go is installed. Set SYNAPSE_ANALYZER_GO_OPTIONAL=1 to keep local fallback behavior."
  );
  process.exit(build.status ?? 1);
}

writeFileSync(stampPath, `${hash}\n`);
log("done.");
