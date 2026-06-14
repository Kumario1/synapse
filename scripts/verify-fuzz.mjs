import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Malformed-source fuzz for the analyzers (plan G6). Every analyzer must
// survive arbitrary garbage: the in-process TypeScript extractor never throws,
// and the Python/Go sidecars either answer or reject each request with a
// structured error — and stay healthy for the next one (one bad file must
// never take the analyzer down; the daemon's fallback depends on it).
// Deterministic: a seeded PRNG generates the same corpus every run. Sidecar
// sections skip when their runtime isn't set up (no venv / no built binary).
const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const { extractTypeScriptContracts, extractTypeScriptDependencyGraph } = await import(
  join(rootDir, "packages/analyzer-ts/dist/index.js")
);
const py = await import(join(rootDir, "packages/analyzer-py/dist/index.js"));
const go = await import(join(rootDir, "packages/analyzer-go/dist/index.js"));
const goBinaryPath = join(
  rootDir,
  "packages/analyzer-go/bin",
  process.platform === "win32" ? "synapse-analyzer-go.exe" : "synapse-analyzer-go"
);
const hasGoToolchain = spawnSync("go", ["version"], { stdio: "ignore" }).status === 0;

function mulberry32(seed) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0xfa22);
const CASES_PER_SHAPE = 12;

const FRAGMENTS = [
  "export function ", "def ", "func ", "class ", "type ", "interface ", "struct {",
  "(((((", ")))))", "{{{{{", "}}}}}", "=>", "->", "::", "...", "\\u0000", "\0",
  "🦀🐍🦫", "\"unterminated", "'", "`${", "#!", "@decorator", "import ", "from ",
  "package ", "return return", "0x", "1e999", "\\", "\n\n\n", "\t\t", ";;;;",
  "<T extends ", "interface{", "lambda x:", "async ", "yield ", "go func()",
  "<<<<<<< HEAD", "=======", ">>>>>>> branch"
];

function randomGarbage(maxFragments) {
  const count = 1 + Math.floor(random() * maxFragments);
  let out = "";
  for (let i = 0; i < count; i += 1) {
    out += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
    if (random() < 0.3) {
      out += String.fromCharCode(Math.floor(random() * 0xfffd) + 1);
    }
  }
  return out;
}

function corpus() {
  const cases = [];
  // Shape 1: pure fragment soup.
  for (let i = 0; i < CASES_PER_SHAPE; i += 1) {
    cases.push(randomGarbage(40));
  }
  // Shape 2: valid-looking prefixes, truncated mid-token.
  const valids = [
    "export function validate(input: string): boolean { return input.length > 0; }",
    "def validate(input: str) -> bool:\n    return len(input) > 0",
    "package auth\n\nfunc Validate(input string) bool {\n\treturn len(input) > 0\n}"
  ];
  for (let i = 0; i < CASES_PER_SHAPE; i += 1) {
    const valid = valids[i % valids.length];
    cases.push(valid.slice(0, 1 + Math.floor(random() * (valid.length - 1))));
  }
  // Shape 3: pathological nesting and very long identifiers.
  for (let i = 0; i < CASES_PER_SHAPE; i += 1) {
    const depth = 50 + Math.floor(random() * 400);
    const open = "([{"[i % 3];
    cases.push(open.repeat(depth) + "x".repeat(1000 + Math.floor(random() * 4000)));
  }
  // Shape 4: random bytes (latin1-ish noise).
  for (let i = 0; i < CASES_PER_SHAPE; i += 1) {
    let bytes = "";
    const length = Math.floor(random() * 2000);
    for (let j = 0; j < length; j += 1) {
      bytes += String.fromCharCode(Math.floor(random() * 256));
    }
    cases.push(bytes);
  }
  return cases;
}

const cases = corpus();
const summary = { cases: cases.length, ts: "ran", py: "skipped", go: "skipped" };

// --- TypeScript: in-process, must never throw, always an array. ---
for (const [index, source] of cases.entries()) {
  for (const filePath of [`fuzz/case${index}.ts`, `fuzz/case${index}.tsx`, `fuzz/case${index}.mjs`]) {
    const result = extractTypeScriptContracts({ filePath, source });
    assert.ok(Array.isArray(result.symbols), `${filePath}: symbols is an array`);
  }
}
// The graph path over the whole hostile corpus at once.
const graph = extractTypeScriptDependencyGraph({
  files: cases.map((source, index) => ({ filePath: `fuzz/g${index}.ts`, source }))
});
assert.ok(Array.isArray(graph.symbols) && Array.isArray(graph.edges), "ts graph survived the corpus");

// --- Sidecars: every request answers or rejects; health stays true after. ---
async function fuzzSidecar(label, available, extract, health, extension) {
  if (!(await available())) {
    console.log(`${label}: sidecar unavailable here — skipped (CI runs it).`);
    return "skipped";
  }
  for (const [index, source] of cases.entries()) {
    try {
      const result = await extract({ filePath: `fuzz/case${index}.${extension}`, source });
      assert.ok(Array.isArray(result.symbols), `${label} case ${index}: symbols is an array`);
    } catch (error) {
      assert.ok(error instanceof Error, `${label} case ${index}: structured rejection`);
    }
  }
  assert.equal(await health(), true, `${label}: sidecar still healthy after the corpus`);
  return "ran";
}

summary.py = await fuzzSidecar(
  "python",
  py.pythonAnalyzerAvailable,
  py.extractPythonContracts,
  py.pythonAnalyzerAvailable,
  "py"
);
py.closePythonAnalyzer();

summary.go = await fuzzSidecar(
  "go",
  async () => {
    if (!existsSync(goBinaryPath) && hasGoToolchain) {
      throw new Error(
        "Go analyzer binary was not built even though Go is available; run `npm run setup:analyzer-go` and fix build failures"
      );
    }
    if (!existsSync(goBinaryPath) && !hasGoToolchain) {
      return false;
    }
    const available = await go.goAnalyzerAvailable();
    if (!available) {
      throw new Error("Go analyzer binary exists but the sidecar is unavailable");
    }
    return true;
  },
  go.extractGoContracts,
  go.goAnalyzerAvailable,
  "go"
);
go.closeGoAnalyzer();

console.log("Fuzz verification passed:");
console.log(JSON.stringify(summary, null, 2));
