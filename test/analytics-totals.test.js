// Reading the analytics 'Total' mode is two awkward facts wearing a trench coat:
// selecting a port mode does not take effect before the next frame, and
// releasing the stream afterwards does not put the mode back.
// See docs/DESIGN-NOTES.md § Selecting a port mode is not instant, so the first read after it is not the answer

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LegoProtocol, ANALYTICS_READ_ATTEMPTS } from '../src/lego-protocol.js';

const PORT = 0x3d;

// The reading measured on this hub: 326870 charge seconds, 1337144 play, 108.
const TOTAL_FRAME = [0x0e, 0x00, 0x45, PORT, 0xd6, 0xfc, 0x04, 0x00, 0x38, 0x67, 0x14, 0x00, 0x6c, 0x00, 0x00, 0x00];
// What mode 0 answers with while the switch to mode 3 is still in flight.
const CHGACT_FRAME = [0x0c, 0x00, 0x45, PORT, 0x33, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

// Answers every Port Value Request with the next frame in `replies`, repeating
// the last one once the list runs out — the hub keeps answering.
function fakeTransport(replies) {
  const t = new EventTarget();
  t.sent = [];
  let i = 0;
  t.sendPayload = (bytes, key) => {
    t.sent.push({ bytes: [...bytes], key });
    if (bytes[2] !== 0x21) return;
    const frame = replies[Math.min(i++, replies.length - 1)];
    queueMicrotask(() => t.dispatchEvent(
      new CustomEvent('data', { detail: Uint8Array.from(frame) })));
  };
  t.sendBurst = (frames, key) => { for (const f of frames) t.sendPayload(f, key); };
  return t;
}

function build(replies) {
  const t = fakeTransport(replies);
  const p = new LegoProtocol(t);
  p.roles = { analytics: PORT };
  return { t, p };
}

test('a settled read is returned once two of them agree', async () => {
  const { p } = build([TOTAL_FRAME]);
  assert.deepEqual(await p.readAnalyticsTotals(),
    { chargeSeconds: 326870, playSeconds: 1337144, third: 108 });
});

test('the frame still in the old mode is discarded, not returned', async () => {
  // Exactly what the hardware did: the first read came back in the previous
  // mode, the next carried Total.
  const { p } = build([CHGACT_FRAME, TOTAL_FRAME, TOTAL_FRAME]);
  assert.deepEqual(await p.readAnalyticsTotals(),
    { chargeSeconds: 326870, playSeconds: 1337144, third: 108 });
});

test('a port that never settles yields nothing rather than an unverified number', async () => {
  // Every reply differs, so no two reads ever agree.
  const replies = [];
  for (let i = 0; i < ANALYTICS_READ_ATTEMPTS + 2; i++) {
    const f = [...TOTAL_FRAME];
    f[4] = i;
    replies.push(f);
  }
  const { p } = build(replies);
  assert.equal(await p.readAnalyticsTotals(), null);
});

test('the port mode is put back afterwards, which releasing the stream does not do', async () => {
  const { t, p } = build([TOTAL_FRAME]);
  await p.readAnalyticsTotals();
  const setups = t.sent.filter((s) => s.bytes[2] === 0x41 && s.bytes[3] === PORT);
  const last = setups[setups.length - 1];
  assert.ok(last, 'an InputFormatSetup should have been sent');
  assert.equal(last.bytes[4], 0x00, 'the last mode selected on the port must be 0');
  assert.equal(last.bytes[9], 0x00, 'and it must not leave notifications on');
});

test('a hub with no analytics device is asked nothing at all', async () => {
  const { t, p } = build([TOTAL_FRAME]);
  p.roles = {};
  assert.equal(await p.readAnalyticsTotals(), null);
  assert.deepEqual(t.sent, []);
});
