import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rampStep, RAMP_MODES, DEFAULT_RATE, DEFAULT_TAU } from '../src/ramp.js';

// Run a ramp to completion, returning how long it took and the trace.
function rampTo(target, opts, { dt = 16, limit = 600 } = {}) {
  let v = 0;
  const trace = [];
  for (let i = 0; i < limit; i++) {
    v = rampStep(v, target, dt, opts);
    trace.push(v);
    if (v === target) return { ms: (i + 1) * dt, trace };
  }
  return { ms: Infinity, trace };
}

test('instant mode passes the target straight through', () => {
  assert.equal(rampStep(0, 100, 16, { mode: 'instant' }), 100);
});

test('linear mode climbs at the configured rate, not instantly', () => {
  // 220%/s over one 16ms frame is ~3.5 units.
  const v = rampStep(0, 100, 16, { mode: 'linear', rate: 220 });
  assert.ok(v > 0 && v < 10, `expected a small first step, got ${v}`);
});

test('linear mode reaches full throttle in roughly rate-implied time', () => {
  const { ms } = rampTo(100, { mode: 'linear', rate: 200 });
  // 100 units at 200 units/s = ~500ms, allowing for frame quantisation.
  assert.ok(ms >= 450 && ms <= 600, `expected ~500ms, took ${ms}ms`);
});

test('linear mode advances by equal steps', () => {
  const { trace } = rampTo(100, { mode: 'linear', rate: 200 });
  const deltas = trace.slice(1, 6).map((v, i) => v - trace[i]);
  assert.ok(new Set(deltas).size <= 2, `steps should be even, saw ${deltas}`);
});

test('expo mode starts fast and eases in', () => {
  const { trace } = rampTo(100, { mode: 'expo', tau: DEFAULT_TAU });
  const first = trace[0] - 0;
  const later = trace[20] - trace[19];
  assert.ok(first > later, `expo must decelerate as it closes: ${first} vs ${later}`);
});

test('expo mode always finishes rather than creeping forever', () => {
  const { ms } = rampTo(100, { mode: 'expo', tau: DEFAULT_TAU });
  assert.notEqual(ms, Infinity, 'rounding must not stall the approach short of target');
});

test('slowing down is never rate limited', () => {
  // A release must take effect at once, or the model keeps accelerating after
  // the stick is let go.
  assert.equal(rampStep(100, 0, 16, { mode: 'linear', rate: 20 }), 0);
  assert.equal(rampStep(100, 40, 16, { mode: 'expo', tau: 2000 }), 40);
});

test('reversing direction is never rate limited', () => {
  assert.equal(rampStep(80, -80, 16, { mode: 'linear', rate: 20 }), -80);
});

test('ramping works the same in reverse', () => {
  const v = rampStep(0, -100, 16, { mode: 'linear', rate: 220 });
  assert.ok(v < 0 && v > -10, `expected a small negative step, got ${v}`);
});

test('a zero or negative frame time never moves the output', () => {
  assert.equal(rampStep(50, 100, 0, { mode: 'linear' }), 100);
});

test('every declared mode is handled', () => {
  for (const mode of RAMP_MODES) {
    const v = rampStep(0, 50, 16, { mode, rate: DEFAULT_RATE, tau: DEFAULT_TAU });
    assert.equal(typeof v, 'number', `${mode} must return a number`);
    assert.ok(Math.abs(v) <= 50, `${mode} must not overshoot`);
  }
});
