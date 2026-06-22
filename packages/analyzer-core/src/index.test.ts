import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeSymbol } from "@synapse/protocol";
import { diffContracts } from "./index.js";

function sym(
  raw: string,
  sigHash: string,
  visibility: CodeSymbol["visibility"] = "exported"
): CodeSymbol {
  return {
    id: { raw },
    kind: "function",
    name: raw,
    visibility,
    signature: null,
    sigHash,
    span: { path: `${raw}.py`, startLine: 1, endLine: 1 },
    lang: "py"
  };
}

test("diffContracts reports removed and added symbols, sorted by symbol id", () => {
  const before = [sym("a", "h1"), sym("b", "h1")];
  const after = [sym("b", "h1"), sym("c", "h1")];

  assert.deepEqual(diffContracts(before, after), [
    { symbolId: { raw: "a" }, changeKind: "removed", before: sym("a", "h1"), after: null },
    { symbolId: { raw: "c" }, changeKind: "added", before: null, after: sym("c", "h1") }
  ]);
});

test("diffContracts reports visibility before signature, skipping sigHash when visibility moved", () => {
  const before = [sym("a", "h1", "exported")];
  const after = [sym("a", "h2", "internal")];

  assert.deepEqual(diffContracts(before, after), [
    {
      symbolId: { raw: "a" },
      changeKind: "visibility_changed",
      before: sym("a", "h1", "exported"),
      after: sym("a", "h2", "internal")
    }
  ]);
});

test("diffContracts reports a signature change when only sigHash differs", () => {
  assert.deepEqual(diffContracts([sym("a", "h1")], [sym("a", "h2")]), [
    {
      symbolId: { raw: "a" },
      changeKind: "signature_changed",
      before: sym("a", "h1"),
      after: sym("a", "h2")
    }
  ]);
});

test("diffContracts returns no changes for identical symbol sets", () => {
  const symbols = [sym("a", "h1"), sym("b", "h2")];
  assert.deepEqual(diffContracts(symbols, structuredClone(symbols)), []);
});
