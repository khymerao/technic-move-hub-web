// A slider moved before a controller exists must not be silently discarded.
//
// The panel is built at page load; the controller is built on connect. The
// tuning handlers wrote straight through to `hub.gamepad.params`, so anything
// adjusted while disconnected went nowhere and the controller then started on
// its own defaults — with the panel showing numbers it was not obeying. From
// the operator's side that is indistinguishable from a slider that does
// nothing, which is exactly how it was reported.
//
// See docs/DESIGN-NOTES.md § Sliders carry integers; `scale` converts

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

async function setup() {
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => 0 }, configurable: true, writable: true,
  });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => [] }, configurable: true, writable: true,
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
    roles: { driveA: 0x32, driveB: 0x33, steer: null, led: 0x3f, lights: 0x35 },
    driveThrottle() {}, driveTank() {}, brakeDrive() {}, setMotorSpeedRaw() {},
    brakeMotor() {}, setLights() {}, setLed() {}, sendRaw() {},
    invertedPorts: new Set(),
  };
  // hub.gamepad stays null: this is the disconnected page.
  const hub = { gamepad: null, protocol };
  const { initGamepadPanel } = await import('../src/ui/gamepad.js');
  const panel = initGamepadPanel(hub, {});

  const slide = (id, raw) => {
    const el = byId.get(id);
    el.value = String(raw);
    el.fire('input');
  };
  const shown = (id) => byId.get(`${id}-out`).textContent;
  const connect = () => {
    const gamepad = new GamepadController(protocol, protocol.roles, null);
    hub.gamepad = gamepad;
    panel.attach(gamepad);
    return gamepad;
  };
  return { slide, shown, connect, panel };
}

test('sliders set before connecting reach the controller when it appears', async () => {
  const { slide, connect } = await setup();

  slide('gp-dz', 30);
  slide('gp-expo', 18);
  slide('gp-max', 40);
  slide('gp-gain', 85);

  const gamepad = connect();
  assert.equal(gamepad.params.deadzone, 0.30);
  assert.equal(gamepad.params.expo, 1.8);
  assert.equal(gamepad.params.maxSpeed, 40);
  assert.equal(gamepad.params.steerGain, 85);
});

test('the readout follows the slider whether or not anything is connected', async () => {
  const { slide, shown } = await setup();

  slide('gp-expo', 25);
  assert.equal(shown('gp-expo'), '2.5');
  slide('gp-dz', 7);
  assert.equal(shown('gp-dz'), '0.07');
});

test('a slider moved after connecting still writes straight through', async () => {
  const { slide, connect } = await setup();
  const gamepad = connect();

  slide('gp-max', 45);
  assert.equal(gamepad.params.maxSpeed, 45);
});

test('a second controller inherits the sliders, not the class defaults', async () => {
  const { slide, connect } = await setup();
  slide('gp-max', 90);
  connect();
  const second = connect();

  assert.equal(second.params.maxSpeed, 90, 'a reconnect must not silently reset the feel');
});
