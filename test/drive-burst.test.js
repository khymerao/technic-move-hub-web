// The burst write is what replaced LWP virtual ports after those wedged the hub
// within a second. It is the only thing keeping the two drive motors in step, so
// it needs to stay covered: both frames in ONE queue slot, same generation of the
// command, per-port inversion applied, and a stop that is a real stop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LegoProtocol } from '../src/lego-protocol.js';

// LegoProtocol pulls in debug-log, which reaches for the DOM.
globalThis.document = globalThis.document ?? { getElementById: () => null };

function harness() {
  const bursts = [];
  const singles = [];
  const transport = {
    addEventListener() {},
    sendPayload(bytes, key) { singles.push({ bytes: [...bytes], key }); },
    sendBurst(frames, key) { bursts.push({ frames: frames.map((f) => [...f]), key }); },
  };
  const protocol = new LegoProtocol(transport);
  protocol.roles = { driveA: 0x32, driveB: 0x33, steer: 0x34 };
  return { protocol, bursts, singles };
}

const portOf = (frame) => frame[3];
const speedOf = (frame) => (frame[6] > 127 ? frame[6] - 256 : frame[6]);
const isFloat = (frame) => frame[5] === 0x51 && frame[6] === 0x00;

test('driveThrottle writes both motors as one burst, same value', async () => {
  const { protocol, bursts, singles } = harness();
  await protocol.driveThrottle(70);

  assert.equal(bursts.length, 1, 'both motors must go in a single queue slot');
  assert.equal(singles.length, 0, 'no separate per-motor writes may escape');
  const { frames, key } = bursts[0];
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map(portOf), [0x32, 0x33]);
  assert.deepEqual(frames.map(speedOf), [70, 70]);
  assert.equal(key, 'drive', 'one coalescing key, so the pair cannot split generations');
});

test('driveThrottle applies per-port inversion inside the burst', async () => {
  const { protocol, bursts } = harness();
  protocol.setMotorInverted(0x33, true);
  await protocol.driveThrottle(70);

  assert.deepEqual(bursts[0].frames.map(speedOf), [70, -70],
    'a mirrored motor must get the flipped value in the same burst');
});

test('driveThrottle(0) floats both motors rather than commanding speed zero', async () => {
  const { protocol, bursts } = harness();
  await protocol.driveThrottle(0);
  assert.ok(bursts[0].frames.every(isFloat),
    'StartSpeed(0) regulates against zero and makes the motors buzz; a stop must float');
});

test('inversion never turns a stop into motion', async () => {
  const { protocol, bursts } = harness();
  protocol.setMotorInverted(0x33, true);
  await protocol.driveThrottle(0);
  assert.ok(bursts[0].frames.every(isFloat), 'negating zero must not re-encode as a movement');
});

test('driveTank gives each track its own speed in one burst', async () => {
  const { protocol, bursts } = harness();
  await protocol.driveTank(60, -60);

  assert.equal(bursts.length, 1);
  assert.deepEqual(bursts[0].frames.map(portOf), [0x32, 0x33]);
  assert.deepEqual(bursts[0].frames.map(speedOf), [60, -60],
    'counter-rotating the tracks is how tracked mode turns');
  assert.equal(bursts[0].key, 'drive');
});

test('driveTank honours inversion per port', async () => {
  const { protocol, bursts } = harness();
  protocol.setMotorInverted(0x33, true);
  await protocol.driveTank(60, -60);
  assert.deepEqual(bursts[0].frames.map(speedOf), [60, 60]);
});

test('drive commands never address a virtual port', async () => {
  // Creating one knocked this hub off the air in 0.1-1.1s across four sessions.
  const { protocol, bursts } = harness();
  assert.equal(protocol.drivePort, null, 'there must be no virtual drive port');
  await protocol.driveThrottle(50);
  await protocol.driveTank(10, 20);
  for (const b of bursts) {
    for (const f of b.frames) {
      assert.ok([0x32, 0x33].includes(portOf(f)), `unexpected port 0x${portOf(f).toString(16)}`);
    }
  }
});

test('driveThrottle is a no-op when the drive motors are not discovered', async () => {
  const { protocol, bursts, singles } = harness();
  protocol.roles = {};
  await protocol.driveThrottle(50);
  await protocol.driveTank(10, 10);
  assert.equal(bursts.length + singles.length, 0);
});
