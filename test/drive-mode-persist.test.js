// The chosen drive mode has to survive a reload and a reconnect: both build a
// fresh controller, and both used to land back on the constructor default.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODE_KEY = 'lego-drive-mode-v1';

function fakeStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    _store: store,
  };
}

function stubEnv(seed) {
  globalThis.localStorage = fakeStorage(seed);
  globalThis.document = globalThis.document ?? { getElementById: () => null };
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => 0 }, configurable: true, writable: true,
  });
  return globalThis.localStorage;
}

function fakeProtocol() {
  return {
    roles: { driveA: 0x32, driveB: 0x33, steer: 0x34 },
    driveThrottle() {}, driveTank() {}, brakeDrive() {}, brakeMotor() {},
    setMotorSpeedRaw() {},
    invertedPorts: new Set([0x33]),
  };
}

const steeringStub = () => ({ mode: 'raw', jogStop() {}, setInput() {}, release() {}, stop() {} });
const playvmStub = () => ({ armed: false, async arm() { this.armed = true; return { ok: true }; }, disarm() { this.armed = false; }, set() {} });

async function build(ls, { playvm = playvmStub() } = {}) {
  globalThis.localStorage = ls;
  const { GamepadController } = await import('../src/gamepad-controller.js');
  const protocol = fakeProtocol();
  return new GamepadController(protocol, protocol.roles, steeringStub(), () => true, playvm);
}

test('a chosen drive mode is written to storage and picked up by the next controller', async () => {
  const ls = stubEnv();
  const first = await build(ls);
  await first.setDriveMode('tracked');
  assert.equal(JSON.parse(ls.getItem(MODE_KEY)), 'tracked');

  // A reconnect: the transport drops, main.js builds a new controller.
  const second = await build(ls);
  assert.equal(second.params.driveMode, 'tracked');
});

test('a stored mode that is not a drive mode falls back to the default', async () => {
  const ls = stubEnv({ [MODE_KEY]: '"nonsense"' });
  const gp = await build(ls);
  assert.equal(gp.params.driveMode, 'playvm');
});

test('a stored playvm is still downgraded when there is no combined frame to arm', async () => {
  const ls = stubEnv({ [MODE_KEY]: '"playvm"' });
  const gp = await build(ls, { playvm: null });
  assert.equal(gp.params.driveMode, 'linked');
});

test('a macro switching modes does not overwrite the stored choice', async () => {
  const ls = stubEnv({ [MODE_KEY]: '"tracked"' });
  const gp = await build(ls);
  await gp.setDriveMode('linked', { persist: false });
  assert.equal(gp.params.driveMode, 'linked');
  assert.equal(JSON.parse(ls.getItem(MODE_KEY)), 'tracked');
});

test('a failed playvm arm does not persist the linked fallback over the request', async () => {
  const ls = stubEnv({ [MODE_KEY]: '"tracked"' });
  const playvm = { armed: false, async arm() { return { ok: false, reason: 'no port' }; }, disarm() {}, set() {} };
  const gp = await build(ls, { playvm });
  await gp.setDriveMode('playvm');
  assert.equal(gp.params.driveMode, 'linked');
  assert.equal(JSON.parse(ls.getItem(MODE_KEY)), 'playvm');
});
