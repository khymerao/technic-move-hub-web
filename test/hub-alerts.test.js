import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeHubAlertSubscribe } from '../src/lwp-encoders.js';
import { parseHubAlert, HUB_ALERT, HUB_ALERT_NAME } from '../src/lwp-decoders.js';

test('encodeHubAlertSubscribe: enables updates for one alert type', () => {
  assert.deepEqual(
    [...encodeHubAlertSubscribe(HUB_ALERT.HIGH_CURRENT)],
    [0x05, 0x00, 0x03, 0x02, 0x01],
  );
});

test('HUB_ALERT_NAME: every alert type has a name', () => {
  for (const type of Object.values(HUB_ALERT)) {
    assert.equal(typeof HUB_ALERT_NAME[type], 'string');
  }
});

test('parseHubAlert: an active alert', () => {
  // [len, hubId, 0x03, alertType=0x02, operation=0x04 (Update), payload=0xff]
  const a = parseHubAlert(Uint8Array.of(0x06, 0x00, 0x03, 0x02, 0x04, 0xff));
  assert.deepEqual(a, {
    alert: 0x02, name: 'high-current', operation: 0x04, active: true,
  });
});

test('parseHubAlert: the same alert clearing', () => {
  const a = parseHubAlert(Uint8Array.of(0x06, 0x00, 0x03, 0x02, 0x04, 0x00));
  assert.equal(a.active, false);
});

test('parseHubAlert: low signal strength', () => {
  const a = parseHubAlert(Uint8Array.of(0x06, 0x00, 0x03, 0x03, 0x04, 0xff));
  assert.equal(a.name, 'low-signal');
  assert.equal(a.active, true);
});

test('parseHubAlert: an unknown alert type still parses, with no name', () => {
  const a = parseHubAlert(Uint8Array.of(0x06, 0x00, 0x03, 0x7f, 0x04, 0xff));
  assert.equal(a.alert, 0x7f);
  assert.equal(a.name, undefined);
});

test('parseHubAlert: our own outgoing subscribe is not an update', () => {
  assert.equal(parseHubAlert(Uint8Array.of(0x05, 0x00, 0x03, 0x02, 0x01)), null);
});

test('parseHubAlert: wrong message type returns null', () => {
  assert.equal(parseHubAlert(Uint8Array.of(0x05, 0x00, 0x45, 0x3a, 0x07)), null);
});

test('parseHubAlert: too short returns null', () => {
  assert.equal(parseHubAlert(Uint8Array.of(0x03, 0x00, 0x03)), null);
});

import { LegoProtocol } from '../src/lego-protocol.js';

// The transport contract LegoProtocol relies on: an EventTarget that emits
// 'data' with a Uint8Array detail, and a sendPayload it can await.
function fakeTransport() {
  const t = new EventTarget();
  t.sent = [];
  t.sendPayload = (bytes, key) => { t.sent.push({ bytes: [...bytes], key }); };
  t.sendBurst = (frames, key) => { for (const f of frames) t.sendPayload(f, key); };
  t.feed = (bytes) => t.dispatchEvent(
    new CustomEvent('data', { detail: Uint8Array.from(bytes) }));
  return t;
}

test('subscribeHubAlerts: enables all four alert types', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  await p.subscribeHubAlerts();
  assert.deepEqual(t.sent.map((s) => s.bytes), [
    [0x05, 0x00, 0x03, 0x01, 0x01],
    [0x05, 0x00, 0x03, 0x02, 0x01],
    [0x05, 0x00, 0x03, 0x03, 0x01],
    [0x05, 0x00, 0x03, 0x04, 0x01],
  ]);
});

test('an incoming alert becomes a hub-alert event', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  const seen = [];
  p.addEventListener('hub-alert', (e) => seen.push(e.detail));
  t.feed([0x06, 0x00, 0x03, 0x02, 0x04, 0xff]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, 'high-current');
  assert.equal(seen[0].active, true);
});

test('an alert does not stop the motors: nothing is written in response', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  p.roles = { driveA: 0x32, driveB: 0x33, steer: 0x34 };
  t.feed([0x06, 0x00, 0x03, 0x02, 0x04, 0xff]);   // High Current, active
  t.feed([0x06, 0x00, 0x03, 0x04, 0x04, 0xff]);   // Over Power, active
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.sent, []);
});
