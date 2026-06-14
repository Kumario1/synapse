import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  closePythonAnalyzer,
  diffPythonContracts,
  extractPythonContracts,
  extractPythonDependencyGraph,
  pythonAnalyzerAvailable
} from "./index.js";

after(() => {
  closePythonAnalyzer();
});

async function createHungSidecarExecutable(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "synapse-py-timeout-"));
  const path = join(dir, "hung-sidecar");
  await writeFile(path, "#!/usr/bin/env node\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n");
  await chmod(path, 0o755);
  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

test("the python sidecar is available (venv installed)", async () => {
  assert.equal(await pythonAnalyzerAvailable(), true);
});

test("times out a hung python sidecar request and restarts on the next request", async () => {
  const originalPython = process.env.SYNAPSE_PYTHON;
  const originalTimeout = process.env.SYNAPSE_ANALYZER_REQUEST_TIMEOUT_MS;
  const hungSidecar = await createHungSidecarExecutable();

  closePythonAnalyzer();
  process.env.SYNAPSE_PYTHON = hungSidecar.path;
  process.env.SYNAPSE_ANALYZER_REQUEST_TIMEOUT_MS = "25";

  try {
    await assert.rejects(
      () => extractPythonContracts({ filePath: "hung.py", source: "def f():\n    pass\n" }),
      /python analyzer request timed out \(method extractFile, id \d+, timeout 25ms\)/
    );
  } finally {
    closePythonAnalyzer();
    if (originalPython === undefined) {
      delete process.env.SYNAPSE_PYTHON;
    } else {
      process.env.SYNAPSE_PYTHON = originalPython;
    }
    if (originalTimeout === undefined) {
      delete process.env.SYNAPSE_ANALYZER_REQUEST_TIMEOUT_MS;
    } else {
      process.env.SYNAPSE_ANALYZER_REQUEST_TIMEOUT_MS = originalTimeout;
    }
    await hungSidecar.cleanup();
  }

  assert.equal(await pythonAnalyzerAvailable(), true);
});

test("extracts module functions, classes, methods, fields, and consts", async () => {
  const source = [
    "from dataclasses import dataclass",
    "",
    "@dataclass",
    "class Token:",
    "    value: str",
    "    expires_at: int",
    "",
    "class TokenValidator:",
    "    def validate(self, raw: str) -> Token:",
    "        return Token(raw, 0)",
    "",
    "    def _secret(self):",
    "        pass",
    "",
    "MAX_AGE: int = 3600",
    ""
  ].join("\n");

  const { symbols } = await extractPythonContracts({ filePath: "src/auth/token.py", source });
  const byId = new Map(symbols.map((symbol) => [symbol.id.raw, symbol]));

  // Private methods are not part of the public contract.
  assert.equal(byId.has("py:src/auth/token.py#TokenValidator._secret"), false);

  const validate = byId.get("py:src/auth/token.py#TokenValidator.validate");
  assert.ok(validate, "method symbol present");
  assert.equal(validate.kind, "method");
  assert.equal(validate.lang, "py");
  // `self` is dropped from the public signature.
  assert.deepEqual(
    validate.signature?.params.map((param) => param.name),
    ["raw"]
  );
  assert.equal(validate.signature?.returns, "Token");

  const field = byId.get("py:src/auth/token.py#Token.value");
  assert.ok(field, "dataclass field present");
  assert.equal(field.kind, "field");

  const constant = byId.get("py:src/auth/token.py#MAX_AGE");
  assert.ok(constant, "module const present");
  assert.equal(constant.kind, "const");
});

test("identical source produces a stable sigHash (implementation-only change is no delta)", async () => {
  const before = "def add(a: int, b: int) -> int:\n    return a + b\n";
  const after = "def add(a: int, b: int) -> int:\n    total = a + b\n    return total\n";
  const a = await extractPythonContracts({ filePath: "math.py", source: before });
  const b = await extractPythonContracts({ filePath: "math.py", source: after });
  assert.equal(a.symbols[0].sigHash, b.symbols[0].sigHash);
  assert.deepEqual(diffPythonContracts(a.symbols, b.symbols), []);
});

test("a return-type change is a signature_changed contract delta", async () => {
  const before = await extractPythonContracts({
    filePath: "auth.py",
    source: "def validate(raw: str) -> str:\n    return raw\n"
  });
  const after = await extractPythonContracts({
    filePath: "auth.py",
    source: "def validate(raw: str) -> bool:\n    return bool(raw)\n"
  });
  const changes = diffPythonContracts(before.symbols, after.symbols);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeKind, "signature_changed");
  assert.equal(changes[0].symbolId.raw, "py:auth.py#validate");
});

test("jedi resolves cross-file references into graph edges", async () => {
  const graph = await extractPythonDependencyGraph({
    files: [
      {
        filePath: "auth/token.py",
        source: "class TokenValidator:\n    def validate(self, raw: str) -> str:\n        return raw\n"
      },
      {
        filePath: "auth/login.py",
        source:
          "from auth.token import TokenValidator\n\ndef login(raw: str) -> str:\n    v = TokenValidator()\n    return v.validate(raw)\n"
      }
    ]
  });

  const edgeKeys = graph.edges.map((edge) => `${edge.from.raw}->${edge.to.raw}`);
  assert.ok(
    edgeKeys.includes("py:auth/login.py#login->py:auth/token.py#TokenValidator.validate"),
    `expected login -> validate edge, got ${JSON.stringify(edgeKeys)}`
  );
});
