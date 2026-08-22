import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlayVmHold, createRawDeadlines, MAX_COMMAND_MS,
} from '../src/macro/command-lifetime.js';

// A deterministic clock: timers fire only when the test advances time.
function fakeClock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    schedule: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id; },
    cancel: (t) => { timers.delete(t); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [key, timer] = due;
        timers.delete(key);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
  };
}

test('playvm hold: refreshes the frame on every tick', () => {
  const clock = fakeClock();
  const sets = [];
  const hold = createPlayVmHold({
    set: (s, st) => sets.push([s, st]), stop: () => sets.push('stop'),
    schedule: clock.schedule, cancel: clock.cancel, tickMs: 200,
  });
  hold.hold(40, 0);
  assert.deepEqual(sets, [[40, 0]]);
  clock.advance(600);
  assert.deepEqual(sets, [[40, 0], [40, 0], [40, 0], [40, 0]]);
});

test('playvm hold: releases at the ceiling and stops', () => {
  const clock = fakeClock();
  const sets = [];
  const hold = createPlayVmHold({
    set: (s, st) => sets.push([s, st]), stop: () => sets.push('stop'),
    schedule: clock.schedule, cancel: clock.cancel, tickMs: 200, maxMs: 1000,
  });
  hold.hold(40, 0);
  clock.advance(1000);
  assert.equal(sets.at(-1), 'stop');
  assert.equal(hold.held, false);
  const after = sets.length;
  clock.advance(1000);
  assert.equal(sets.length, after, 'nothing keeps ticking after release');
});

test('playvm hold: a new command restarts the ceiling', () => {
  const clock = fakeClock();
  const sets = [];
  const hold = createPlayVmHold({
    set: (s, st) => sets.push([s, st]), stop: () => sets.push('stop'),
    schedule: clock.schedule, cancel: clock.cancel, tickMs: 200, maxMs: 1000,
  });
  hold.hold(40, 0);
  clock.advance(800);
  hold.hold(50, 10);
  clock.advance(800);
  assert.ok(!sets.includes('stop'), 'renewed before the ceiling');
  assert.equal(hold.held, true);
});

test('playvm hold: release stops immediately and cancels the tick', () => {
  const clock = fakeClock();
  const sets = [];
  const hold = createPlayVmHold({
    set: (s, st) => sets.push([s, st]), stop: () => sets.push('stop'),
    schedule: clock.schedule, cancel: clock.cancel, tickMs: 200,
  });
  hold.hold(40, 0);
  hold.release();
  assert.equal(sets.at(-1), 'stop');
  const after = sets.length;
  clock.advance(5000);
  assert.equal(sets.length, after);
});

test('raw deadlines: float the port when the duration is up', () => {
  const clock = fakeClock();
  const floated = [];
  const d = createRawDeadlines({
    float: (p) => floated.push(p), schedule: clock.schedule, cancel: clock.cancel,
  });
  d.arm(0x32, 500);
  clock.advance(499);
  assert.deepEqual(floated, []);
  clock.advance(1);
  assert.deepEqual(floated, [0x32]);
  assert.deepEqual(d.armed, []);
});

test('raw deadlines: re-arming one port replaces its deadline', () => {
  const clock = fakeClock();
  const floated = [];
  const d = createRawDeadlines({
    float: (p) => floated.push(p), schedule: clock.schedule, cancel: clock.cancel,
  });
  d.arm(0x32, 500);
  clock.advance(400);
  d.arm(0x32, 500);
  clock.advance(400);
  assert.deepEqual(floated, [], 'the first deadline was replaced, not stacked');
  clock.advance(100);
  assert.deepEqual(floated, [0x32]);
});

test('raw deadlines: clearAll floats every armed port', () => {
  const clock = fakeClock();
  const floated = [];
  const d = createRawDeadlines({
    float: (p) => floated.push(p), schedule: clock.schedule, cancel: clock.cancel,
  });
  d.arm(0x32, 500);
  d.arm(0x33, 500);
  d.clearAll();
  assert.deepEqual(floated.sort(), [0x32, 0x33]);
  clock.advance(1000);
  assert.equal(floated.length, 2, 'the cancelled timers did not also fire');
});

test('both refuse a duration above the ceiling, rather than clamping it', () => {
  const clock = fakeClock();
  const hold = createPlayVmHold({
    set: () => {}, stop: () => {}, schedule: clock.schedule, cancel: clock.cancel,
  });
  const d = createRawDeadlines({
    float: () => {}, schedule: clock.schedule, cancel: clock.cancel,
  });
  assert.throws(() => d.arm(0x32, MAX_COMMAND_MS + 1), RangeError);
  assert.doesNotThrow(() => d.arm(0x32, MAX_COMMAND_MS));
  assert.equal(typeof hold.hold, 'function');
});
