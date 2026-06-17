import assert from "node:assert/strict";
import test from "node:test";
import { changedPanels, narrationSteps } from "./narration";
import { demoFrames } from "./fixture";

test("first frame: the online panel changes when the first member appears", () => {
  const changed = changedPanels(null, demoFrames[0]);
  assert.ok(changed.has("online"), "online should change when alice joins an empty room");
});

test("locking a symbol changes the signals and flow panels", () => {
  const changed = changedPanels(demoFrames[1], demoFrames[2]);
  assert.ok(changed.has("signals"), "an acquired edit lock is a signals change");
  assert.ok(changed.has("flow"), "a newly locked symbol enters the flow graph");
  assert.ok(!changed.has("online"), "membership is unchanged between frames 1 and 2");
});

test("reporting a contract delta changes the signals panel", () => {
  const changed = changedPanels(demoFrames[2], demoFrames[3]);
  assert.ok(changed.has("signals"), "an unpushed delta is a signals change");
});

test("a second session on the locked symbol contests it in signals and flow", () => {
  const changed = changedPanels(demoFrames[3], demoFrames[4]);
  assert.ok(changed.has("signals"), "the contesting lock is a signals change");
  assert.ok(changed.has("flow"), "the symbol becomes contested in the flow graph");
});

test("a push and PR landing changes the commits panel", () => {
  const changed = changedPanels(demoFrames[4], demoFrames[5]);
  assert.ok(changed.has("commits"), "a push and PR are a commits change");
});

test("narration has exactly one step per demo frame", () => {
  assert.equal(narrationSteps.length, demoFrames.length);
});

test("each step highlights a panel that actually changed on that frame", () => {
  narrationSteps.forEach((step, index) => {
    const changed = changedPanels(demoFrames[index - 1] ?? null, demoFrames[index]);
    assert.ok(
      changed.has(step.highlight),
      `step ${index} highlights "${step.highlight}" but that panel did not change`
    );
  });
});
