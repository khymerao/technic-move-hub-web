import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHapticsDriver } from '../src/haptics-driver.js';
import { createHapticsMix } from '../src/haptics-mix.js';

function fakeMix(sequence) {
  let i = 0;
  return {
    calls: 0,
    silenced: 0,
    driven: [],
    hits: [],
    bedSilenced: 0,
    tick() { this.calls++; return sequence[Math.min(i++, sequence.length - 1)]; },
    drive(input) { this.driven.push(input); },
    hit(channel, magnitude) { this.hits.push({ channel, magnitude }); },
    setSettings() {},
    transientRemaining() { return 0; },
    silenceBed() { this.bedSilenced++; },
    silence() { this.silenced++; },
  };
}

function fakeActuator({ reject = null } = {}) {
  return {
    played: [],
    resets: 0,
    playEffect(type, params) {
      this.played.push({ type, params });
      return reject ? Promise.reject(reject) : Promise.resolve('complete');
    },
    reset() { this.resets++; return Promise.resolve('complete'); },
  };
}

const padWith = (actuator) => ({ vibrationActuator: actuator });
const err = (name) => Object.assign(new Error(name), { name });
const settle = () => new Promise((r) => setImmediate(r));

test('a tick plays dual-rumble with the mixed magnitudes', async () => {
  const actuator = fakeActuator();
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 0.5, weak: 0.2 }]), intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  assert.equal(actuator.played.length, 1);
  assert.equal(actuator.played[0].type, 'dual-rumble');
  assert.equal(actuator.played[0].params.strongMagnitude, 0.5);
  assert.equal(actuator.played[0].params.weakMagnitude, 0.2);
});

test('effect duration stays inside the safe window', async () => {
  const actuator = fakeActuator();
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 1, weak: 1 }]), intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  const { duration } = actuator.played[0].params;
  assert.ok(duration >= 30);
  assert.ok(duration <= 1000);
});

test('an unchanged pair is not re-sent, but zero always is', async () => {
  const actuator = fakeActuator();
  const mix = fakeMix([{ strong: 0.4, weak: 0 }, { strong: 0.4, weak: 0 }, { strong: 0, weak: 0 }]);
  const driver = createHapticsDriver({ mix, intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  driver.tick(padWith(actuator), 100);
  await settle();
  assert.equal(actuator.played.length, 1);
  driver.tick(padWith(actuator), 200);
  await settle();
  assert.equal(actuator.played.length, 2);
  assert.equal(actuator.played[1].params.strongMagnitude, 0);
});

test('NotSupportedError disables the driver permanently', async () => {
  const actuator = fakeActuator({ reject: err('NotSupportedError') });
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 1, weak: 1 }]), intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  assert.equal(driver.status(), 'unsupported');
  driver.tick(padWith(actuator), 100);
  await settle();
  assert.equal(actuator.played.length, 1);
});

test('InvalidStateError is routine and does not disable the driver', async () => {
  const actuator = fakeActuator({ reject: err('InvalidStateError') });
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 1, weak: 1 }]), intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  assert.notEqual(driver.status(), 'unsupported');
});

test('a pad with no actuator reports unsupported and never throws', async () => {
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 1, weak: 1 }]), intervalMs: 0 });
  driver.tick({}, 0);
  await settle();
  assert.equal(driver.status(), 'unsupported');
  driver.tick(null, 100);
});

test('silence emits exact zero and drops the bed', async () => {
  const actuator = fakeActuator();
  const mix = fakeMix([{ strong: 1, weak: 1 }]);
  const driver = createHapticsDriver({ mix, intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  driver.silence();
  await settle();
  const last = actuator.played.at(-1).params;
  assert.ok(Object.is(last.strongMagnitude, 0));
  assert.ok(Object.is(last.weakMagnitude, 0));
  assert.equal(mix.bedSilenced, 1, 'the bed is dropped');
  assert.equal(mix.silenced, 0, 'the transients are not erased by a stop');
});

test('blur resets the actuator', async () => {
  const actuator = fakeActuator();
  const listeners = new Map();
  const target = {
    addEventListener: (t, fn) => listeners.set(t, fn),
    removeEventListener: (t) => listeners.delete(t),
  };
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 1, weak: 1 }]), intervalMs: 0 });
  driver.attach(target);
  driver.tick(padWith(actuator), 0);
  await settle();
  listeners.get('blur')();
  await settle();
  assert.equal(actuator.resets, 1);
});

test('a hidden document resets the actuator', async () => {
  const actuator = fakeActuator();
  const listeners = new Map();
  const target = {
    addEventListener: (t, fn) => listeners.set(t, fn),
    removeEventListener: (t) => listeners.delete(t),
    document: { visibilityState: 'visible' },
  };
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 1, weak: 1 }]), intervalMs: 0 });
  driver.attach(target);
  driver.tick(padWith(actuator), 0);
  await settle();
  target.document.visibilityState = 'hidden';
  listeners.get('visibilitychange')();
  await settle();
  assert.equal(actuator.resets, 1);
});

test('drive and hit reach the mix', () => {
  const mix = fakeMix([{ strong: 0, weak: 0 }]);
  const driver = createHapticsDriver({ mix });
  driver.drive({ drive: 0.5, turn: 0, dtMs: 16 });
  driver.hit('impact', 0.9);
  assert.equal(mix.driven.length, 1);
  assert.deepEqual(mix.hits[0], { channel: 'impact', magnitude: 0.9 });
});

test('detach removes the listeners', () => {
  const listeners = new Map();
  const target = {
    addEventListener: (t, fn) => listeners.set(t, fn),
    removeEventListener: (t) => listeners.delete(t),
  };
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 0, weak: 0 }]) });
  driver.attach(target);
  driver.detach();
  assert.equal(listeners.size, 0);
});

function strictActuator({ throwOnPlay = null, reject = null, throwOnReset = null } = {}) {
  return {
    played: [],
    resets: 0,
    throwOnPlay,
    reject,
    playEffect(type, params) {
      if (this.throwOnPlay) throw this.throwOnPlay;
      this.played.push({ type, params });
      return this.reject ? Promise.reject(this.reject) : Promise.resolve('complete');
    },
    reset() {
      this.resets++;
      if (throwOnReset) throw throwOnReset;
      return Promise.resolve('complete');
    },
  };
}

function strictTarget(doc) {
  const bound = [];
  return {
    bound,
    document: doc,
    addEventListener(type, fn) { bound.push({ type, fn }); },
    removeEventListener(type, fn) {
      const i = bound.findIndex((b) => b.type === type && b.fn === fn);
      if (i >= 0) bound.splice(i, 1);
    },
  };
}

const boom = () => { throw new Error('boom'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a throwing onStatus never escapes tick', async () => {
  const actuator = strictActuator();
  const driver = createHapticsDriver({
    mix: fakeMix([{ strong: 0.5, weak: 0.5 }]), intervalMs: 0, onStatus: boom,
  });
  assert.doesNotThrow(() => driver.tick(padWith(actuator), 0));
  await settle();
  assert.equal(actuator.played.length, 1);
  assert.equal(driver.status(), 'playing');
});

test('a throwing onStatus never escapes silence, reset or the async catch', async () => {
  const actuator = strictActuator({ reject: err('NotSupportedError') });
  const driver = createHapticsDriver({
    mix: fakeMix([{ strong: 1, weak: 1 }]), intervalMs: 0, onStatus: boom,
  });
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  driver.tick(padWith(actuator), 0);
  await settle();
  await settle();
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(seen, []);
  assert.equal(driver.status(), 'unsupported');
  assert.doesNotThrow(() => driver.silence());
  assert.doesNotThrow(() => driver.reset());
});

test('a malformed mix return does not throw out of tick', async () => {
  const actuator = strictActuator();
  const driver = createHapticsDriver({ mix: fakeMix([undefined]), intervalMs: 0 });
  assert.doesNotThrow(() => driver.tick(padWith(actuator), 0));
  await settle();
  assert.equal(actuator.played.length, 0);
});

test('a throwing mix is contained on every entry point', async () => {
  const actuator = strictActuator();
  const badMix = {
    tick: boom, drive: boom, hit: boom, setSettings: boom, silence: boom,
  };
  const driver = createHapticsDriver({ mix: badMix, intervalMs: 0 });
  assert.doesNotThrow(() => driver.tick(padWith(actuator), 0));
  assert.doesNotThrow(() => driver.drive({ drive: 1, turn: 0, dtMs: 16 }));
  assert.doesNotThrow(() => driver.hit('impact', 1));
  assert.doesNotThrow(() => driver.setSettings({}));
  assert.doesNotThrow(() => driver.silence());
  assert.doesNotThrow(() => driver.reset());
  await settle();
});

test('a synchronous InvalidStateError does not disable the driver', async () => {
  const actuator = strictActuator({ throwOnPlay: err('InvalidStateError') });
  const mix = fakeMix([{ strong: 1, weak: 1 }, { strong: 1, weak: 1 }]);
  const driver = createHapticsDriver({ mix, intervalMs: 0 });
  assert.doesNotThrow(() => driver.tick(padWith(actuator), 0));
  await settle();
  assert.notEqual(driver.status(), 'unsupported');
  actuator.throwOnPlay = null;
  driver.tick(padWith(actuator), 100);
  await settle();
  assert.equal(actuator.played.length, 1);
  assert.equal(driver.status(), 'playing');
});

test('a synchronous NotSupportedError disables the driver permanently', async () => {
  const actuator = strictActuator({ throwOnPlay: err('NotSupportedError') });
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 1, weak: 1 }]), intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  assert.equal(driver.status(), 'unsupported');
  actuator.throwOnPlay = null;
  driver.tick(padWith(actuator), 100);
  await settle();
  assert.equal(actuator.played.length, 0);
});

test('a pad without an actuator does not disable a later good pad', async () => {
  const actuator = strictActuator();
  const mix = fakeMix([{ strong: 0.5, weak: 0.5 }]);
  const driver = createHapticsDriver({ mix, intervalMs: 0 });
  driver.tick({}, 0);
  assert.equal(driver.status(), 'unsupported');
  driver.tick(padWith(actuator), 100);
  await settle();
  assert.equal(actuator.played.length, 1);
  assert.equal(driver.status(), 'playing');
});

test('magnitudes out of range are clamped to [0,1] before playEffect', async () => {
  const actuator = strictActuator();
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 5, weak: -2 }]), intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  assert.equal(actuator.played[0].params.strongMagnitude, 1);
  assert.ok(Object.is(actuator.played[0].params.weakMagnitude, 0));
});

test('non-finite magnitudes become exact zero', async () => {
  const actuator = strictActuator();
  const mix = fakeMix([{ strong: NaN, weak: Infinity }]);
  const driver = createHapticsDriver({ mix, intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  assert.ok(Object.is(actuator.played[0].params.strongMagnitude, 0));
  assert.ok(Object.is(actuator.played[0].params.weakMagnitude, 0));
  assert.equal(driver.status(), 'idle');
});

test('output below the perceptual floor emits exact zero', async () => {
  const actuator = strictActuator();
  const mix = fakeMix([{ strong: 0.01, weak: 0.04 }, { strong: 0.06, weak: 0 }]);
  const driver = createHapticsDriver({ mix, intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  assert.ok(Object.is(actuator.played[0].params.strongMagnitude, 0));
  assert.ok(Object.is(actuator.played[0].params.weakMagnitude, 0));
  assert.equal(driver.status(), 'idle');
  driver.tick(padWith(actuator), 100);
  await settle();
  assert.equal(actuator.played[1].params.strongMagnitude, 0.06);
});

test('the epsilon dedupe never swallows the transition to exact zero', async () => {
  const actuator = strictActuator();
  const mix = fakeMix([{ strong: 0.06, weak: 0 }, { strong: 0.05, weak: 0 }, { strong: 0, weak: 0 }]);
  const driver = createHapticsDriver({ mix, intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  driver.tick(padWith(actuator), 100);
  await settle();
  assert.equal(actuator.played.length, 1);
  driver.tick(padWith(actuator), 200);
  await settle();
  assert.equal(actuator.played.length, 2);
  assert.ok(Object.is(actuator.played[1].params.strongMagnitude, 0));
  assert.equal(driver.status(), 'idle');
});

test('a repeated exact zero is still deduped', async () => {
  const actuator = strictActuator();
  const mix = fakeMix([{ strong: 0, weak: 0 }, { strong: 0, weak: 0 }]);
  const driver = createHapticsDriver({ mix, intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  driver.tick(padWith(actuator), 100);
  await settle();
  assert.equal(actuator.played.length, 1);
});

test('silence is not gated on state and still sends the stop', async () => {
  const actuator = strictActuator();
  const mix = fakeMix([{ strong: 1, weak: 1 }]);
  const driver = createHapticsDriver({ mix, intervalMs: 0 });
  driver.tick({}, 0);
  assert.equal(driver.status(), 'unsupported');
  driver.tick(padWith(actuator), 100);
  await settle();
  driver.silence();
  await settle();
  const last = actuator.played.at(-1).params;
  assert.ok(Object.is(last.strongMagnitude, 0));
  assert.ok(Object.is(last.weakMagnitude, 0));
});

test('reset survives a throwing actuator reset', async () => {
  const actuator = strictActuator({ throwOnReset: new Error('nope') });
  const mix = fakeMix([{ strong: 1, weak: 1 }]);
  const driver = createHapticsDriver({ mix, intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  assert.doesNotThrow(() => driver.reset());
  assert.equal(actuator.resets, 1);
  assert.equal(mix.silenced, 1);
});

test('test() plays a bed pulse, a transient and a stop, then resolves', async () => {
  const actuator = strictActuator();
  const driver = createHapticsDriver({
    mix: fakeMix([{ strong: 0, weak: 0 }]), intervalMs: 0, durationMs: 30,
  });
  const status = await driver.test(padWith(actuator));
  await settle();
  assert.equal(actuator.played.length, 3);
  assert.equal(actuator.played[0].params.weakMagnitude, 0.5);
  assert.equal(actuator.played[1].params.strongMagnitude, 1);
  assert.ok(Object.is(actuator.played[2].params.strongMagnitude, 0));
  assert.ok(Object.is(actuator.played[2].params.weakMagnitude, 0));
  assert.equal(status, driver.status());
});

test('silence cancels the pending test() timers', async () => {
  const actuator = strictActuator();
  const driver = createHapticsDriver({
    mix: fakeMix([{ strong: 0, weak: 0 }]), intervalMs: 0, durationMs: 30,
  });
  const pending = driver.test(padWith(actuator));
  driver.silence();
  await pending;
  await wait(120);
  assert.equal(actuator.played.length, 2);
  assert.ok(Object.is(actuator.played[1].params.strongMagnitude, 0));
  assert.ok(Object.is(actuator.played[1].params.weakMagnitude, 0));
});

test('blur cancels the pending test() timers', async () => {
  const actuator = strictActuator();
  const driver = createHapticsDriver({
    mix: fakeMix([{ strong: 0, weak: 0 }]), intervalMs: 0, durationMs: 30,
  });
  const target = strictTarget();
  driver.attach(target);
  const pending = driver.test(padWith(actuator));
  target.bound.find((b) => b.type === 'blur').fn();
  await pending;
  await wait(120);
  assert.equal(actuator.played.length, 1);
});

test('detach cancels the pending test() timers', async () => {
  const actuator = strictActuator();
  const driver = createHapticsDriver({
    mix: fakeMix([{ strong: 0, weak: 0 }]), intervalMs: 0, durationMs: 30,
  });
  driver.attach(strictTarget());
  const pending = driver.test(padWith(actuator));
  driver.detach();
  await pending;
  await wait(120);
  assert.equal(actuator.played.length, 1);
});

test('test() is not an escape hatch out of a disabled driver', async () => {
  const actuator = strictActuator({ throwOnPlay: err('NotSupportedError') });
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 1, weak: 1 }]), intervalMs: 0 });
  driver.tick(padWith(actuator), 0);
  await settle();
  assert.equal(driver.status(), 'unsupported');
  actuator.throwOnPlay = null;
  const status = await driver.test(padWith(actuator));
  assert.equal(status, 'unsupported');
  assert.equal(actuator.played.length, 0);
});

test('the default interval rate-limits non-silent emissions', async () => {
  const actuator = strictActuator();
  const mix = fakeMix([{ strong: 0.2, weak: 0 }, { strong: 0.9, weak: 0 }, { strong: 0.5, weak: 0 }]);
  const driver = createHapticsDriver({ mix });
  driver.tick(padWith(actuator), 0);
  await settle();
  assert.equal(actuator.played.length, 1);
  driver.tick(padWith(actuator), 40);
  await settle();
  assert.equal(actuator.played.length, 1);
  driver.tick(padWith(actuator), 100);
  await settle();
  assert.equal(actuator.played.length, 2);
  assert.equal(actuator.played[1].params.strongMagnitude, 0.5);
});

test('a zero pair bypasses the rate limit', async () => {
  const actuator = strictActuator();
  const mix = fakeMix([{ strong: 0.9, weak: 0 }, { strong: 0, weak: 0 }]);
  const driver = createHapticsDriver({ mix });
  driver.tick(padWith(actuator), 0);
  await settle();
  driver.tick(padWith(actuator), 10);
  await settle();
  assert.equal(actuator.played.length, 2);
  assert.ok(Object.is(actuator.played[1].params.strongMagnitude, 0));
});

test('detach removes the exact handlers it registered', () => {
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 0, weak: 0 }]) });
  const target = strictTarget();
  driver.attach(target);
  assert.equal(target.bound.length, 2);
  driver.detach();
  assert.equal(target.bound.length, 0);
});

test('attach and detach work when destructured off the driver', () => {
  const driver = createHapticsDriver({ mix: fakeMix([{ strong: 0, weak: 0 }]) });
  const { attach, detach } = driver;
  const target = strictTarget();
  assert.doesNotThrow(() => attach(target));
  assert.equal(target.bound.length, 2);
  assert.doesNotThrow(() => detach());
  assert.equal(target.bound.length, 0);
});

test('no public method reaches navigator.getGamepads', async () => {
  const actuator = strictActuator();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let probed = 0;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { getGamepads() { probed++; throw new Error('navigator is off limits'); } },
  });
  try {
    const mix = fakeMix([{ strong: 1, weak: 1 }]);
    const driver = createHapticsDriver({ mix, intervalMs: 0, durationMs: 30 });
    driver.tick(padWith(actuator), 0);
    await settle();
    assert.doesNotThrow(() => driver.silence());
    assert.doesNotThrow(() => driver.reset());
    await driver.test();
    assert.equal(probed, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
});

// The collision path: `hit` lands, then the emergency stop tears the poll loop
// down and silences the driver — all in one synchronous turn. Emission that
// waits for the next tick never happens, because there is no next tick.
// Driven against the real mixer: the defect lives in how the two meet.
test('a hit reaches the actuator without waiting for a tick', async () => {
  const actuator = fakeActuator();
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings({ enabled: true, transient: 1, bed: 1 });
  const driver = createHapticsDriver({ mix, intervalMs: 80, now: () => t });
  driver.tick(padWith(actuator), 0);
  await settle();
  const before = actuator.played.length;
  driver.hit('cut', 1);
  await settle();
  assert.ok(actuator.played.length > before, 'the hit must play immediately');
  assert.equal(actuator.played.at(-1).params.strongMagnitude, 1);
});

test('silence does not cut a live transient short', async () => {
  const actuator = fakeActuator();
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings({ enabled: true, transient: 1, bed: 1 });
  const driver = createHapticsDriver({ mix, intervalMs: 80, now: () => t });
  driver.drive({ drive: 1, turn: 0, dtMs: 16 });
  driver.tick(padWith(actuator), 0);
  await settle();
  driver.hit('cut', 1);
  await settle();
  driver.silence();
  await settle();
  const last = actuator.played.at(-1).params;
  assert.equal(last.strongMagnitude, 1, 'the crash hit must survive the emergency stop');
  assert.equal(last.weakMagnitude, 0, 'but the bed must go');
});

test('the held transient is released once it has run out', async () => {
  const actuator = fakeActuator();
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings({ enabled: true, transient: 1, bed: 1 });
  const driver = createHapticsDriver({ mix, intervalMs: 80, now: () => t });
  driver.tick(padWith(actuator), 0);
  await settle();
  driver.hit('cut', 1);
  await settle();
  driver.silence();
  await new Promise((r) => setTimeout(r, 400));
  const last = actuator.played.at(-1).params;
  assert.ok(Object.is(last.strongMagnitude, 0), 'the motor must end at exact zero');
  assert.ok(Object.is(last.weakMagnitude, 0));
});

// The guard dispatches `cut` and then `impact` for one collision, synchronously,
// and the emergency stop runs between them. The quieter second hit must not
// displace the crash. See src/collision.js:80-81 and src/main.js:226-235.
test('a second hit in the same collision cannot downgrade the crash', async () => {
  const actuator = fakeActuator();
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings({ enabled: true, transient: 1, bed: 1 });
  const driver = createHapticsDriver({ mix, intervalMs: 80, now: () => t });
  driver.tick(padWith(actuator), 0);
  await settle();
  driver.hit('cut', 1);        // the guard's cut
  driver.silence();            // the emergency stop it triggers
  driver.hit('impact', 0.4);   // the same collision's impact, right behind it
  await settle();
  assert.equal(actuator.played.at(-1).params.strongMagnitude, 1,
    'the crash keeps its magnitude');
});

// A staged brake lands ~400ms after the stop and announces then. Whatever it
// plays must be followed by a zero — the poll loop is gone and cannot write one.
test('a hit arriving after the loop is gone still ends in silence', async () => {
  const actuator = fakeActuator();
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings({ enabled: true, transient: 1, bed: 1 });
  const driver = createHapticsDriver({ mix, intervalMs: 80, now: () => t });
  driver.tick(padWith(actuator), 0);
  await settle();
  driver.silence();
  await settle();
  t = 400;
  driver.hit('brake', 0.6);
  await settle();
  assert.equal(actuator.played.at(-1).params.strongMagnitude, 0.6, 'it plays');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(Object.is(actuator.played.at(-1).params.strongMagnitude, 0),
    'and nothing is left running behind it');
});

// The disconnect path silences twice (src/main.js:241 then :248). The second
// call must not cancel the transient the first one promised to let finish.
test('a second silence does not chop the transient the first one held', async () => {
  const actuator = fakeActuator();
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings({ enabled: true, transient: 1, bed: 1 });
  const driver = createHapticsDriver({ mix, intervalMs: 80, now: () => t });
  driver.tick(padWith(actuator), 0);
  await settle();
  driver.hit('cut', 1);
  driver.silence();
  driver.silence();
  await settle();
  assert.equal(actuator.played.at(-1).params.strongMagnitude, 1,
    'the crash still plays after the second silence');
});
