import assert from "node:assert/strict";
import test from "node:test";
import type { ContractDelta, SymbolId } from "@synapse/protocol";
import type { RuntimeConfig } from "./config.js";
import {
  createContractDelta,
  reservationSeedForReport,
  summarizeDelta,
  summarizeSymbolChange,
  uniqueSymbols
} from "./contract-report.js";

const config = {
  repoId: "repo",
  sessionId: "sess",
  member: "alice"
} as unknown as RuntimeConfig;

const sym = (raw: string): SymbolId => ({ raw });

test("summarizeSymbolChange renders a sentence for every change kind", () => {
  assert.equal(summarizeSymbolChange("added", "ts:a#x"), "Added ts:a#x");
  assert.equal(summarizeSymbolChange("removed", "ts:a#x"), "Removed ts:a#x");
  assert.equal(
    summarizeSymbolChange("signature_changed", "ts:a#x"),
    "Changed signature for ts:a#x"
  );
  assert.equal(
    summarizeSymbolChange("visibility_changed", "ts:a#x"),
    "Changed visibility for ts:a#x"
  );
  assert.equal(summarizeSymbolChange("moved", "ts:a#x"), "Moved ts:a#x");
  assert.equal(summarizeSymbolChange("renamed", "ts:a#x"), "Renamed ts:a#x");
});

test("uniqueSymbols dedupes by raw, preserving first-seen order", () => {
  const result = uniqueSymbols([sym("a"), sym("b"), sym("a"), sym("c"), sym("b")]);
  assert.deepEqual(
    result.map((s) => s.raw),
    ["a", "b", "c"]
  );
});

test("uniqueSymbols on an empty list returns an empty list", () => {
  assert.deepEqual(uniqueSymbols([]), []);
});

test("reservationSeedForReport falls back to radius 0 when there is no graph", () => {
  const seed = reservationSeedForReport(sym("root"), null, [sym("dep"), sym("root")]);
  assert.equal(seed?.radius, 0);
  assert.deepEqual(
    seed?.symbols.map((s) => s.raw),
    ["root", "dep"]
  );
});

test("createContractDelta fills defaults and omits reservation when absent", () => {
  const delta = createContractDelta(config, {
    symbolId: sym("ts:a#x"),
    filePath: "src/a.ts",
    changeKind: "signature_changed",
    before: null,
    after: null,
    summary: "Updated ts:a#x"
  });

  assert.equal(delta.repoId, "repo");
  assert.equal(delta.sessionId, "sess");
  assert.equal(delta.baseSha, "local");
  assert.deepEqual(delta.dependents, []);
  assert.equal(delta.pushedAt, null);
  assert.equal("reservation" in delta, false);
  assert.match(delta.id, /[0-9a-f-]{36}/u);
});

test("createContractDelta keeps an explicit reservation and baseSha", () => {
  const delta = createContractDelta(config, {
    symbolId: sym("ts:a#x"),
    filePath: "src/a.ts",
    changeKind: "added",
    before: null,
    after: null,
    summary: "Added ts:a#x",
    baseSha: "abc123",
    reservation: { radius: 1, symbols: [sym("ts:a#x")] }
  });

  assert.equal(delta.baseSha, "abc123");
  assert.equal(delta.reservation?.radius, 1);
});

test("summarizeDelta projects only the wire-summary fields", () => {
  const delta: ContractDelta = {
    id: "id-1",
    repoId: "repo",
    sessionId: "sess",
    symbolId: sym("ts:a#x"),
    changeKind: "signature_changed",
    before: null,
    after: null,
    summary: "Changed signature for ts:a#x",
    filePath: "src/a.ts",
    baseSha: "local",
    dependents: [],
    createdAt: "2026-06-22T00:00:00.000Z",
    pushedAt: null
  };

  assert.deepEqual(summarizeDelta(delta), {
    id: "id-1",
    symbolId: sym("ts:a#x"),
    changeKind: "signature_changed",
    summary: "Changed signature for ts:a#x",
    filePath: "src/a.ts",
    createdAt: "2026-06-22T00:00:00.000Z"
  });
});
