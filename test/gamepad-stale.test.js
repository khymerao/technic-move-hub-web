// A pad that stops reporting is a level condition, not an event. Treating it as
// an event put a stop on the link every animation frame for as long as nobody
// touched the controller — 60 writes a second, indefinitely. A live session
// logged 389 motor writes at a 7 ms median from exactly this.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const frozenPad = () => ({
  id: 'test pad',
  mapping: 'standard',
  timestamp: 42,            // never advances: this is the whole point
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
});

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = globalThis.document ?? { getElementById: () => null };
const { GamepadController } = await import('../src/gamepad-controller.js');

// Builds the rig: a started controller, a fake protocol that logs every call, a
// live `pads` array the test may mutate, and a single-step frame driver.
// `runFrames` below is this same rig driven for a fixed number of frames.
function harness({
  padFactory = null, msPerFrame = 16, slots = null,
  steering = false, playvmArmFails = false, autoReturn = true,
} = {}) {
  let clock = 0;
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const pads = [frozenPad()];

  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock }, configurable: true, writable: true,
  });
  let pending = null;
  globalThis.requestAnimationFrame = (fn) => { pending = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { pending = null; };
  // A fresh object per poll when a factory is given — a factory may advance the
  // timestamp — and the live array itself otherwise, so a test can empty it.
  const getGamepads = () => {
    if (slots) return slots();
    if (padFactory) return pads.map(() => padFactory());
    return pads;
  };
  // navigator is a getter-only global in Node, so it has to be redefined
  // rather than assigned.
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads }, configurable: true, writable: true,
  });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = globalThis.document ?? { getElementById: () => null };

  const protocol = {
    calls,
    roles: { driveA: 0x32, driveB: 0x33, steer: 0x34, led: 0x3f, lights: 0x35 },
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
  // `steering: true` is the raw-mode motor; `steering: 'steer'` is the
  // closed-loop rack, which holds a target on its own rAF and so has to be
  // unwound rather than merely un-commanded. `release()` mirrors the real
  // SteeringController: it obeys `autoReturn` and does nothing without it
  // (src/steering-controller.js § release).
  const steer = steering
    ? {
      mode: typeof steering === 'string' ? steering : 'raw',
      target: 0,
      params: { autoReturn },
      jogStop() {}, setZero() {}, stop() {},
      setInput(v) { this.target = Math.round(v); },
      release() { if (this.params.autoReturn) this.target = 0; },
    }
    : null;
  const playvm = playvmArmFails
    ? {
      armed: false, set() {}, stop() {}, disarm() {},
      arm: async () => ({ ok: false, reason: 'no drive port' }),
    }
    : null;
  const controller = new GamepadController(protocol, protocol.roles, steer, () => true, playvm);
  controller.start();

  const frame = () => {
    clock += msPerFrame;
    const fn = pending;
    pending = null;
    fn?.();
  };
  return { controller, protocol, pads, calls, frame, steer };
}

// Drives the real controller through its own loop with time under our control.
async function runFrames(count, opts = {}) {
  const { controller, calls, frame } = harness({ padFactory: frozenPad, ...opts });
  for (let i = 0; i < count; i++) frame();
  controller.stop();
  return calls;
}

test('a disconnected pad stops the car exactly once, not once per frame', async () => {
  const gone = () => ({ ...frozenPad(), connected: false });
  const calls = await runFrames(300, { padFactory: gone });
  const stops = calls.filter(([n]) => n === 'driveThrottle');
  // stop() at teardown contributes one; the loop must contribute at most one more.
  assert.ok(stops.length <= 2,
    `expected one stop for a lost pad, got ${stops.length} driveThrottle calls`);
});

test('a dead entry in the pad array does not shadow the live controller', async () => {
  // Chrome keeps disconnected pads in the array. Taking the first non-null slot
  // handed us a stale object with connected === false while the real pad sat in
  // the next slot, and the motors were cut mid-drive for no visible reason.
  const dead = { ...frozenPad(), connected: false };
  const live = () => ({
    ...frozenPad(),
    connected: true,
    buttons: Array.from({ length: 17 }, (_, i) => (
      i === 7 ? { value: 1, pressed: true } : { value: 0, pressed: false })),
  });
  const calls = await runFrames(200, { slots: () => [dead, live()] });
  const drives = calls.filter(([n]) => n === 'driveThrottle');
  assert.ok(drives.some(([, v]) => v > 0),
    'the live pad in slot 1 must drive the car despite a dead slot 0');
});

test('an idle pad with a frozen timestamp is not stopped repeatedly', async () => {
  // 300 frames ~ 4.8s. Nothing is being commanded, so the only writes allowed
  // are the ones a stop makes.
  const calls = await runFrames(300);
  const stops = calls.filter(([n]) => n === 'driveThrottle');
  assert.ok(stops.length <= 2,
    `an untouched pad put ${stops.length} writes on the link`);
});

test('holding a trigger steady does not stop the car', async () => {
  // The reported symptom: press the trigger, the motor runs, and about three
  // seconds later it dies. A held control produces no state change, so some
  // platforms stop advancing gamepad.timestamp — the pad is fine, it is simply
  // being held. Stopping on that makes steady throttle impossible, which is the
  // most ordinary thing a driver does.
  const held = () => ({
    ...frozenPad(),
    buttons: Array.from({ length: 17 }, (_, i) => (
      i === 7 ? { value: 1, pressed: true } : { value: 0, pressed: false })),
  });
  const calls = await runFrames(300, { padFactory: held });
  const drives = calls.filter(([n]) => n === 'driveThrottle');
  assert.ok(drives.some(([, v]) => v > 0), 'the held trigger must command the motors at all');
  // The last thing sent before the loop is torn down must not be a stop.
  const loopCalls = calls.slice(0, -1);
  const lastDrive = [...loopCalls].reverse().find(([n]) => n === 'driveThrottle');
  assert.ok(lastDrive && lastDrive[1] !== 0,
    `a steadily held trigger was stopped: last drive command was ${JSON.stringify(lastDrive)}`);
});

test('a live pad is not treated as stale', async () => {
  let t = 0;
  const moving = () => ({ ...frozenPad(), timestamp: ++t });
  const calls = await runFrames(120, { padFactory: moving });
  const stale = calls.filter(([n]) => n === 'driveThrottle');
  assert.ok(stale.length <= 2, 'a reporting pad must not trigger the stale path');
});

// On a phone `navigator.getGamepads()` stays empty until a button is pressed on
// a physical pad, so a loop that returns early on "no pad" can never command a
// motor from an on-screen control. The failsafe it replaced still has to hold:
// no input source at all is still a stop, and still only one.
test('an engaged touch axis keeps the loop alive with no pad present', () => {
  const { controller, protocol, pads, frame } = harness();
  pads.length = 0;                        // no gamepad, ever
  controller.touch.set('throttle', 0.8);
  frame(); frame();
  assert.ok(protocol.calls.some((c) => c[0] === 'driveThrottle' && c[1] !== 0),
    'touch must reach the motors when no pad exists');
});

test('no pad and no touch still stops exactly once', () => {
  const { protocol, pads, frame } = harness();
  pads.length = 0;
  frame(); frame(); frame();
  const stops = protocol.calls.filter((c) => c[0] === 'driveThrottle' && c[1] === 0);
  assert.equal(stops.length, 1, 'the lost-pad stop must not repeat every frame');
});

test('releasing the last touch axis stops the car', () => {
  const { controller, protocol, pads, frame } = harness();
  pads.length = 0;
  controller.touch.set('throttle', 0.8);
  frame();
  controller.touch.release('throttle');
  frame();
  assert.ok(protocol.calls.some((c) => c[0] === 'driveThrottle' && c[1] === 0));
});

// C2. With a pad, a centred stick keeps the loop past the no-source gate and
// the steering branch runs `release()` every frame. With touch, letting go
// removes the last engaged axis and takes the early return instead, so the
// target stood at its last value and SteeringController's own rAF drove the
// rack to full lock indefinitely — with nothing left commanding it.
test('releasing the last touch axis unwinds the steering rack, it does not leave it commanded', () => {
  const { controller, pads, frame, steer } = harness({ steering: 'steer' });
  pads.length = 0;                       // phone, no pad: the on-screen controls only
  controller.touch.set('steer', 1);
  frame();
  assert.equal(steer.target, 100, 'a dragged steer control must command the rack at all');

  controller.touch.release('steer');
  frame();
  assert.equal(steer.target, 0,
    'the rack was left driving to its last target after the finger came off');
  assert.equal(steer.mode, 'steer', 'the mode is not what changed — the target is');
});

test('a stop unwinds the rack whoever asked for the stop', () => {
  const { controller, pads, frame, steer } = harness({ steering: 'steer' });
  pads.length = 0;
  controller.touch.set('steer', 1);
  frame();
  assert.equal(steer.target, 100);
  controller.stop();
  assert.equal(steer.target, 0, 'stop() must leave nothing for the rack to drive to');
});

// C2 residue. `release()` is not a stop: with the `st-return` checkbox cleared
// it is a no-op by design, so a stop routed through it left the rack driving to
// its last target with nothing commanding it. The setting keeps its meaning for
// an ordinary release while the loop is alive and a pad is still there; what it
// may not do is survive a stop.
test('the rack unwinds on the last release even with auto-return off', () => {
  const { controller, pads, frame, steer } = harness({ steering: 'steer', autoReturn: false });
  pads.length = 0;
  controller.touch.set('steer', 1);
  frame();
  assert.equal(steer.target, 100, 'a dragged steer control must command the rack at all');

  controller.touch.release('steer');
  frame();
  assert.equal(steer.target, 0,
    'auto-return off left the rack driving to full lock after the finger came off');
});

test('a stop unwinds the rack even with auto-return off', () => {
  const { controller, pads, frame, steer } = harness({ steering: 'steer', autoReturn: false });
  pads.length = 0;
  controller.touch.set('steer', 1);
  frame();
  assert.equal(steer.target, 100);
  controller.stop();
  assert.equal(steer.target, 0, 'a stop is not a release: auto-return may not survive it');
});

// I1. src/main.js counted an axis as held on any touch.set, deadzone included,
// and used that count to skip emergencyStop() on pad loss. A thumb at the dead
// centre of the tank pad sets both axes to 0 and commands nothing, so that
// count said "still driving" while the mixer said nothing was engaged — and the
// stop, including the steering stop, was skipped.
test('engagement is post-deadzone and the controller is the one that answers', () => {
  const { controller, pads } = harness();
  pads.length = 0;
  assert.equal(typeof controller.anyEngaged, 'function',
    'anything deciding whether a finger is driving must ask the mixer, not count calls');
  assert.equal(controller.anyEngaged(), false, 'nothing touched is nothing engaged');

  // A thumb resting at dead centre of the tank pad: two axes set, zero commanded.
  controller.touch.set('tankThrottle', 0);
  controller.touch.set('tankTurn', 0);
  assert.equal(controller.anyEngaged(), false,
    'a finger inside the deadzone commands nothing and must not suppress a stop');

  controller.touch.set('tankTurn', 0.8);
  assert.equal(controller.anyEngaged(), true, 'past the deadzone is engaged');

  // The internal stops clear the mixer directly, so a copy kept anywhere else
  // goes stale exactly when it matters — after a crash or an emergency stop.
  controller.stop();
  assert.equal(controller.anyEngaged(), false,
    'a stop must be visible in the same state the app reads');
});

test('the state event reports what was sent, not the raw axis', () => {
  const { controller, pads, frame } = harness({ steering: true });
  pads[0].axes = [0, 0, 0, 0];
  controller.params.steerGain = 50;
  controller.touch.set('steer', 1);
  let detail = null;
  controller.addEventListener('state', (e) => { detail = e.detail; });
  frame();
  assert.ok(detail.sent, 'state must carry the sent values');
  assert.notEqual(detail.sent.steer, 100, 'sent must be post-gain, not the raw axis');
  assert.equal(detail.sent.steer, 50, 'sent must be the number the motor was given');
});

test('drivemode reports the effective mode after a failed playvm arm', async () => {
  const { controller } = harness({ playvmArmFails: true });
  const seen = [];
  controller.addEventListener('drivemode', (e) => seen.push(e.detail.mode));
  await controller.setDriveMode('playvm');
  assert.deepEqual(seen, ['linked'], 'a failed arm must not announce playvm');
});

test('a throw inside the loop stops the car instead of stranding it', async () => {
  // This happened: a detached setTimeout threw "Illegal invocation" out of the
  // control loop, the loop died, and the motor held its last command with
  // nothing left running to release it.
  let clock = 0;
  const calls = [];
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock }, configurable: true, writable: true,
  });
  let pending = null;
  globalThis.requestAnimationFrame = (fn) => { pending = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { pending = null; };
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => { throw new TypeError('Illegal invocation'); } },
    configurable: true, writable: true,
  });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = globalThis.document ?? { getElementById: () => null };

  const { GamepadController } = await import('../src/gamepad-controller.js');
  const protocol = {
    roles: { driveA: 0x32, driveB: 0x33, steer: 0x34 },
    driveThrottle: (...a) => calls.push(['driveThrottle', ...a]),
    setMotorSpeedRaw: (...a) => calls.push(['setMotorSpeedRaw', ...a]),
    brakeMotor: () => {}, brakeDrive: () => {}, invertedPorts: new Set(),
  };
  const gp = new GamepadController(protocol, protocol.roles, null);
  let crashed = false;
  gp.addEventListener('crashed', () => { crashed = true; });
  gp.start();
  clock += 16;
  const tick = pending;
  pending = null;      // the stub does not clear on fire; a re-arm must be visible
  tick?.();

  assert.ok(crashed, 'the crash must be reported, not swallowed');
  assert.ok(calls.some(([n, v]) => n === 'driveThrottle' && v === 0),
    'the car must be stopped when the loop dies');
  assert.equal(pending, null, 'a loop that crashes every frame must not keep running');
});
