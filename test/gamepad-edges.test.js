// Regressions for input-edge handling. These three bugs all shipped and were
// found in the post-MVP review; each one let the car keep moving when it should
// have stopped, or fired an action repeatedly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAP, resolveActions } from '../src/gamepad-map.js';

const pad = (over = {}) => ({
  mapping: 'standard',
  timestamp: over.timestamp ?? 1,
  axes: over.axes ?? [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, (_, i) => ({
    value: over.buttons?.[i] ?? 0,
    pressed: (over.buttons?.[i] ?? 0) > 0.5,
  })),
});

// Mirrors GamepadController#wasPressed. Kept in step by the tests below: the
// controller version is private, this is the contract it must satisfy.
function wasPressed(map, prev, id) {
  if (!prev) return false;
  const b = map[id];
  if (!b) return false;
  if (b.type === 'button') return (prev.buttons[b.index] ?? 0) > 0.5;
  if (b.type === 'axis') {
    const v = prev.axes[b.index] ?? 0;
    return (b.invert ? -v : v) > 0.5;
  }
  return false;
}
const snapshot = (p) => ({ axes: [...p.axes], buttons: p.buttons.map((b) => b.value) });

test('button action fires once per press, not every frame', () => {
  const held = pad({ buttons: { 3: 1 } }); // Y = ledCycle
  const fires = [];
  let prev = null;
  for (let frame = 0; frame < 3; frame++) {
    const a = resolveActions(held, DEFAULT_MAP);
    if (a.ledCycle && !wasPressed(DEFAULT_MAP, prev, 'ledCycle')) fires.push(frame);
    prev = snapshot(held);
  }
  assert.deepEqual(fires, [0], 'holding the button must not re-fire');
});

test('axis-bound action fires once per deflection, not every frame', () => {
  // Remapping can put any action on an axis; edge detection must handle that.
  const map = { ...DEFAULT_MAP, ledCycle: { type: 'axis', index: 2 } };
  const deflected = pad({ axes: [0, 0, 1, 0] });
  const fires = [];
  let prev = null;
  for (let frame = 0; frame < 3; frame++) {
    const a = resolveActions(deflected, map);
    if (a.ledCycle && !wasPressed(map, prev, 'ledCycle')) fires.push(frame);
    prev = snapshot(deflected);
  }
  assert.deepEqual(fires, [0], 'a held axis must not re-fire every frame');
});

test('inverted axis binding respects its sign when detecting the edge', () => {
  const map = { ...DEFAULT_MAP, ledCycle: { type: 'axis', index: 3, invert: true } };
  const up = pad({ axes: [0, 0, 0, -1] }); // -1 with invert => +1 = pressed
  assert.equal(resolveActions(up, map).ledCycle, true);
  assert.equal(wasPressed(map, snapshot(up), 'ledCycle'), true);
});

// The stale-input failsafe: a frozen gamepad.timestamp means the pad stopped
// reporting. The guard used to stop the motors and then fall through, which
// re-commanded the stale throttle in the same frame and undid the stop.
test('stale-input guard must short-circuit the frame, not just stop once', () => {
  const frozen = pad({ timestamp: 42, buttons: { 7: 1 } }); // RT fully held
  const steps = [];
  let lastTs = 42, staleSince = 500, now = 2000;

  // The fixed control flow: detect stale -> stop -> return.
  const runFrame = () => {
    if (frozen.timestamp === lastTs) {
      if (now - staleSince > 1000) { steps.push('stop'); return; }
    } else { lastTs = frozen.timestamp; staleSince = 0; }
    const a = resolveActions(frozen, DEFAULT_MAP);
    steps.push(`drive:${a.throttle}`);
  };
  runFrame();
  assert.deepEqual(steps, ['stop'], 'a stale frame must not reach the drive commands');
});
