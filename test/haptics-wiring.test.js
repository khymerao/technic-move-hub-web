// Wiring: the brake policy's report, the protocol's pass-through, and the
// gamepad poll loop's guarded haptics tick.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBrakePolicy } from '../src/brake-policy.js';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = globalThis.document ?? { getElementById: () => null };

const { GamepadController } = await import('../src/gamepad-controller.js');
const { LegoProtocol } = await import('../src/lego-protocol.js');

const flat = () => ({
  id: 'test pad',
  mapping: 'standard',
  timestamp: 0,
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
  vibrationActuator: { playEffect: () => Promise.resolve('complete'), reset: () => Promise.resolve() },
});

function harness({ haptics = null, padFactory = flat, msPerFrame = 16 } = {}) {
  let clock = 0;
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  let ts = 0;

  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock }, configurable: true, writable: true,
  });
  let pending = null;
  globalThis.requestAnimationFrame = (fn) => { pending = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { pending = null; };
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => [{ ...padFactory(), timestamp: ++ts }] },
    configurable: true,
    writable: true,
  });

  const protocol = {
    calls,
    roles: { driveA: 0x32, driveB: 0x33, led: 0x3f, lights: 0x35 },
    driveThrottle: rec('driveThrottle'),
    driveTank: rec('driveTank'),
    brakeDrive: rec('brakeDrive'),
    setMotorSpeedRaw: rec('setMotorSpeedRaw'),
    brakeMotor: rec('brakeMotor'),
    setLights: rec('setLights'),
    setLed: rec('setLed'),
    sendRaw: rec('sendRaw'),
    invertedPorts: new Set(),
  };

  const controller = new GamepadController(protocol, protocol.roles, null, () => true, null);
  if (haptics) controller.haptics = haptics;
  const crashes = [];
  controller.addEventListener('crashed', (e) => crashes.push(e.detail));
  controller.start();

  const frame = () => {
    clock += msPerFrame;
    const fn = pending;
    pending = null;
    fn?.();
  };
  return { controller, protocol, calls, frame, crashes };
}

function recorder() {
  const seen = [];
  return {
    seen,
    drive(input) { seen.push(['drive', input]); },
    tick(pad, t) { seen.push(['tick', pad, t]); },
    silence() { seen.push(['silence']); },
    hit(channel, magnitude) { seen.push(['hit', channel, magnitude]); },
    status: () => 'idle',
  };
}

// --- brake policy ------------------------------------------------------

const noStage = { now: () => 0, setTimer: () => 1, clearTimer: () => {} };

test('a brake that lands directly reports itself', () => {
  const seen = [];
  const policy = createBrakePolicy({ ...noStage, onBrake: (info) => seen.push(info) });
  policy.requestBrake(['a'], { coast: () => 'coast', brake: () => 'brake' });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].keys, ['a']);
  assert.equal(seen[0].staged, false);
});

test('a staged brake reports itself when the timer fires, not when it is armed', () => {
  const seen = [];
  let fire = null;
  const policy = createBrakePolicy({
    now: () => 0,
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => {},
    onBrake: (info) => seen.push(info),
  });
  policy.noteSpeed(['a'], 100);
  policy.requestBrake(['a'], { coast: () => 'coast', brake: () => 'brake' });
  assert.equal(seen.length, 0, 'arming the stage is not a brake');
  fire();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].keys, ['a']);
  assert.equal(seen[0].staged, true);
});

test('a cancelled stage never reports a brake', () => {
  const seen = [];
  const policy = createBrakePolicy({
    now: () => 0,
    setTimer: () => 1,
    clearTimer: () => {},
    onBrake: (info) => seen.push(info),
  });
  policy.noteSpeed(['a'], 100);
  policy.requestBrake(['a'], { coast: () => 'coast', brake: () => 'brake' });
  policy.noteSpeed(['a'], 50);
  assert.equal(seen.length, 0);
});

test('a throwing brake listener cannot break the direct brake', () => {
  const policy = createBrakePolicy({
    ...noStage,
    onBrake: () => { throw new Error('boom'); },
  });
  let braked = false;
  const out = policy.requestBrake(['a'], {
    coast: () => 'coast',
    brake: () => { braked = true; return 'brake'; },
  });
  assert.equal(braked, true);
  assert.equal(out, 'brake');
});

test('a throwing brake listener cannot break the staged brake', () => {
  let fire = null;
  const policy = createBrakePolicy({
    now: () => 0,
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => {},
    onBrake: () => { throw new Error('boom'); },
  });
  policy.noteSpeed(['a'], 100);
  policy.requestBrake(['a'], { coast: () => 'coast', brake: () => 'brake' });
  let braked = false;
  assert.doesNotThrow(() => { braked = fire() === 'brake'; });
  assert.equal(braked, true);
});

test('a settled() waiter still resolves when the listener throws', async () => {
  let fire = null;
  const policy = createBrakePolicy({
    now: () => 0,
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => {},
    onBrake: () => { throw new Error('boom'); },
  });
  policy.noteSpeed(['a'], 100);
  policy.requestBrake(['a'], { coast: () => 'coast', brake: () => 'brake' });
  const done = policy.settled(['a']);
  fire();
  await done;
});

test('a policy built without onBrake still brakes', () => {
  const policy = createBrakePolicy(noStage);
  assert.equal(policy.requestBrake(['a'], { coast: () => 'c', brake: () => 'b' }), 'b');
});

// --- protocol pass-through ---------------------------------------------

function stubTransport() {
  const t = new EventTarget();
  t.sent = [];
  t.sendBurst = (frames, tag) => { t.sent.push([tag, frames.length]); };
  t.send = (frame, tag) => { t.sent.push([tag, 1]); };
  return t;
}

test('LegoProtocol forwards onBrake to the brake policy', async () => {
  const seen = [];
  const transport = stubTransport();
  const protocol = new LegoProtocol(transport, { onBrake: (info) => seen.push(info) });
  protocol.roles = { driveA: 0x32, driveB: 0x33 };
  await protocol.brakeDrive();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].staged, false);
});

test('LegoProtocol without onBrake is unaffected', async () => {
  const transport = stubTransport();
  const protocol = new LegoProtocol(transport);
  protocol.roles = { driveA: 0x32, driveB: 0x33 };
  await protocol.brakeDrive();
  assert.ok(transport.sent.length > 0);
});

// --- gamepad poll loop --------------------------------------------------

test('the poll loop feeds the haptics collaborator', () => {
  const haptics = recorder();
  const { controller, frame } = harness({ haptics });
  frame();
  frame();
  const drives = haptics.seen.filter(([n]) => n === 'drive');
  const ticks = haptics.seen.filter(([n]) => n === 'tick');
  assert.ok(drives.length >= 1, 'the mixer must be fed the drive state');
  assert.ok(ticks.length >= 1, 'the driver must be ticked');
  const [, input] = drives[0];
  assert.ok(Number.isFinite(input.drive));
  assert.ok(Number.isFinite(input.turn));
  assert.ok(Number.isFinite(input.dtMs));
  controller.stop();
});

test('a haptics fault never escapes the poll loop', () => {
  const thrower = {
    drive() { throw new Error('boom'); },
    tick() { throw new Error('boom'); },
    silence() {},
    hit() {},
    status: () => 'idle',
  };
  const { controller, frame, crashes } = harness({ haptics: thrower });
  assert.doesNotThrow(() => { frame(); frame(); frame(); });
  assert.deepEqual(crashes, [], 'a haptics fault must not crash the loop');
  assert.equal(controller.running, true, 'the loop must still be running');
  controller.stop();
});

test('a faulting haptics collaborator is dropped, not retried every frame', () => {
  let calls = 0;
  const thrower = {
    drive() { calls++; throw new Error('boom'); },
    tick() {},
    silence() {},
    hit() {},
    status: () => 'idle',
  };
  const { controller, frame } = harness({ haptics: thrower });
  for (let i = 0; i < 10; i++) frame();
  assert.equal(calls, 1, 'the collaborator must be dropped after the first fault');
  controller.stop();
});

test('stopping the controller silences the haptics', () => {
  const haptics = recorder();
  const { controller, frame } = harness({ haptics });
  frame();
  controller.stop();
  assert.ok(haptics.seen.some(([n]) => n === 'silence'), '#stopAll must silence the pad');
});

test('the controller runs unchanged without a haptics collaborator', () => {
  const { controller, frame, crashes } = harness();
  assert.doesNotThrow(() => { frame(); frame(); });
  assert.deepEqual(crashes, []);
  controller.stop();
});

test('a throwing silence() cannot escape the stop path', () => {
  const haptics = {
    drive() {}, tick() {}, hit() {},
    silence() { throw new Error('boom'); },
    status: () => 'idle',
  };
  const { controller, frame, crashes } = harness({ haptics });
  frame();
  assert.doesNotThrow(() => controller.stop());
  assert.deepEqual(crashes, []);
  assert.equal(controller.haptics, null, 'a faulting driver must be dropped');
});
