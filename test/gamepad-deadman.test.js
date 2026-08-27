// The per-motor dead-man. The linked / tracked / independent drive paths run
// "until told" with no hub-side watchdog behind them, unlike the playvm frame.
// A held non-zero command that stops being refreshed (frames stall, tab
// suspends) must be braked after a TTL by a self-rescheduling timer, and that
// timer must never fire for a stopped car and must be torn down on stop/crash.
//
// See docs/DESIGN-NOTES.md § The per-motor drive paths need their own dead-man

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { getElementById: () => null };
const mod = await import('../src/gamepad-controller.js');
const { GamepadController, PERMOTOR_TTL_MS, PERMOTOR_WATCHDOG_MS } = mod;

// This edition binds `throttle` to the triggers (RT = button 7), not the left
// stick, so a full-throttle command presses RT rather than pushing an axis.
const buttons = (over = {}) => Array.from({ length: 17 }, (_, i) => ({
  value: over[i] ?? 0, pressed: (over[i] ?? 0) > 0.5,
}));

function harness({ permotorTtlMs = 1000, watchdogMs = 500 } = {}) {
  let clock = 0;
  let pending = null;
  let axes = [0, 0, 0, 0];
  let btns = {};
  let broken = false;
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, ...a]); };

  const timers = new Map();
  let nextId = 1;
  const now = () => clock;
  const schedule = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; };
  const cancel = (id) => { timers.delete(id); };
  const runDue = () => {
    for (let g = 0; g < 10000; g++) {
      const due = [...timers].filter(([, v]) => v.at <= clock);
      if (!due.length) return;
      for (const [id, { fn }] of due) { timers.delete(id); fn(); }
    }
    throw new Error('timer loop did not settle');
  };

  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock }, configurable: true, writable: true,
  });
  const getGamepads = () => {
    if (broken) throw new TypeError('Illegal invocation');
    return [{ id: 'test pad', mapping: 'standard', connected: true,
      timestamp: clock, axes: [...axes], buttons: buttons(btns) }];
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads }, configurable: true, writable: true,
  });
  globalThis.requestAnimationFrame = (fn) => { pending = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { pending = null; };

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
  const controller = new GamepadController(protocol, protocol.roles, null, () => true, null,
    { now, schedule, cancel, permotorTtlMs, watchdogMs });
  controller.start();

  return {
    controller, calls, protocol,
    set(a, b = {}) { axes = a; btns = b; },
    breakPad() { broken = true; },
    pendingTimers: () => timers.size,
    brakeCount: () => calls.filter(([n]) => n === 'brakeDrive').length,
    // A live rAF tick: fires any due watchdog timers, then the poll.
    tick(n = 1, ms = 16) {
      for (let i = 0; i < n; i++) {
        clock += ms; runDue();
        const fn = pending; pending = null; fn?.();
      }
    },
    // Time passing with no frames — the tab is suspended.
    advance(ms) { clock += ms; runDue(); },
  };
}

test('the module exports the TTL and watchdog constants', () => {
  assert.equal(PERMOTOR_TTL_MS, 1000);
  assert.equal(PERMOTOR_WATCHDOG_MS, 500);
});

test('the constructor accepts injected time/timer options without throwing', () => {
  assert.doesNotThrow(() => new GamepadController(
    { roles: {}, driveThrottle() {}, brakeDrive() {}, setMotorSpeedRaw() {},
      brakeMotor() {}, driveTank() {}, invertedPorts: new Set() },
    { driveA: 1, driveB: 2, steer: null }, null, () => true, null,
    { now: () => 0, schedule: () => 1, cancel: () => {}, permotorTtlMs: 1000, watchdogMs: 500 },
  ));
});

test('linked: a held throttle whose frames stop is braked after the TTL', () => {
  const h = harness();
  h.set([0, 0, 0, 0], { 7: 1 });        // full throttle on the triggers
  h.tick(1);                            // one commanding frame arms the watchdog
  assert.ok(h.pendingTimers() >= 1, 'a non-zero drive frame must arm the watchdog');
  h.advance(2000);                      // frames stop; time passes past the TTL
  assert.equal(h.brakeCount(), 1, 'the stalled drive must be braked exactly once');
});

test('linked: a continuously refreshed throttle is never braked', () => {
  const h = harness();
  h.set([0, 0, 0, 0], { 7: 1 });        // full throttle on the triggers
  h.tick(200);                          // ~3.2s of a held, refreshed stick
  assert.equal(h.brakeCount(), 0, 'a live, held stick holds — the dead-man must not fire');
});

test('linked: a zero-drive frame arms no watchdog', () => {
  const h = harness();
  h.set([0, 0, 0, 0]);
  h.tick(1);
  assert.equal(h.pendingTimers(), 0, 'a resting car must not arm the watchdog');
  const before = h.brakeCount();
  h.advance(3000);
  assert.equal(h.brakeCount(), before, 'nothing may be braked while idle');
});

test('tracked: a stalled non-zero command is braked after the TTL', async () => {
  const h = harness();
  await h.controller.setDriveMode('tracked');
  h.calls.length = 0;
  h.set([0, -1, 0, 0]);                 // tank throttle on the left stick
  h.tick(1);
  assert.ok(h.pendingTimers() >= 1);
  h.advance(2000);
  assert.equal(h.brakeCount(), 1);
});

test('independent: a stalled non-zero command is braked after the TTL', async () => {
  const h = harness();
  await h.controller.setDriveMode('independent');
  h.calls.length = 0;
  h.set([0, 0, 0, 0], { 7: 1 });        // motor A on the triggers
  h.tick(1);
  assert.ok(h.pendingTimers() >= 1);
  h.advance(2000);
  assert.equal(h.brakeCount(), 1);
});

test('independent: the brake does not deduplicate the command that resumes driving', async () => {
  // The stale-brake resets every per-motor dedup, #lastSent included. Without
  // that, instant ramp re-commands the exact pre-brake value, #send sees no
  // change and skips it, and the motor stays braked under a live stick.
  const h = harness();
  await h.controller.setDriveMode('independent');
  h.controller.params.rampMode = 'instant';   // no ramp climb to accidentally break the dedup
  h.calls.length = 0;
  h.set([0, 0, 0, 0], { 7: 1 });              // motor A full
  h.tick(1);
  assert.ok(h.pendingTimers() >= 1, 'a non-zero independent frame arms the watchdog');
  h.advance(2000);                            // frames stall → stale-brake
  assert.equal(h.brakeCount(), 1);
  h.calls.length = 0;
  h.tick(1);                                   // same held stick, focus fine
  assert.ok(h.calls.some(([n, , s]) => n === 'setMotorSpeedRaw' && s !== 0),
    'after the dead-man brake the same held command must re-reach the motor, not be deduped away');
});

test('stop() tears the watchdog down and it never fires afterwards', () => {
  const h = harness();
  h.set([0, 0, 0, 0], { 7: 1 });
  h.tick(1);
  assert.ok(h.pendingTimers() >= 1);
  h.controller.stop();
  assert.equal(h.pendingTimers(), 0, 'stop() must cancel the watchdog');
  const before = h.brakeCount();
  h.advance(3000);
  assert.equal(h.brakeCount(), before, 'a torn-down watchdog may not fire');
});

test('a crash in the loop tears the watchdog down too', () => {
  const h = harness();
  h.set([0, 0, 0, 0], { 7: 1 });
  h.tick(1);
  assert.ok(h.pendingTimers() >= 1);
  h.breakPad();
  h.tick(1);                            // the poll throws → crash teardown
  assert.equal(h.pendingTimers(), 0, 'the crash path must clear the watchdog');
});

test('leaving a per-motor mode strands no watchdog', async () => {
  const h = harness();
  h.set([0, 0, 0, 0], { 7: 1 });
  h.tick(1);
  assert.ok(h.pendingTimers() >= 1);
  await h.controller.setDriveMode('linked');   // re-select clears mode state
  assert.equal(h.pendingTimers(), 0, 'a mode change must not leave a timer standing');
});

test('the drive dead-man brakes the drive when its frames stall', () => {
  const h = harness();
  h.set([0, 0, 0, 0], { 7: 1 });        // full throttle on the triggers
  h.tick(1);
  h.advance(2000);                      // the drive dead-man brakes the car
  assert.equal(h.brakeCount(), 1, 'the drive was braked');
});
