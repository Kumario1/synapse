import assert from "node:assert/strict";
import { test } from "node:test";
import { resolutionInputsHash, type ResolutionSide } from "./explain.js";

/**
 * Property tests for the resolution inputs hash (plan G6). The hash is the
 * convergence key for first-writer-wins resolutions, so its core properties —
 * symmetry across side order, stability, and sensitivity to the actual
 * contracts — must hold for arbitrary inputs, not just the handwritten cases.
 * Deterministic: a seeded PRNG generates the same cases on every run.
 */

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(0x5eed);

function randomString(maxLength: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:(),*#  ";
  const length = Math.floor(random() * maxLength);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(random() * alphabet.length)];
  }
  return out;
}

function randomSide(sessionId: string): ResolutionSide {
  return {
    sessionId,
    member: randomString(12),
    before: random() < 0.2 ? null : `func ${randomString(40)}`,
    after: random() < 0.2 ? null : `func ${randomString(40)}`
  };
}

const CASES = 250;

test("hash is symmetric across side order for arbitrary sides", () => {
  for (let i = 0; i < CASES; i += 1) {
    const symbol = `ts:src/${randomString(20)}.ts#${randomString(10)}`;
    const a = randomSide(`session-a-${i}`);
    const b = randomSide(`session-b-${i}`);

    assert.equal(
      resolutionInputsHash(symbol, [a, b]),
      resolutionInputsHash(symbol, [b, a]),
      `case ${i}: [a, b] and [b, a] must hash identically`
    );
  }
});

test("hash is stable: same inputs always produce the same value", () => {
  for (let i = 0; i < CASES; i += 1) {
    const symbol = `py:${randomString(20)}.py#${randomString(10)}`;
    const sides = [randomSide(`s1-${i}`), randomSide(`s2-${i}`)];
    const first = resolutionInputsHash(symbol, sides);
    // Re-derive from structurally-equal clones, as another machine would.
    const second = resolutionInputsHash(symbol, sides.map((side) => ({ ...side })));
    assert.equal(first, second, `case ${i}: structural clones must hash identically`);
  }
});

test("hash is sensitive to the contracts and the symbol", () => {
  for (let i = 0; i < CASES; i += 1) {
    const symbol = `go:${randomString(20)}.go#${randomString(10)}`;
    const a = randomSide(`s1-${i}`);
    const b = randomSide(`s2-${i}`);
    const baseline = resolutionInputsHash(symbol, [a, b]);

    const changedAfter = resolutionInputsHash(symbol, [
      a,
      { ...b, after: `${b.after ?? ""}!changed` }
    ]);
    assert.notEqual(baseline, changedAfter, `case ${i}: changing a side's after must change the hash`);

    const changedSymbol = resolutionInputsHash(`${symbol}2`, [a, b]);
    assert.notEqual(baseline, changedSymbol, `case ${i}: changing the symbol must change the hash`);
  }
});

test("member is display-only: it never affects the hash", () => {
  for (let i = 0; i < CASES; i += 1) {
    const symbol = `ts:${randomString(16)}.ts#${randomString(8)}`;
    const a = randomSide(`s1-${i}`);
    const b = randomSide(`s2-${i}`);
    const renamed = resolutionInputsHash(symbol, [
      { ...a, member: "someone-else" },
      { ...b, member: "another-name" }
    ]);
    assert.equal(resolutionInputsHash(symbol, [a, b]), renamed, `case ${i}`);
  }
});
