// The panel's enable/disable label must never disagree with the controller's
// real armed state. `GamepadController.armed` is the single source of truth;
// src/ui/gamepad.js paints from it and repaints on the 'armed' event, rather
// than keeping a duplicate local flag that can drift once watch()/unwatch()
// or a refused stop() move the loop out from under the panel's own toggle.
//
// Concrete hazard this guards against: pad armed for real driving, a macro
// starts and watches the same loop without owning it, the operator clicks
// the panel toggle mid-run (refused — see gamepad-controller.js's `stop()`),
// the run ends and the loop resumes commanding — with the label never told.
// An operator reading "pad: OFF" at that point has no reason to keep hands
// clear of a car that is, in fact, live.

import { test } from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor() {
    this.textContent = '';
    this.value = '0';
    this.dataset = {};
    this.innerHTML = '';
    this.attrs = new Map();
    this.style = { _p: new Map(), setProperty(n, v) { this._p.set(n, String(v)); }, getPropertyValue(n) { return this._p.get(n) ?? ''; }, removeProperty(n) { this._p.delete(n); } };
    this._events = new Map();
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
  }
  append() {}
  replaceChildren() {}
  // The mapping panel draws the pad as inline SVG: attributes, custom
  // properties and a group lookup, none of which a bare stub answers.
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  querySelectorAll() { return []; }
  addEventListener(type, fn) { this._events.set(type, fn); }
  removeEventListener(type) { this._events.delete(type); }
  fire(type, ev = {}) {
    const fn = this._events.get(type);
    if (fn) fn({ preventDefault() {}, target: this, ...ev });
  }
}

// Drives the real GamepadController and the real panel module together,
// with fake time/rAF (mirrors test/gamepad-watch.test.js's harness) and a
// minimal auto-vivifying DOM (mirrors test/ui-smoke.test.js's harness).
async function setup() {
  let clock = 0;
  const pending = new Map();
  let nextId = 1;
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock }, configurable: true, writable: true,
  });
  globalThis.requestAnimationFrame = (fn) => { const id = nextId++; pending.set(id, fn); return id; };
  globalThis.cancelAnimationFrame = (id) => { pending.delete(id); };
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      getGamepads: () => [{
        id: 'test pad', connected: true, mapping: 'standard', timestamp: 1,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
      }],
    },
    configurable: true, writable: true,
  });
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const byId = new Map();
  globalThis.document = {
    createElement: () => new El(),
    createElementNS: () => new El(),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, new El());
      return byId.get(id);
    },
  };

  const { GamepadController } = await import('../src/gamepad-controller.js');
  const protocol = {
    roles: { driveA: 0x32, driveB: 0x33, steer: 0x34, led: 0x3f, lights: 0x35 },
    driveThrottle() {}, driveTank() {}, brakeDrive() {}, setMotorSpeedRaw() {},
    brakeMotor() {}, setLights() {}, setLed() {}, sendRaw() {},
    invertedPorts: new Set(),
  };
  const gamepad = new GamepadController(protocol, protocol.roles, null);
  const hub = { gamepad, protocol };
  const { initGamepadPanel } = await import('../src/ui/gamepad.js');
  const panel = initGamepadPanel(hub, {});
  panel.attach(gamepad);

  const tick = (msPerFrame = 16) => {
    clock += msPerFrame;
    const due = [...pending.entries()];
    pending.clear();
    for (const [, fn] of due) fn();
  };
  const label = () => byId.get('gp-label').textContent;
  const toggle = () => byId.get('gp-enable').fire('click');
  return { gamepad, panel, tick, label, toggle };
}

test('the enable label agrees with the controller\'s real armed state through arm -> watch -> toggle -> unwatch', async () => {
  const { gamepad, panel, tick, label, toggle } = await setup();

  const assertSynced = (why) => {
    const shown = label();
    assert.equal(shown === 'pad: ARMED', gamepad.armed, `${why}: label says "${shown}" but armed=${gamepad.armed}`);
    assert.equal(panel.running, gamepad.armed, `${why}: panel.running must mirror gamepad.armed`);
    // The specific hazard: never OFF while actually still commanding.
    assert.ok(!(shown === 'pad: OFF' && gamepad.armed), `${why}: showed OFF while armed`);
  };

  // 1. Operator arms the pad for real driving, before any run.
  toggle();
  assert.equal(gamepad.armed, true, 'first click must arm the pad');
  assertSynced('after arming');

  // 2. A macro starts; watch() finds a loop already running and does not own it.
  gamepad.watch();
  assert.equal(gamepad.armed, false, 'watching must suppress armed even on a pre-existing loop');
  assertSynced('once watching begins');

  // 3 & 4. Two toggle clicks mid-run, exactly as an operator could issue them,
  // not knowing stop() will be refused while watching.
  toggle();
  assertSynced('after the first toggle click mid-run');
  toggle();
  assertSynced('after the second toggle click mid-run');

  // 5. The abort path is still alive throughout — confirmed by a resting
  // frame producing no motor-relevant side effect and no crash.
  tick();
  assertSynced('after a poll frame mid-run');

  // 6. The run ends. watch() never owned this loop, so it keeps running —
  // the label must catch up to that on its own, with no further click.
  gamepad.unwatch();
  assertSynced('once the run ends');
  assert.equal(gamepad.armed, true, 'a loop watch() did not own must resume commanding once the run ends');
  assert.equal(label(), 'pad: ARMED', 'the label must resync to ARMED without a click');

  gamepad.stop();
  assertSynced('after the operator finally turns the pad off');
});

test('the enable label agrees with reality when watch() does own the loop', async () => {
  const { gamepad, tick, label, toggle } = await setup();

  // Pad off before the run — watch() must start its own loop and own it.
  gamepad.stop();
  assert.equal(label(), 'pad: OFF');

  gamepad.watch();
  assert.equal(gamepad.armed, false, 'watching commands nothing even when it owns the loop');
  assert.equal(label(), 'pad: OFF');

  toggle(); // operator clicks mid-run: refused, must not flip the label to ARMED
  assert.equal(label(), 'pad: OFF', 'a refused stop must not be painted as a change');
  assert.equal(gamepad.armed, false);

  tick();
  assert.equal(label(), 'pad: OFF');

  // Run ends: watch() owned this loop, so unwatch() tears it down — the pad
  // returns to genuinely off, matching the label the whole time.
  gamepad.unwatch();
  assert.equal(gamepad.armed, false);
  assert.equal(label(), 'pad: OFF');
});
