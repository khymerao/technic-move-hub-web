// In tracked mode the tracks do the steering, which leaves the steering motor
// free for whatever the model uses it for — a turret, a plough, an arm. It runs
// raw off the RIGHT stick, and specifically not the left one: sharing the left
// stick X with the track mixer is what used to drive this motor into its end
// stop and stall it there.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const STEER_PORT = 0x34;

function padWithAxes(axes) {
  return {
    id: 'test pad',
    mapping: 'standard',
    timestamp: 0,
    axes,
    buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
  };
}

// Runs the real control loop for a few frames with a fixed stick position.
async function driveTracked(axes, frames = 6) {
  let clock = 0, ts = 0;
  const calls = [];
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock }, configurable: true, writable: true,
  });
  let pending = null;
  globalThis.requestAnimationFrame = (fn) => { pending = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { pending = null; };
  Object.defineProperty(globalThis, 'navigator', {
    // A fresh timestamp each poll, so nothing is mistaken for a wedged pad.
    value: { getGamepads: () => [{ ...padWithAxes(axes), timestamp: ++ts }] },
    configurable: true, writable: true,
  });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = globalThis.document ?? { getElementById: () => null };

  const { GamepadController } = await import('../src/gamepad-controller.js');
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const protocol = {
    roles: { driveA: 0x32, driveB: 0x33, steer: STEER_PORT },
    driveThrottle: rec('driveThrottle'),
    driveTank: rec('driveTank'),
    brakeDrive: rec('brakeDrive'),
    brakeMotor: rec('brakeMotor'),
    setMotorSpeedRaw: rec('setMotorSpeedRaw'),
    invertedPorts: new Set([0x33]),
  };
  const steering = { mode: 'raw', jogStop() {}, setInput() {}, release() {}, stop() {} };
  const gp = new GamepadController(protocol, protocol.roles, steering);
  await gp.setDriveMode('tracked');
  calls.length = 0;
  gp.start();
  for (let i = 0; i < frames; i++) {
    clock += 16;
    const tick = pending; pending = null; tick?.();
  }
  gp.stop();
  return calls.filter(([n, port]) => n === 'setMotorSpeedRaw' && port === STEER_PORT);
}

test('tracked mode: the right stick drives the steering motor', async () => {
  // axis 2 is right-stick X in the standard mapping.
  const steerCalls = await driveTracked([0, 0, 1, 0]);
  assert.ok(steerCalls.some(([, , v]) => v > 0),
    `right stick must command the steer motor, got ${JSON.stringify(steerCalls)}`);
});

test('tracked mode: the right stick steers the other way too', async () => {
  const steerCalls = await driveTracked([0, 0, -1, 0]);
  assert.ok(steerCalls.some(([, , v]) => v < 0),
    `right stick must reverse the steer motor, got ${JSON.stringify(steerCalls)}`);
});

test('tracked mode: the left stick must not touch the steering motor', async () => {
  // The regression this guards: the track mixer and the steering motor sharing
  // left-stick X drove the motor into its end stop and stalled it there.
  const steerCalls = await driveTracked([1, 1, 0, 0]);
  assert.ok(steerCalls.every(([, , v]) => v === 0),
    `left stick moved the steer motor: ${JSON.stringify(steerCalls)}`);
});

test('tracked mode: a centred right stick leaves the motor alone', async () => {
  const steerCalls = await driveTracked([0, 0, 0, 0]);
  assert.ok(steerCalls.every(([, , v]) => v === 0), 'a centred stick must command zero');
});

// Runs the loop in tracked mode and reports what the tracks were told to do.
async function driveTank(axes, frames = 6) {
  let clock = 0, ts = 0;
  const calls = [];
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock }, configurable: true, writable: true,
  });
  let pending = null;
  globalThis.requestAnimationFrame = (fn) => { pending = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { pending = null; };
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => [{ ...padWithAxes(axes), timestamp: ++ts }] },
    configurable: true, writable: true,
  });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = globalThis.document ?? { getElementById: () => null };

  const { GamepadController } = await import('../src/gamepad-controller.js');
  const protocol = {
    roles: { driveA: 0x32, driveB: 0x33, steer: STEER_PORT },
    driveThrottle() {}, brakeDrive() {}, brakeMotor() {}, setMotorSpeedRaw() {},
    driveTank: (...a) => calls.push(a),
    invertedPorts: new Set([0x33]),
  };
  const steering = { mode: 'raw', jogStop() {}, setInput() {}, release() {}, stop() {} };
  const gp = new GamepadController(protocol, protocol.roles, steering);
  await gp.setDriveMode('tracked');
  calls.length = 0;
  gp.start();
  for (let i = 0; i < frames; i++) {
    clock += 16;
    const tick = pending; pending = null; tick?.();
  }
  gp.stop();
  return calls;
}

test('tracked mode: the throttle axis is not inverted', async () => {
  // Hardware measurement, not derivable from the code: with invert on, pushing
  // the stick up drove the car backwards. The tracked path reaches the motors
  // through tankMix and the mirrored-motor inversion, either of which can flip
  // the sign, so the direction is settled on the car and pinned here.
  const { DEFAULT_MAP } = await import('../src/gamepad-map.js');
  assert.equal(DEFAULT_MAP.tankThrottle.invert, undefined,
    'tracked throttle must not be inverted — measured on the car');
});

test('tracked mode: up and down command opposite directions', async () => {
  const up = await driveTank([0, -1, 0, 0]);
  const down = await driveTank([0, 1, 0, 0]);
  assert.ok(up.length && down.length, 'the stick must command the tracks at all');
  assert.ok(Math.sign(up[0][0]) === -Math.sign(down[0][0]),
    `up and down must oppose: ${JSON.stringify([up[0], down[0]])}`);
  assert.equal(Math.sign(up[0][0]), Math.sign(up[0][1]), 'straight travel drives both tracks alike');
});

test('without a combined-frame controller the default falls back to per-motor drive', async () => {
  // The default mode drives through the hub's own frame. Constructed without
  // that collaborator, the car would otherwise sit in a mode that can command
  // nothing.
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = globalThis.document ?? { getElementById: () => null };
  const { GamepadController } = await import('../src/gamepad-controller.js');
  const roles = { driveA: 0x32, driveB: 0x33, steer: STEER_PORT };
  const without = new GamepadController({ roles, invertedPorts: new Set() }, roles, null);
  assert.equal(without.params.driveMode, 'linked');
  const withIt = new GamepadController({ roles, invertedPorts: new Set() }, roles, null,
    () => true, { stop() {}, set() {}, arm: async () => ({ ok: true }), disarm() {} });
  assert.equal(withIt.params.driveMode, 'playvm', 'the hub-driven mode is the default when it can run');
});
