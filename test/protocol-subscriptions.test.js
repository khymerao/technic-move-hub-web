import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LegoProtocol } from '../src/lego-protocol.js';
import { SteeringController } from '../src/steering-controller.js';

function fakeTransport() {
  const t = new EventTarget();
  t.sent = [];
  t.sendPayload = (bytes, key) => { t.sent.push({ bytes: [...bytes], key }); };
  t.sendBurst = (frames, key) => { for (const f of frames) t.sendPayload(f, key); };
  t.feed = (bytes) => t.dispatchEvent(
    new CustomEvent('data', { detail: Uint8Array.from(bytes) }));
  return t;
}

// InputFormatSetup is [0x0a,0x00,0x41,port,mode,d0,d1,d2,d3,notify].
const setups = (t) => t.sent
  .filter((s) => s.bytes[2] === 0x41)
  .map((s) => ({
    port: s.bytes[3], mode: s.bytes[4],
    delta: s.bytes[5] | (s.bytes[6] << 8) | (s.bytes[7] << 16) | (s.bytes[8] << 24),
    notify: s.bytes[9],
  }));

test('two holders on one stream produce one setup', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  await p.subscribeToSpeed(0x32, 5, 'telemetry');
  await p.subscribeToSpeed(0x32, 20, 'macro');
  assert.deepEqual(setups(t), [{ port: 0x32, mode: 0x01, delta: 5, notify: 1 }]);
});

test('a finer delta re-sets the stream up', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  await p.subscribeToAccel(900, 0x38, 'collision');
  await p.subscribeToAccel(100, 0x38, 'macro');
  assert.deepEqual(setups(t), [
    { port: 0x38, mode: 0x00, delta: 900, notify: 1 },
    { port: 0x38, mode: 0x00, delta: 100, notify: 1 },
  ]);
});

test('releasing the finer holder restores the collision guard delta', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  await p.subscribeToAccel(900, 0x38, 'collision');
  await p.subscribeToAccel(100, 0x38, 'macro');
  t.sent.length = 0;
  await p.releaseStreams('macro');
  assert.deepEqual(setups(t), [{ port: 0x38, mode: 0x00, delta: 900, notify: 1 }]);
  assert.equal(p._accelPort, 0x38, 'the guard still has its stream');
});

test('releasing the last holder disables the stream', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  await p.subscribeToSpeed(0x32, 5, 'macro');
  t.sent.length = 0;
  await p.releaseStreams('macro');
  assert.deepEqual(setups(t), [{ port: 0x32, mode: 0x01, delta: 0, notify: 0 }]);
  assert.equal(p._speedPorts.has(0x32), false);
});

test('Rule 7: asking for speed on a port already streaming position throws', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  await p.subscribeToPosition(0x34, 2, 'steering');
  await assert.rejects(
    () => p.subscribeToSpeed(0x34, 2, 'macro'),
    /already streaming mode 0x2/,
  );
  assert.equal(p._posPorts.has(0x34), true, 'the steering stream survives the refusal');
  assert.equal(p._speedPorts.has(0x34), false);
});

test('Rule 7: the refusal writes nothing to the hub', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  await p.subscribeToPosition(0x34, 2, 'steering');
  t.sent.length = 0;
  await assert.rejects(() => p.subscribeToSpeed(0x34, 2, 'macro'));
  assert.deepEqual(t.sent, []);
});

test('position values still reach listeners after the registry rewrite', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  await p.subscribeToPosition(0x34, 2, 'steering');
  const seen = [];
  p.addEventListener('position', (e) => seen.push(e.detail));
  // [len,0x00,0x45,port, int32 LE]
  t.feed([0x08, 0x00, 0x45, 0x34, 0x2d, 0x00, 0x00, 0x00]);
  assert.deepEqual(seen, [{ port: 0x34, pos: 45 }]);
});

test('unsubscribeTelemetry only drops what the app holds', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  await p.subscribeToSpeed(0x32, 5, 'app');
  await p.subscribeToSpeed(0x32, 5, 'macro');
  t.sent.length = 0;
  await p.unsubscribeTelemetry();
  assert.deepEqual(setups(t), [], 'the macro is still holding it');
  assert.equal(p._speedPorts.has(0x32), true);
});

// See docs/DESIGN-NOTES.md § Re-entering steer mode must re-subscribe — a
// dead position stream must be revivable, so the registry's dedup must not
// govern this path when the caller forces it.
test('a forced re-subscribe by the same holder at the same delta still writes a setup', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  await p.subscribeToPosition(0x34, 15, 'steering');
  t.sent.length = 0;
  await p.subscribeToPosition(0x34, 15, 'steering', true);
  assert.deepEqual(setups(t), [{ port: 0x34, mode: 0x02, delta: 15, notify: 1 }]);
});

test('an ordinary re-subscribe by the same holder at the same delta writes nothing', async () => {
  const t = fakeTransport();
  const p = new LegoProtocol(t);
  await p.subscribeToPosition(0x34, 15, 'steering');
  t.sent.length = 0;
  await p.subscribeToPosition(0x34, 15, 'steering');
  assert.deepEqual(setups(t), []);
});

test('subscribeOrientation sets up the orientation port at the mode it was given', async () => {
  const t = fakeTransport();
  const protocol = new LegoProtocol(t);
  await protocol.subscribeOrientation(0x00, 40, 'motion');
  assert.deepEqual(setups(t), [{ port: 0x3b, mode: 0x00, delta: 40, notify: 1 }]);
});

test('an orientation value frame becomes an orientation event with four words', async () => {
  const t = fakeTransport();
  const protocol = new LegoProtocol(t);
  await protocol.subscribeOrientation(0x00, 40, 'motion');
  const seen = [];
  protocol.addEventListener('orientation', (e) => seen.push(e.detail.values));
  t.feed([0x0c, 0x00, 0x45, 0x3b, 0x00, 0x40, 0x00, 0x20, 0x00, 0x10, 0x00, 0x08]);
  assert.deepEqual(seen, [[0x4000, 0x2000, 0x1000, 0x0800]]);
});

test('an orientation frame still reaches the untyped passthrough the probe uses', async () => {
  const t = fakeTransport();
  const protocol = new LegoProtocol(t);
  await protocol.subscribeOrientation(0x00, 40, 'motion');
  const seen = [];
  protocol.addEventListener('port-value', (e) => seen.push(e.detail.port));
  t.feed([0x0c, 0x00, 0x45, 0x3b, 0x00, 0x40, 0x00, 0x20, 0x00, 0x10, 0x00, 0x08]);
  assert.deepEqual(seen, [0x3b]);
});

test('releaseStreams drops the orientation stream the holder was keeping', async () => {
  const t = fakeTransport();
  const protocol = new LegoProtocol(t);
  await protocol.subscribeOrientation(0x00, 40, 'motion');
  await protocol.releaseStreams('motion');
  const disables = t.sent.filter((s) => s.bytes[2] === 0x41 && s.bytes[9] === 0x00);
  assert.equal(disables.length, 1);
  assert.equal(disables[0].bytes[3], 0x3b);
});

test('a mismatched-mode re-subscribe throws without corrupting the original holder', async () => {
  const t = fakeTransport();
  const protocol = new LegoProtocol(t);
  await protocol.subscribeOrientation(0x00, 40, 'motion');
  await assert.rejects(
    () => protocol.subscribeOrientation(0x01, 40, 'other'),
    /already streaming mode 0x0/,
  );
  await protocol.unsubscribeOrientation('motion');
  const disables = t.sent.filter((s) => s.bytes[2] === 0x41 && s.bytes[9] === 0x00);
  assert.equal(disables.length, 1, 'the originally acquired mode 0x00 stream must still be releasable');
  assert.equal(disables[0].bytes[3], 0x3b);
  assert.equal(disables[0].bytes[4], 0x00, 'released at the mode that was actually acquired');
  assert.equal(protocol._orintPort, null);
});

test('entering steer mode registers as a holder even when another stream keeps feedback fresh', async () => {
  const t = fakeTransport();
  const protocol = new LegoProtocol(t);
  const STEER = 0x34;
  // The panel gets there first.
  await protocol.subscribeToPosition(STEER, 15, 'motion');
  const steering = new SteeringController(protocol, STEER);
  // A position frame from the panel's stream refreshes the controller's clock.
  t.feed([0x08, 0x00, 0x45, STEER, 0x2c, 0x01, 0x00, 0x00]);
  await steering.enterSteerMode();

  // The panel goes away. The P-loop is still running.
  await protocol.releaseStreams('motion');

  const disables = t.sent.filter((s) => s.bytes[2] === 0x41 && s.bytes[9] === 0x00);
  assert.deepEqual(disables, [],
    'releasing the panel disabled the stream the P-loop is running on');
});
