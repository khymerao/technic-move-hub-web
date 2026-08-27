// The focus gate. An unfocused tab hands back a frozen navigator.getGamepads(),
// so the loop would command the car from a stick reading that can no longer
// change. While the tab is not focused (or is hidden) the loop must poll and
// report but command nothing, and the return to focus must start a fresh frame
// rather than a stale one.
//
// See docs/DESIGN-NOTES.md § The focus gate is the fresh-input signal the loop was missing
// See docs/DESIGN-NOTES.md § Coming back from unfocused starts a fresh frame, not a stale one

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { getElementById: () => null };
const { GamepadController } = await import('../src/gamepad-controller.js');

const buttons = (over = {}) => Array.from({ length: 17 }, (_, i) => ({
  value: over[i] ?? 0, pressed: (over[i] ?? 0) > 0.5,
}));

// A rig with a controllable `document` (hasFocus / visibilityState), a live pad
// whose axes/buttons the test can move, and a single-step frame driver.
function harness({ steering = false, playvm = null } = {}) {
  let clock = 0;
  let pending = null;
  let axes = [0, 0, 0, 0];
  let btns = {};
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };

  const doc = { getElementById: () => null };
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock }, configurable: true, writable: true,
  });
  const getGamepads = () => [{
    id: 'test pad', mapping: 'standard', connected: true,
    timestamp: clock, axes: [...axes], buttons: buttons(btns),
  }];
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads }, configurable: true, writable: true,
  });
  globalThis.requestAnimationFrame = (fn) => { pending = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { pending = null; };

  // Controllable timers so the per-motor watchdog uses no real setTimeout, which
  // would otherwise keep this test process alive and hang the runner. These
  // tests never fire the watchdog — gamepad-deadman.test.js covers that.
  const timers = new Map();
  let nextId = 1;
  const now = () => clock;
  const schedule = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; };
  const cancel = (id) => { timers.delete(id); };

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
  const steer = steering
    ? {
      mode: 'raw', target: 0, params: { autoReturn: true },
      jogStop() {}, setZero() { calls.push(['setZero']); }, stop() {},
      setInput(v) { this.target = Math.round(v); },
      release() { this.target = 0; },
    }
    : null;
  const controller = new GamepadController(protocol, protocol.roles, steer, () => true, playvm,
    { now, schedule, cancel });
  controller.start();

  return {
    controller, calls, doc, steer,
    set(a, b = {}) { axes = a; btns = b; },
    frame(n = 1, ms = 16) {
      for (let i = 0; i < n; i++) {
        clock += ms;
        const fn = pending; pending = null; fn?.();
      }
    },
  };
}

// Any write that actually drives a motor, whatever the mode.
const commanded = (calls) => calls.filter(([n, ...a]) => (
  (n === 'driveThrottle' && a[0] !== 0)
  || (n === 'driveTank' && (a[0] !== 0 || a[1] !== 0))
  || (n === 'setMotorSpeedRaw' && a[1] !== 0)
));

test('an unfocused tab commands nothing, though the stick reads full throttle', () => {
  const h = harness();
  h.doc.hasFocus = () => false;
  h.set([0, 0, 0, 0], { 7: 1 });        // full forward (RT — this edition's throttle)
  h.frame(10);
  assert.deepEqual(commanded(h.calls), [],
    'a frozen unfocused pad must not reach the motors');
});

test('a hidden tab commands nothing even while focused', () => {
  const h = harness();
  h.doc.hasFocus = () => true;
  h.doc.visibilityState = 'hidden';
  h.set([0, 0, 0, 0], { 7: 1 });        // full forward (RT)
  h.frame(10);
  assert.deepEqual(commanded(h.calls), [],
    'visibilityState hidden must suppress commanding');
});

test('watch reporting is unchanged by focus — the guard sits after the watch branch', () => {
  const h = harness();
  h.controller.watch();
  h.doc.hasFocus = () => false;
  let inputs = 0;
  h.controller.addEventListener('input', () => { inputs += 1; });
  h.set([0, -1, 0, 0]);
  h.frame(3);
  assert.ok(inputs > 0, 'a move must still be reported to the macro while unfocused');
});

test('a document with no hasFocus defaults LIVE and still drives', () => {
  const h = harness();
  delete h.doc.hasFocus;                // the node stub shape
  h.set([0, 0, 0, 0], { 7: 1 });        // full forward (RT)
  h.frame(5);
  assert.ok(commanded(h.calls).length > 0,
    'the guard must default LIVE when hasFocus is absent, or every gamepad test crashes');
});

test('the return to focus is a fresh frame, not a multi-second dt spike', () => {
  // Same run, twice, differing only in the clock jump on the return frame. With
  // the edge reset the return frame reseeds dt to ~16ms, so the ramp step is the
  // same however long the tab was away; without it the frozen #lastFrameAt makes
  // dt the whole absence and the ramp jumps.
  function returnValue(returnDeltaMs) {
    const h = harness();
    h.doc.hasFocus = () => true;
    h.set([0, 0, 0, 0]);                // centred: builds #lastFrameAt at rest
    h.frame(3);
    h.doc.hasFocus = () => false;
    h.set([0, 0, 0, 0], { 7: 1 });      // full throttle (RT), suppressed
    h.frame(3);
    h.doc.hasFocus = () => true;
    h.frame(1, returnDeltaMs);          // the return frame, after the jump
    const d = [...h.calls].reverse().find(([n]) => n === 'driveThrottle');
    return d ? d[1] : 0;
  }
  const brief = returnValue(16);
  const long = returnValue(5000);
  assert.ok(brief > 0, 'the return frame must command the held throttle');
  assert.equal(brief, long,
    'the return frame dt is seeded fresh, so a 5s absence ramps no differently than a 16ms one');
});

test('an unfocused tab never renews the playvm dead-man', () => {
  // The primary hazard: in playvm mode a frozen full-throttle stick would keep
  // calling playvm.set(), renewing #lastSetAt and permanently defeating the
  // dead-man TTL. The focus gate returns before the playvm branch, so set() must
  // never be reached while unfocused. See docs/DESIGN-NOTES.md § The focus gate is the fresh-input signal the loop was missing
  const sets = [];
  const playvm = { armed: true, set: (...a) => sets.push(a), stop() {} };
  const h = harness({ playvm });
  assert.equal(h.controller.params.driveMode, 'playvm',
    'a playvm collaborator selects playvm mode');
  h.doc.hasFocus = () => false;
  h.set([0, 0, 0, 0], { 7: 1 });        // full forward (RT), frozen
  h.frame(10);
  assert.deepEqual(sets, [],
    'playvm.set must never fire while unfocused, or #lastSetAt renews and the dead-man never releases');
  h.doc.hasFocus = () => true;
  h.frame(1);
  assert.ok(sets.length > 0,
    'the same throttle drives playvm.set once focus returns — the gate, not the mode, was the suppressor');
});

test('an edge-mapped button held across a blur does not misfire on return', () => {
  // Spec 1c: no edge action misfires on return. Start (driveModeToggle, index 9)
  // held across a guard-only blur (loop never torn down) must read as already-down
  // on the return frame, not as a fresh rising edge that flips the drive mode.
  // See docs/DESIGN-NOTES.md § Coming back from unfocused starts a fresh frame, not a stale one
  const h = harness();
  h.doc.hasFocus = () => true;
  h.set([0, 0, 0, 0], { 9: 1 });        // Start held (driveModeToggle), from focus
  h.frame(2);
  const mode = h.controller.params.driveMode;
  h.doc.hasFocus = () => false;
  h.frame(5);                           // guard-only blur, Start still held
  h.doc.hasFocus = () => true;
  h.frame(1);                           // the return frame
  assert.equal(h.controller.params.driveMode, mode,
    'a button held through the blur must not register as a press on return');
});

test('a hold-guarded edge does not misfire across a blur', () => {
  // steerZero is hold-guarded at 1000ms. Held across the blur, the #holdSince
  // clock is cleared on the return edge, so the return frame cannot read the old
  // press as having satisfied the hold.
  const h = harness({ steering: true });
  h.doc.hasFocus = () => true;
  h.set([0, 0, 0, 0], { 8: 1 });        // Back held (steerZero), from focus
  h.frame(2);
  h.doc.hasFocus = () => false;
  h.frame(30);                          // long enough to pass 1000ms unfocused
  h.doc.hasFocus = () => true;
  const before = h.calls.filter(([n]) => n === 'setZero').length;
  h.frame(1);
  const after = h.calls.filter(([n]) => n === 'setZero').length;
  assert.equal(after, before,
    'a press held through the blur must not fire setZero on the return frame');
});
