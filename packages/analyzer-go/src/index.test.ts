import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  closeGoAnalyzer,
  diffGoContracts,
  extractGoContracts,
  extractGoDependencyGraph,
  goAnalyzerAvailable
} from "./index.js";

// The suite needs the built sidecar (scripts/setup-go.mjs, run by `npm test`).
// Without a Go toolchain the setup script no-ops, the sidecar is unavailable,
// and every behavior test skips — mirroring the daemon's file-level fallback.
const available = await goAnalyzerAvailable();

after(() => {
  closeGoAnalyzer();
});

async function createHungSidecarExecutable(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "synapse-go-timeout-"));
  const path = join(dir, "hung-sidecar");
  await writeFile(path, "#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n");
  await chmod(path, 0o755);
  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

test("the go sidecar responds to health (or the suite skips)", { skip: !available }, async () => {
  assert.equal(await goAnalyzerAvailable(), true);
});

test("times out a hung go sidecar request and restarts on the next request", async () => {
  const originalBinary = process.env.SYNAPSE_GO_ANALYZER_BIN;
  const originalTimeout = process.env.SYNAPSE_ANALYZER_REQUEST_TIMEOUT_MS;
  const hungSidecar = await createHungSidecarExecutable();

  closeGoAnalyzer();
  process.env.SYNAPSE_GO_ANALYZER_BIN = hungSidecar.path;
  process.env.SYNAPSE_ANALYZER_REQUEST_TIMEOUT_MS = "25";

  try {
    await assert.rejects(
      () => extractGoContracts({ filePath: "hung.go", source: "package hung\n\nfunc F() {}\n" }),
      /go analyzer request timed out \(method extractFile, id \d+, timeout 25ms\)/
    );
  } finally {
    closeGoAnalyzer();
    if (originalBinary === undefined) {
      delete process.env.SYNAPSE_GO_ANALYZER_BIN;
    } else {
      process.env.SYNAPSE_GO_ANALYZER_BIN = originalBinary;
    }
    if (originalTimeout === undefined) {
      delete process.env.SYNAPSE_ANALYZER_REQUEST_TIMEOUT_MS;
    } else {
      process.env.SYNAPSE_ANALYZER_REQUEST_TIMEOUT_MS = originalTimeout;
    }
    await hungSidecar.cleanup();
  }

  if (available) {
    assert.equal(await goAnalyzerAvailable(), true);
  }
});

test("extracts functions, structs, methods, fields, and consts", { skip: !available }, async () => {
  const source = [
    "package auth",
    "",
    "const MaxAttempts = 3",
    "",
    "type Token struct {",
    "\tValue   string",
    "\texpires int64",
    "}",
    "",
    "type Validator interface {",
    "\tValidate(input string) bool",
    "}",
    "",
    "func Validate(input string) bool {",
    "\treturn len(input) > 0",
    "}",
    "",
    "func (t *Token) Refresh(ttl int) (string, error) {",
    "\treturn t.Value, nil",
    "}",
    "",
    "func internalHelper() {}"
  ].join("\n");

  const result = await extractGoContracts({ filePath: "src/auth/token.go", source });
  assert.deepEqual(
    result.symbols.map((symbol) => [symbol.id.raw, symbol.kind]),
    [
      ["go:src/auth/token.go#MaxAttempts", "const"],
      ["go:src/auth/token.go#Token", "class"],
      ["go:src/auth/token.go#Token.Refresh", "method"],
      ["go:src/auth/token.go#Token.Value", "field"],
      ["go:src/auth/token.go#Validate", "function"],
      ["go:src/auth/token.go#Validator", "interface"]
    ]
  );

  const validate = result.symbols.find((symbol) => symbol.name === "Validate");
  assert.equal(validate?.signature?.raw, "func Validate(input string) bool");
  assert.equal(validate?.lang, "go");

  // Unexported names (expires, internalHelper) never appear.
  assert.equal(result.symbols.some((symbol) => symbol.name.includes("expires")), false);
});

test("a return-type change is a signature_changed diff", { skip: !available }, async () => {
  const before = await extractGoContracts({
    filePath: "src/auth/token.go",
    source: "package auth\n\nfunc Validate(input string) bool { return true }\n"
  });
  const afterSymbols = await extractGoContracts({
    filePath: "src/auth/token.go",
    source: "package auth\n\nfunc Validate(input string) (*Token, error) { return nil, nil }\ntype Token struct{}\n"
  });

  const changes = diffGoContracts(before.symbols, afterSymbols.symbols);
  const validateChange = changes.find((change) => change.symbolId.raw.endsWith("#Validate"));
  assert.equal(validateChange?.changeKind, "signature_changed");
});

test("graph links same-package and cross-package references", { skip: !available }, async () => {
  const graph = await extractGoDependencyGraph({
    files: [
      {
        filePath: "src/auth/token.go",
        source: "package auth\n\nfunc Validate(input string) bool { return true }\n"
      },
      {
        filePath: "src/auth/login.go",
        source: "package auth\n\nfunc Login(input string) bool { return Validate(input) }\n"
      },
      {
        filePath: "src/app/main.go",
        source:
          'package app\n\nimport "example.com/m/src/auth"\n\nfunc Run() bool { return auth.Validate("x") }\n'
      }
    ]
  });

  assert.deepEqual(
    graph.edges.map((edge) => [edge.from.raw, edge.to.raw]),
    [
      ["go:src/app/main.go#Run", "go:src/auth/token.go#Validate"],
      ["go:src/auth/login.go#Login", "go:src/auth/token.go#Validate"]
    ]
  );
});
