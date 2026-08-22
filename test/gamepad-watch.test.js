// Watch mode: while a macro drives the car, the human's pad must still be
// pollable so a touch can abort the run, but it must never issue a motor
// command of its own — that path belongs to the macro.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const restPad = () => ({
  id: 'test pad',
  connected: true,
  mapping: 'standard',
  timestamp: 1,
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
});

// Drives the real controller through its own loop with time and rAF under
// our control. Mirrors the harness in test/gamepad-stale.test.js.
async function setup({ padFactory = restPad } = {}) {
  let clock = 0;
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };

  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock }, configurable: true, writable: true,
  });
  const pending = new Map();
  let nextId = 1;
  globalThis.requestAnimationFrame = (fn) => { const id = nextId++; pending.set(id, fn); return id; };
  globalThis.cancelAnimationFrame = (id) => { pending.delete(id); };
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => [padFactory()] }, configurable: true, writable: true,
  });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = globalThis.document ?? { getElementById: () => null };

  const { GamepadController } = await import('../src/gamepad-controller.js');
  const protocol = {
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
  const gp = new GamepadController(protocol, protocol.roles, null);
  // Fire every pending frame callback exactly once, the way a real rAF would
  // deliver one frame at a time (a callback scheduling another mid-fire must
  // not be invoked again in the same tick()).
  const tick = (msPerFrame = 16) => {
    clock += msPerFrame;
    const due = [...pending.entries()];
    pending.clear();
    for (const [, fn] of due) fn();
  };
  return { gp, protocol, calls, tick, pendingCount: () => pending.size };
}

test('watch(): a stick beyond the deadzone dispatches input and commands no motor', async () => {
  const { gp, calls, tick } = await setup({
    padFactory: () => ({ ...restPad(), axes: [0.9, 0, 0, 0] }),
  });
  let inputs = 0;
  gp.addEventListener('input', () => { inputs++; });
  gp.watch();
  tick();
  assert.equal(inputs, 1, 'a deflected stick beyond the deadzone must dispatch input');
  assert.equal(calls.length, 0, 'watch mode must issue no motor command');
  gp.unwatch();
});

test('watch(): a stick inside the deadzone dispatches nothing', async () => {
  const { gp, calls, tick } = await setup({
    padFactory: () => ({ ...restPad(), axes: [0.1, 0, 0, 0] }), // under 0.15 deadzone
  });
  let inputs = 0;
  gp.addEventListener('input', () => { inputs++; });
  gp.watch();
  tick();
  assert.equal(inputs, 0, 'a stick within the deadzone must not dispatch input');
  assert.equal(calls.length, 0, 'watch mode must issue no motor command');
  gp.unwatch();
});

test('watch(): a pressed button dispatches input', async () => {
  const { gp, tick } = await setup({
    padFactory: () => ({
      ...restPad(),
      buttons: Array.from({ length: 17 }, (_, i) => (
        i === 0 ? { value: 1, pressed: true } : { value: 0, pressed: false })),
    }),
  });
  let inputs = 0;
  gp.addEventListener('input', () => { inputs++; });
  gp.watch();
  tick();
  assert.equal(inputs, 1, 'a pressed button must dispatch input while watching');
  gp.unwatch();
});

test('watch() polls even when the drive loop was disabled (stopped) first', async () => {
  const { gp, calls, tick } = await setup({
    padFactory: () => ({ ...restPad(), axes: [0.9, 0, 0, 0] }),
  });
  gp.stop(); // as gp.disable() would leave it: no rAF loop running
  let inputs = 0;
  gp.addEventListener('input', () => { inputs++; });
  calls.length = 0; // drop the stop()-triggered stall commands
  gp.watch();
  tick();
  assert.equal(inputs, 1, 'watch() must start its own polling when the loop was off');
  assert.equal(calls.length, 0, 'watch mode must issue no motor command');
  gp.unwatch();
});

test('unwatch() stops the loop it started, and does not resume driving', async () => {
  const { gp, calls, tick, pendingCount } = await setup({
    padFactory: () => ({ ...restPad(), axes: [0.9, 0, 0, 0] }),
  });
  gp.stop();
  gp.watch();
  tick();
  calls.length = 0; // reset before unwatch(), so the assertion below is real
  gp.unwatch();
  assert.equal(calls.length, 0, 'unwatch() itself must issue no motor command');
  assert.equal(pendingCount(), 0, 'unwatch() must cancel the loop it owns');
  tick(); // nothing left to fire; confirms the loop is really down
  assert.equal(calls.length, 0);
});

test('an abort handler that stops the pad synchronously from inside input does not re-arm the loop', async () => {
  // Mirrors src/main.js's wiring: 'input' aborts the macro, whose onState
  // callback calls unwatch() synchronously while #poll() is still on the
  // stack. The rAF loop's own reschedule at the end of that same tick must
  // not undo the stop.
  const { gp, calls, tick, pendingCount } = await setup({
    padFactory: () => ({ ...restPad(), axes: [0.9, 0, 0, 0] }),
  });
  gp.stop();
  gp.watch();
  gp.addEventListener('input', () => { gp.unwatch(); });
  tick();
  assert.equal(pendingCount(), 0, 'the loop must not reschedule after a reentrant stop');
  calls.length = 0;
  tick();
  assert.equal(calls.length, 0, 'no further motor command after the reentrant stop');
});

test('watch() does not stop a drive loop it did not start', async () => {
  const { gp, calls, tick, pendingCount } = await setup({
    padFactory: () => ({ ...restPad(), axes: [0.9, 0, 0, 0] }),
  });
  gp.start(); // the user armed the pad for real driving
  const before = pendingCount();
  assert.ok(before > 0, 'start() must schedule a frame');
  gp.watch();
  tick();
  gp.unwatch();
  assert.ok(pendingCount() > 0, 'unwatch() must leave a loop running that it did not start');
  gp.stop();
});

test('a stick touch still aborts after panel-toggle clicks mid-run', async () => {
  // src/ui/gamepad.js's enable button calls hub.gamepad.start()/stop()
  // directly, with no knowledge of watch()'s loop ownership. Nothing in the
  // app disables that button while a macro runs, so an operator can click it
  // during a run. The abort path must survive that regardless.
  const { gp, calls, tick, pendingCount } = await setup({
    padFactory: () => ({ ...restPad(), axes: [0.9, 0, 0, 0] }),
  });
  gp.stop(); // pad off before the run begins
  calls.length = 0; // drop that stop()'s own stall commands
  gp.watch(); // the run starts; watch() takes ownership of a fresh loop
  gp.start(); // panel toggle, click 1: no-op, a loop is already running
  gp.stop();  // panel toggle, click 2: must not tear the loop down while watching
  let inputs = 0;
  gp.addEventListener('input', () => { inputs++; });
  tick();
  assert.equal(inputs, 1, 'a stick touch must still abort after panel-toggle clicks mid-run');
  assert.equal(calls.length, 0, 'the refused stop() must not have commanded anything either');
  assert.equal(pendingCount(), 1, 'the loop must still be scheduled after the touch');
  gp.unwatch();
});

test('a poll crash while watching resets internal state so a later watch() actually restarts polling', async () => {
  // The crash path in start()'s tick() sets #raf = 0 directly, bypassing
  // stop()'s #watching guard. If #watching/#watchOwnsLoop were left stale
  // true, a later watch() call would find #watching already true and
  // silently never restart polling — the next run would have no abort path
  // at all, forever, with nothing to say so.
  let clock = 0;
  const pending = new Map();
  let nextId = 1;
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock }, configurable: true, writable: true,
  });
  globalThis.requestAnimationFrame = (fn) => { const id = nextId++; pending.set(id, fn); return id; };
  globalThis.cancelAnimationFrame = (id) => { pending.delete(id); };
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => { throw new TypeError('Illegal invocation'); } },
    configurable: true, writable: true,
  });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = globalThis.document ?? { getElementById: () => null };

  const { GamepadController } = await import('../src/gamepad-controller.js');
  const protocol = {
    roles: { driveA: 0x32, driveB: 0x33, steer: 0x34 },
    driveThrottle() {}, setMotorSpeedRaw() {}, brakeMotor() {}, brakeDrive() {},
    invertedPorts: new Set(),
  };
  const gp = new GamepadController(protocol, protocol.roles, null);

  let crashes = 0;
  gp.addEventListener('crashed', () => { crashes++; });

  gp.watch(); // #raf was 0, so watch() starts its own loop
  const tick = () => { clock += 16; const due = [...pending.entries()]; pending.clear(); for (const [, fn] of due) fn(); };
  tick(); // the loop's first poll crashes

  assert.equal(crashes, 1, 'the crash must be reported so main.js can abort the run');
  assert.equal(gp.armed, false, 'a crashed pad must never read as armed');

  // If #watching/#watchOwnsLoop were left stale true, this call would be a
  // silent no-op (see watch()'s own guard) and nothing would ever poll
  // again — proved here by a second crash never arriving.
  gp.watch();
  tick();
  assert.equal(crashes, 2, 'watch() after a crash must actually restart polling, not silently no-op');
});
