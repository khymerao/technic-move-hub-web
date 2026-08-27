// How often the rumble actually reaches the pad, and what stops it.
//
// The bed is driven continuously from stick position, so at the transient's
// change threshold it re-emits on the stick's own noise. Measured before this
// was changed: a thumb AT REST produced 15.67 calls a second with a 16.7 ms
// minimum gap — above the emission floor, because a value that quantises to
// exact zero counts as silent and silence deliberately bypasses that floor.
//
// See docs/DESIGN-NOTES.md § The bed answers the ride, not the stick's noise

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHapticsMix } from '../src/haptics-mix.js';
import { createHapticsDriver, WEAK_EPSILON } from '../src/haptics-driver.js';
import { applyDeadzone } from '../src/control-math.js';

const DEADZONE = 0.15;                        // the controller's default
const FRAME_MS = 16.7;

// Counts what actually reached the actuator, and how close together.
function rig({ weakEpsilon, intervalMs = 80, bed = 0.5 } = {}) {
  let t = 0;
  let seed = 12345;
  const played = [];
  let lastAt = -1;
  let minGap = Infinity;
  const now = () => t;
  const mix = createHapticsMix({ now });
  const driver = createHapticsDriver({ mix, now, weakEpsilon, intervalMs });
  mix.setSettings({ enabled: true, transient: 0.7, bed });
  const pad = {
    vibrationActuator: {
      playEffect(_type, opts) {
        played.push({ at: t, ...opts });
        if (lastAt >= 0) minGap = Math.min(minGap, t - lastAt);
        lastAt = t;
        return Promise.resolve('complete');
      },
      reset() { return Promise.resolve('complete'); },
    },
  };
  return {
    mix, driver, pad, played,
    now: () => t,
    minGap: () => minGap,
    // One frame of a stick held at `base` with jitter, through the same
    // deadzone the motor path uses. The jitter is pseudo-random rather than a
    // sine: a sine crosses a threshold twice per period at predictable phase,
    // which is exactly how a test ends up measuring around a boundary defect
    // instead of at it.
    frame(base, amp, i, { deadzone = true } = {}) {
      t += FRAME_MS;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const raw = base + ((seed / 0x7fffffff) - 0.5) * 2 * amp;
      const v = deadzone ? applyDeadzone(raw, DEADZONE) : raw;
      driver.drive({ drive: Math.abs(v), turn: 0, dtMs: FRAME_MS });
      driver.tick(pad, t);
    },
    run(base, amp, frames = 600, opts) {
      for (let i = 0; i < frames; i++) this.frame(base, amp, i, opts);
    },
  };
}

test('a disabled mixer writes the stop exactly once, and never a stream', () => {
  // Not zero calls: that single zero is the ONLY thing that stops the motor
  // when the box is unticked — the panel calls setSettings and never silence().
  // A tick() that returned early on a disabled mixer would leave the pad
  // rumbling at its last magnitude for good.
  const r = rig();
  r.mix.setSettings({ enabled: false, transient: 0.7, bed: 0.5 });
  r.run(0.5, 0.01, 60);
  assert.equal(r.played.length, 1, 'exactly one write');
  assert.equal(r.played[0].strongMagnitude, 0);
  assert.equal(r.played[0].weakMagnitude, 0);

  // And from a driver that was emitting a live bed a frame earlier.
  const live = rig();
  live.run(0.6, 0.02, 20);
  assert.ok(live.played.length > 0, 'it was rumbling');
  const before = live.played.length;
  live.mix.setSettings({ enabled: false, transient: 0.7, bed: 0.5 });
  live.run(0.6, 0.02, 60);
  const after = live.played.slice(before);
  assert.equal(after.length, 1, 'turning it off writes one stop, then nothing');
  assert.equal(after[0].strongMagnitude, 0);
  assert.equal(after[0].weakMagnitude, 0);
});

test('steady driving emits less often than it did at the transient threshold', () => {
  // The old behaviour, reconstructed in the same run rather than compared
  // against a number frozen into this file.
  const before = rig({ weakEpsilon: 0.02 });
  before.run(0.5, 0.01);
  const after = rig();
  after.run(0.5, 0.01);
  assert.ok(before.played.length > 0, 'the old threshold did emit');
  assert.ok(after.played.length < before.played.length,
    `expected fewer emissions, got ${after.played.length} vs ${before.played.length}`);
});

test('a thumb at rest inside the deadzone stops the rumble entirely', () => {
  const r = rig();
  r.run(0, 0.003);
  assert.ok(r.played.length <= 1,
    `a resting stick must not keep the motor busy, got ${r.played.length} writes`);
});

test('no emission gap falls below the floor, at any stick position', () => {
  // A bed hovering on a boundary quantises to exact zero and back, and exact
  // zero used to be treated as silent, and silence bypasses the interval floor.
  // That produced 16.7 ms gaps — one write per frame.
  //
  // The boundary that matters is NOT only the perceptual floor. The deadzone
  // at the call site is one too, and an earlier version of this test sampled
  // 0, 0.05, 0.2 and 0.5 — none of which straddle a deadzone of 0.15 — so it
  // passed by measuring around the defect rather than at it. The grid below
  // deliberately parks the stick ON the edge, which is an ordinary place for a
  // thumb to sit: it is a gentle crawl.
  const DZ = 0.15;
  const grid = [
    [0, 0.003], [0.05, 0.01], [DZ - 0.01, 0.01],
    [DZ, 0.01], [DZ, 0.02], [DZ + 0.01, 0.02], [DZ + 0.01, 0.05],
    [0.2, 0.01], [0.5, 0.01], [0.9, 0.02],
  ];
  for (const [base, amp] of grid) {
    const r = rig();
    r.run(base, amp);
    const gap = r.minGap();
    assert.ok(gap === Infinity || gap >= 80,
      `at drive ${base} ±${amp} the writes were ${gap}ms apart, under the 80ms floor`);
  }
});

test('a clean throttle sweep still reads as a bed, not an on-off switch', () => {
  const r = rig();
  for (let i = 0; i <= 300; i++) {
    const v = i <= 150 ? i / 150 : (300 - i) / 150;
    r.frame(v, 0, i);
  }
  const weak = r.played.map((p) => p.weakMagnitude);
  const steps = new Set(weak);
  assert.ok(steps.size >= 6,
    `the bed must still track the throttle in steps, got ${[...steps].join(' ')}`);
  const peak = Math.max(...weak);
  assert.ok(peak > weak[0], 'and it must rise with the throttle');
});

test('the wider threshold is the bed\'s alone: a transient still re-emits at EPSILON', () => {
  const r = rig();
  r.driver.tick(r.pad, r.now());          // seed lastPad
  const seen = [];
  for (const m of [0.5, 0.52, 0.54, 0.56]) {
    r.mix.hit('impact', m);
    r.driver.hit('impact', m);
    seen.push(r.played.length);
  }
  assert.ok(seen[seen.length - 1] > seen[0],
    'a transient stepping by EPSILON must still reach the pad');
  assert.ok(WEAK_EPSILON > 0.02, 'and the bed threshold is the wider one');
});

test('a hit with no loop behind it still ends in silence, whatever the emission floor', () => {
  // The arming window used to be `intervalMs * 3`. Raising the floor past
  // ~133ms therefore stopped a staged brake — which announces about 400ms
  // after the stop, with no frame around it — from arming its own zero, and
  // the motor was left running with nothing scheduled to stop it. No existing
  // test could see it: every one of them built the driver at 80 or 0.
  for (const intervalMs of [80, 250, 500]) {
    let t = 0;
    const played = [];
    const timers = [];
    const now = () => t;
    const mix = createHapticsMix({ now });
    const driver = createHapticsDriver({ mix, now, intervalMs });
    mix.setSettings({ enabled: true, transient: 1, bed: 0.5 });
    const pad = {
      vibrationActuator: {
        playEffect(_type, o) { played.push(o); return Promise.resolve('complete'); },
        reset() { return Promise.resolve('complete'); },
      },
    };
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; };
    try {
      driver.tick(pad, t);                 // seed lastPad, and set lastTickAt
      t += 400;                            // the staged-brake delay; the loop is gone
      driver.hit('brake', 0.6);
      assert.ok(played.some((p) => p.strongMagnitude > 0),
        `at ${intervalMs}ms the hit must reach the pad`);
      // Run whatever the hit armed.
      for (const timer of timers) { t = Math.max(t, timer.at); timer.fn(); }
      const last = played[played.length - 1];
      assert.equal(last.strongMagnitude, 0,
        `at ${intervalMs}ms the motor was left running at ${last.strongMagnitude}`);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }
});

test('a hit while the loop is still running does not arm a zero over a live bed', () => {
  // The arming window is bounded from below as well as above. At zero, every
  // hit would schedule a forced (0,0) even with the poll loop alive, writing
  // silence over a bed that is still being driven.
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  try {
    const r = rig();
    r.run(0.6, 0.01, 3);                  // a live bed, ticked this frame
    r.driver.hit('impact', 1);
    assert.equal(timers.length, 0,
      'a hit one frame after a tick has a loop behind it; the loop writes the zero');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
