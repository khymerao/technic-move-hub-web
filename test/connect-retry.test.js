// Connect handshake behaviour.
//
// A hub left wedged by an earlier crash accepts the GATT connect and the service
// lookups, then never completes startNotifications — Chrome sits on that for a
// full 30s. Measured: 13.8s, then 30.0s, then 30.0s across three attempts. The
// transport therefore bounds each attempt itself and retries, and must not
// report its own teardown between attempts as the link being lost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LegoBLETransport } from '../src/ble-transport.js';

globalThis.document = globalThis.document ?? { getElementById: () => null };

// src/ble-transport.js:72 — the settle the retry waits out before trying again.
const RETRY_SETTLE_MS = 1200;

// A macrotask flush that survives mocked setTimeout: setImmediate is left alone.
async function flush(hops = 8) {
  for (let i = 0; i < hops; i++) await new Promise((r) => setImmediate(r));
}

// Whether a promise has settled YET. node:test has no per-test timeout, so a
// promise that is still pending is reported, never awaited.
function settledNow(promise) {
  promise.catch(() => {});
  return Promise.race([
    promise.then(() => 'resolved', () => 'rejected'),
    flush().then(() => 'pending'),
  ]);
}

// Builds a fake Web Bluetooth stack whose handshake fails a given number of
// times before succeeding. `hangs` makes startNotifications never settle, which
// is exactly the wedged-hub symptom.
function fakeBluetooth({ failures = 0, hangs = false } = {}) {
  let attempt = 0;
  const disconnects = [];
  const listeners = new Map();
  const characteristic = {
    addEventListener() {},
    async startNotifications() {
      attempt += 1;
      if (attempt <= failures) {
        if (hangs) return new Promise(() => {}); // never settles
        throw new Error('GATT Error Unknown.');
      }
    },
    async writeValueWithoutResponse() {},
  };
  const device = {
    name: 'Technic Move',
    gatt: {
      connected: true,
      async connect() { return { async getPrimaryService() { return { async getCharacteristic() { return characteristic; } }; } }; },
      disconnect() {
        disconnects.push(Date.now());
        // The browser fires this whenever the link drops, including our own
        // teardown between retries.
        listeners.get('gattserverdisconnected')?.();
      },
    },
    addEventListener(type, fn) { listeners.set(type, fn); },
  };
  // Node exposes navigator as a getter-only global, so it has to be redefined.
  Object.defineProperty(globalThis, 'navigator', {
    value: { bluetooth: { async requestDevice() { return device; } } },
    configurable: true, writable: true,
  });
  return {
    get attempts() { return attempt; },
    disconnects,
    // A real drop: the browser clears the flag first, then fires the event.
    drop() {
      device.gatt.connected = false;
      listeners.get('gattserverdisconnected')?.();
    },
  };
}

test('connected tracks the live GATT link', async () => {
  // src/main.js:141 refuses a second connect on this getter alone; a stale true
  // there builds a second transport over a live one, and the old instance's
  // handler later paints its own loss over a working session.
  const fake = fakeBluetooth();
  const t = new LegoBLETransport();
  assert.equal(t.connected, false, 'no device picked yet');

  await t.connect({ attempts: 4, timeoutMs: 500 });
  assert.equal(t.connected, true);

  fake.drop();
  assert.equal(t.connected, false, 'a dropped link must not read as connected');
});

test('connects on the first attempt when the hub is healthy', async () => {
  const fake = fakeBluetooth();
  const t = new LegoBLETransport();
  const events = [];
  t.addEventListener('connected', () => events.push('connected'));
  t.addEventListener('disconnected', () => events.push('disconnected'));

  await t.connect({ attempts: 4, timeoutMs: 500 });
  assert.deepEqual(events, ['connected']);
  assert.equal(fake.attempts, 1);
});

test('retries past a failing handshake and reports success once', async () => {
  const fake = fakeBluetooth({ failures: 2 });
  const t = new LegoBLETransport();
  const events = [];
  t.addEventListener('connected', () => events.push('connected'));
  t.addEventListener('disconnected', () => events.push('disconnected'));

  await t.connect({ attempts: 4, timeoutMs: 500 });
  assert.equal(fake.attempts, 3, 'must keep trying after a failed handshake');
  assert.deepEqual(events, ['connected'],
    'teardown between retries must not surface as a lost link');
});

test('a hanging startNotifications is bounded, not waited on', async (t) => {
  // Without the bound this would sit for Chrome's 30s timeout, three times over.
  //
  // The old form allowed 5000ms of wall clock for a 120ms bound and a 1200ms
  // settle. A wide budget is still a budget: it never distinguished a bound
  // that fired at 120 from one that fired at 4000, it passed on a machine where
  // the hang was never entered at all, and on a loaded machine it could fail a
  // bound that was working perfectly. The clock is injected instead, and the
  // claim is put where it lives — the hang is abandoned AT the bound and not a
  // tick before, the retry waits out the settle, and the second attempt running
  // at all is what proves the first was cut short rather than waited on.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeBluetooth({ failures: 1, hangs: true });
  const attempt = new LegoBLETransport().connect({ attempts: 3, timeoutMs: 120 });
  await flush();
  assert.equal(fake.attempts, 1, 'the first handshake is in flight, and it will never answer');

  // Tearing the stale link down is what the transport does the moment it gives
  // up on an attempt, so it is the observable that says WHEN it gave up.
  t.mock.timers.tick(119);
  await flush();
  assert.deepEqual(fake.disconnects, [],
    'the bound has not come due, so the attempt has not been given up on');
  assert.equal(fake.attempts, 1);
  assert.equal(await settledNow(attempt), 'pending');

  t.mock.timers.tick(1);
  await flush();
  assert.equal(fake.disconnects.length, 1, 'the hang was abandoned at the bound, not before it');
  assert.equal(fake.attempts, 1, 'and the retry still owes the hub its settle');
  assert.equal(await settledNow(attempt), 'pending');

  t.mock.timers.tick(RETRY_SETTLE_MS);
  await flush();
  assert.equal(fake.attempts, 2, 'a second attempt at all is what proves the first was cut short');
  assert.equal(await settledNow(attempt), 'resolved', 'and it is the one that connects');
  await attempt;
});

test('gives up after the attempt budget and reports the link lost exactly once', async () => {
  fakeBluetooth({ failures: 99 });
  const t = new LegoBLETransport();
  const reasons = [];
  t.addEventListener('disconnected', (e) => reasons.push(e.detail?.reason));

  await assert.rejects(t.connect({ attempts: 2, timeoutMs: 100 }));
  assert.equal(reasons.length, 1,
    'both the failure path and gattserverdisconnected can fire; the app must hear one');
});

test('writes are dropped once the link is gone instead of throwing every frame', async () => {
  fakeBluetooth({ failures: 99 });
  const t = new LegoBLETransport();
  t.addEventListener('disconnected', () => {});
  await assert.rejects(t.connect({ attempts: 1, timeoutMs: 100 }));

  // Control loops keep calling for a while after a drop; each call throwing
  // would flood the log with identical GATT errors.
  assert.doesNotThrow(() => t.sendPayload(Uint8Array.of(1, 2, 3)));
  assert.doesNotThrow(() => t.sendBurst([Uint8Array.of(1)], 'drive'));
});
