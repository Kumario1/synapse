import assert from "node:assert/strict";
import test from "node:test";
import { parseExtractedContracts, parseExtractedDependencyGraph } from "./symbol-schema.js";

const validSymbol = {
  id: { raw: "py:mod#fn" },
  kind: "function",
  name: "fn",
  visibility: "exported",
  signature: { params: [], returns: null, raw: "fn()" },
  sigHash: "abc123",
  span: { path: "mod.py", startLine: 1, endLine: 2 },
  lang: "py"
};

test("parseExtractedContracts accepts a well-formed result and passes extra fields through", () => {
  const result = parseExtractedContracts({ symbols: [{ ...validSymbol, extra: "kept" }] });
  assert.equal(result.symbols.length, 1);
  assert.equal(result.symbols[0]?.sigHash, "abc123");
});

test("parseExtractedContracts throws on bad-but-parseable shapes (the injection hole)", () => {
  assert.throws(() => parseExtractedContracts(null));
  assert.throws(() => parseExtractedContracts({}));
  // a symbol missing required fields (struct-tag drift) must not slip through
  assert.throws(() => parseExtractedContracts({ symbols: [{ id: { raw: "x" } }] }));
  // a null symbol id is the exact "silently malformed CodeSymbol" case
  assert.throws(() => parseExtractedContracts({ symbols: [{ ...validSymbol, id: null }] }));
});

test("parseExtractedDependencyGraph validates symbols and edges", () => {
  const ok = parseExtractedDependencyGraph({
    symbols: [validSymbol],
    edges: [{ from: { raw: "a" }, to: { raw: "b" }, kind: "references" }]
  });
  assert.equal(ok.edges.length, 1);
  assert.throws(() =>
    parseExtractedDependencyGraph({
      symbols: [],
      edges: [{ from: { raw: "a" }, to: { raw: "b" }, kind: "calls" }]
    })
  );
});
