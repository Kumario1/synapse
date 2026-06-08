#!/usr/bin/env node
// Creates (or refreshes) the Python virtual environment the analyzer sidecar
// runs in, installing the pinned deps from requirements.txt. Idempotent: a stamp
// file records the requirements hash so repeat runs are a no-op until deps change.
//
// Honors SYNAPSE_PYTHON_BASE to pick the base interpreter used to build the venv
// (defaults to `python3`). Exits 0 and prints a warning — never throws — when no
// Python is available, so the daemon can still start and degrade to file-level.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const venvDir = join(packageRoot, ".venv");
const requirementsPath = join(packageRoot, "requirements.txt");
const stampPath = join(venvDir, ".synapse-stamp");
const isWindows = process.platform === "win32";
const venvPython = join(venvDir, isWindows ? "Scripts" : "bin", isWindows ? "python.exe" : "python3");

function log(message) {
  process.stdout.write(`[analyzer-py setup] ${message}\n`);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function basePython() {
  const candidates = [process.env.SYNAPSE_PYTHON_BASE, "python3", "python"].filter(Boolean);
  for (const candidate of candidates) {
    const probe = run(candidate, ["--version"]);
    if (probe.status === 0) {
      return candidate;
    }
  }
  return null;
}

function requirementsHash() {
  return createHash("sha256").update(readFileSync(requirementsPath)).digest("hex");
}

function alreadyCurrent(hash) {
  if (!existsSync(venvPython) || !existsSync(stampPath)) {
    return false;
  }
  try {
    return readFileSync(stampPath, "utf8").trim() === hash;
  } catch {
    return false;
  }
}

function main() {
  const hash = requirementsHash();
  if (alreadyCurrent(hash)) {
    log(".venv already current");
    return 0;
  }

  const python = basePython();
  if (!python) {
    log("WARNING: no python3 found on PATH — skipping venv. Python analysis will fall back to file-level.");
    return 0;
  }

  if (!existsSync(venvPython)) {
    log(`creating venv with ${python}`);
    const created = run(python, ["-m", "venv", venvDir], { stdio: "inherit" });
    if (created.status !== 0) {
      log("WARNING: failed to create venv — Python analysis will fall back to file-level.");
      return 0;
    }
  }

  log("installing pinned dependencies (tree-sitter, tree-sitter-python, jedi)");
  const install = run(
    venvPython,
    ["-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", requirementsPath],
    { stdio: "inherit" }
  );
  if (install.status !== 0) {
    log("WARNING: pip install failed — Python analysis will fall back to file-level.");
    return 0;
  }

  writeFileSync(stampPath, `${hash}\n`);
  log("ready");
  return 0;
}

process.exit(main());
