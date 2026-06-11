import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MIN_SUPPORTED_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  PROTOCOL_VERSION
} from "./index.js";

test("a current client agrees on the current version", () => {
  const result = negotiateProtocolVersion(PROTOCOL_VERSION);
  assert.deepEqual(result, { ok: true, agreed: PROTOCOL_VERSION });
});

test("no announcement (an old client) is treated as version 1", () => {
  const result = negotiateProtocolVersion(undefined);
  assert.deepEqual(result, { ok: true, agreed: 1 });
});

test("a newer client downgrades to the server's max", () => {
  const result = negotiateProtocolVersion(99, { min: 1, max: 3 });
  assert.deepEqual(result, { ok: true, agreed: 3 });
});

test("a client older than the supported range is refused with a reason", () => {
  const result = negotiateProtocolVersion(1, { min: 2, max: 3 });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /older than the oldest supported v2/u);
});

test("garbage announcements are refused, never crash", () => {
  for (const value of [0, -1, 1.5, Number.NaN]) {
    const result = negotiateProtocolVersion(value);
    assert.equal(result.ok, false, `expected refusal for ${value}`);
  }
});

test("the supported range is sane", () => {
  assert.ok(MIN_SUPPORTED_PROTOCOL_VERSION <= PROTOCOL_VERSION);
});
