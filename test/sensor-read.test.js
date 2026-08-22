import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LegoProtocol } from '../src/lego-protocol.js';

function fakeTransport() {
  const sent = [];
  const t = new EventTarget();
  t.queueDepth = 0;
  t.sendPayload = (bytes) => { sent.push([...bytes]); };
  t.sent = sent;
  t.deliver = (bytes) => t.dispatchEvent(new CustomEvent('data', { detail: Uint8Array.from(bytes) }));
  return t;
}

test('a one-shot read resolves with the datasets the hub answered', async () => {
  const transport = fakeTransport();
  const protocol = new LegoProtocol(transport);
  const reading = protocol.readPortValue(0x38);
  assert.deepEqual(transport.sent.at(-1), [0x05, 0x00, 0x21, 0x38, 0x00],
    'the request goes out before anything is awaited');
  transport.deliver([0x0a, 0x00, 0x45, 0x38, 0xb3, 0xfe, 0xba, 0x02, 0xa5, 0xfd]);
  assert.deepEqual(await reading, [-333, 698, -603], 'signed int16, little endian');
});

test('a value for another port does not resolve this read', async () => {
  const transport = fakeTransport();
  const protocol = new LegoProtocol(transport);
  const reading = protocol.readPortValue(0x3a, { timeoutMs: 40 });
  transport.deliver([0x0a, 0x00, 0x45, 0x38, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00]);
  assert.equal(await reading, null, 'the wrong port must not answer for this one');
});

test('a hub that never answers yields null rather than hanging', async () => {
  const transport = fakeTransport();
  const protocol = new LegoProtocol(transport);
  assert.equal(await protocol.readPortValue(0x3b, { timeoutMs: 20 }), null);
});

test('a one-byte port decodes as one figure, not as nothing', async () => {
  const transport = fakeTransport();
  const protocol = new LegoProtocol(transport);
  const reading = protocol.readPortValue(0x3e);
  // The gesture ports carry a single int8. Reading them in pairs yields an empty
  // array, which a caller cannot tell from a port that answered zero.
  transport.deliver([0x05, 0x00, 0x45, 0x3e, 0x04]);
  assert.deepEqual(await reading, [4]);
});

test('a four-figure port keeps all four', async () => {
  const transport = fakeTransport();
  const protocol = new LegoProtocol(transport);
  const reading = protocol.readPortValue(0x3b);
  transport.deliver([0x0c, 0x00, 0x45, 0x3b, 0x58, 0x03, 0x39, 0xff, 0x1f, 0xff, 0xa2, 0x01]);
  assert.deepEqual(await reading, [856, -199, -225, 418], 'the quaternion is four, not three');
});

test('readPosition recombines the two int16 halves into a signed int32', async () => {
  for (const [payload, expected] of [
    [[0x07, 0x00, 0x00, 0x00], 7],
    [[0xfd, 0xff, 0xff, 0xff], -3],
    [[0x62, 0xff, 0xff, 0xff], -158],
    [[0xa1, 0x86, 0x01, 0x00], 100001],
    [[0x00, 0x00, 0x01, 0x00], 65536],
  ]) {
    const transport = fakeTransport();
    const protocol = new LegoProtocol(transport);
    const reading = protocol.readPosition(0x34);
    transport.deliver([0x08, 0x00, 0x45, 0x34, ...payload]);
    assert.equal(await reading, expected, `payload ${payload.join(',')}`);
  }
});

test('readPosition is null when the port does not answer', async () => {
  const transport = fakeTransport();
  const protocol = new LegoProtocol(transport);
  assert.equal(await protocol.readPosition(0x34, { timeoutMs: 20 }), null);
});
