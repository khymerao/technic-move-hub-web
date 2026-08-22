import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAP, BUTTON_NAMES, AXIS_NAMES, ACTIONS,
  readSource, resolveActions, learnBinding, tankMix,
} from '../src/gamepad-map.js';

// Minimal standard-mapping gamepad stub: 4 axes, 17 buttons.
const pad = (over = {}) => ({
  axes: over.axes ?? [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, (_, i) => ({
    value: over.buttons?.[i] ?? 0,
    pressed: (over.buttons?.[i] ?? 0) > 0.5,
  })),
});

test('readSource: axis and button sources', () => {
  const g = pad({ axes: [0.5, 0, 0, 0], buttons: { 7: 1 } });
  assert.equal(readSource(g, { type: 'axis', index: 0 }), 0.5);
  assert.equal(readSource(g, { type: 'button', index: 7 }), 1);
  assert.equal(readSource(g, null), 0);
});

test('readSource: inverted axis', () => {
  const g = pad({ axes: [0, -1, 0, 0] });
  assert.equal(readSource(g, { type: 'axis', index: 1, invert: true }), 1);
});

test('resolveActions: default racing layout — RT forward, LT reverse, left stick steers', () => {
  const g = pad({ axes: [-0.5, 0, 0, 0], buttons: { 7: 1 } });
  const a = resolveActions(g, DEFAULT_MAP);
  assert.equal(a.throttle, 1);
  assert.equal(a.steer, -0.5);
});

test('resolveActions: throttle is RT minus LT', () => {
  assert.equal(resolveActions(pad({ buttons: { 6: 1 } }), DEFAULT_MAP).throttle, -1);
  assert.equal(resolveActions(pad({ buttons: { 6: 1, 7: 1 } }), DEFAULT_MAP).throttle, 0);
});

test('resolveActions: button actions report pressed state', () => {
  // A (0) is the handbrake slot per driving-game convention; Y (3) cycles the LED.
  const a = resolveActions(pad({ buttons: { 0: 1 } }), DEFAULT_MAP);
  assert.equal(a.brake, true);
  assert.equal(a.ledCycle, false);
  const b = resolveActions(pad({ buttons: { 3: 1 } }), DEFAULT_MAP);
  assert.equal(b.ledCycle, true);
});

test('DEFAULT_MAP binds every physical control exactly once', () => {
  const used = [];
  for (const [, binding] of Object.entries(DEFAULT_MAP)) {
    for (const src of [binding, binding?.pos, binding?.neg]) {
      if (src?.type === 'button') used.push(src.index);
    }
  }
  assert.equal(new Set(used).size, used.length, 'no button may be bound twice');
});

test('DEFAULT_MAP covers every declared action', () => {
  for (const action of ACTIONS) {
    assert.ok(DEFAULT_MAP[action.id], `missing default binding for ${action.id}`);
  }
});

test('throttleB: right stick Y is inverted so pushing up drives forward', () => {
  const g = pad({ axes: [0, 0, 0, -1] }); // stick fully up = -1 in standard mapping
  assert.equal(resolveActions(g, DEFAULT_MAP).throttleB, 1);
});

test('learnBinding: button press wins', () => {
  const now = pad({ buttons: { 3: 1 } });
  const prev = { axes: [0, 0, 0, 0], buttons: Array(17).fill(0) };
  assert.deepEqual(learnBinding(now, prev), { type: 'button', index: 3 });
});

test('learnBinding: axis deflection detected', () => {
  const now = pad({ axes: [0, 0, 0.9, 0] });
  const prev = { axes: [0, 0, 0, 0], buttons: Array(17).fill(0) };
  assert.deepEqual(learnBinding(now, prev), { type: 'axis', index: 2 });
});

test('learnBinding: idle returns null', () => {
  const prev = { axes: [0, 0, 0, 0], buttons: Array(17).fill(0) };
  assert.equal(learnBinding(pad(), prev), null);
});

test('names cover the standard mapping', () => {
  assert.equal(BUTTON_NAMES[0], 'A');
  assert.equal(BUTTON_NAMES[6], 'LT');
  assert.equal(BUTTON_NAMES[7], 'RT');
  assert.equal(BUTTON_NAMES[12], 'D-Up');
  assert.equal(AXIS_NAMES[0], 'L-Stick X');
});

test('tankMix: pure throttle drives both tracks together', () => {
  assert.deepEqual(tankMix(100, 0), { left: 100, right: 100 });
  assert.deepEqual(tankMix(-60, 0), { left: -60, right: -60 });
});
test('tankMix: pure turn counter-rotates the tracks', () => {
  assert.deepEqual(tankMix(0, 100), { left: 100, right: -100 });
  assert.deepEqual(tankMix(0, -100), { left: -100, right: 100 });
});
test('tankMix: turning never speeds the outer track past the throttle', () => {
  // WPILib desaturation: scale the inputs before summing. Plain clipping would
  // return (100, 0) here and accelerate the outer track beyond what was asked.
  assert.deepEqual(tankMix(50, 50), { left: 50, right: 0 });
});
test('tankMix: stays inside the range at full deflection', () => {
  const m = tankMix(100, 100);
  assert.ok(Math.max(Math.abs(m.left), Math.abs(m.right)) <= 100);
});
test('tankMix: idle is a true stop on both tracks', () => {
  assert.deepEqual(tankMix(0, 0), { left: 0, right: 0 });
});
