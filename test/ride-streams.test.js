import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRideStreams, RECORDER_HOLDER, rideState, rideTelemetry } from '../src/macro/ride-streams.js';

function fakeProtocol({ failing = [] } = {}) {
  const calls = [];
  const mk = (name) => async (...args) => {
    calls.push({ name, holder: args[args.length - 1] });
    if (failing.includes(name)) {
      throw new Error('port 0x3b is already streaming mode 0x0; a port streams one input mode at a time');
    }
  };
  return {
    calls,
    subscribeOrientation: mk('subscribeOrientation'),
    subscribeToSpeed: mk('subscribeToSpeed'),
    subscribeToPosition: mk('subscribeToPosition'),
    unsubscribeTelemetry: mk('unsubscribeTelemetry'),
    unsubscribeOrientation: mk('unsubscribeOrientation'),
  };
}

test('every acquisition is made under the recorder holder, never the app one', async () => {
  const protocol = fakeProtocol();
  const granted = await createRideStreams({ protocol }).acquire();
  assert.ok(granted.length > 0);
  for (const c of protocol.calls) assert.equal(c.holder, RECORDER_HOLDER);
});

test('a port held by another mode is reported unavailable, and the rest still come up', async () => {
  const protocol = fakeProtocol({ failing: ['subscribeOrientation'] });
  const granted = await createRideStreams({ protocol }).acquire();
  assert.equal(granted.includes('orientation'), false);
  assert.ok(granted.length > 0, 'one refused stream took the whole recording down');
});

test('a granted channel is announced as it is granted', async () => {
  const seen = [];
  const granted = await createRideStreams({
    protocol: fakeProtocol(), onChannel: (n) => seen.push(n),
  }).acquire();
  assert.deepEqual(seen, granted);
});

test('release gives back every stream the holder took', async () => {
  const protocol = fakeProtocol();
  const s = createRideStreams({ protocol });
  await s.acquire();
  protocol.calls.length = 0;
  await s.release();
  assert.ok(protocol.calls.length > 0);
  for (const c of protocol.calls) assert.equal(c.holder, RECORDER_HOLDER);
});

test('release is safe when nothing was ever granted', async () => {
  const protocol = fakeProtocol({ failing: ['subscribeOrientation', 'subscribeToSpeed', 'subscribeToPosition'] });
  const s = createRideStreams({ protocol });
  assert.deepEqual(await s.acquire(), []);
  await s.release();
});

test('release runs even after an acquire that threw outright', async () => {
  const protocol = fakeProtocol();
  protocol.subscribeToSpeed = async () => { throw new TypeError('not a function'); };
  const s = createRideStreams({ protocol });
  await s.acquire();
  await s.release();
});

test('acquiring twice does not double-hold', async () => {
  const protocol = fakeProtocol();
  const s = createRideStreams({ protocol });
  const first = await s.acquire();
  const second = await s.acquire();
  assert.deepEqual(second, first);
});

test('the protocol may be resolved at acquire time, not at construction', async () => {
  let protocol = null;
  const s = createRideStreams({ protocol: () => protocol });
  protocol = fakeProtocol();
  const granted = await s.acquire();
  assert.ok(granted.length > 0);
});

test('a stream whose motor is not attached is skipped, not asked for', async () => {
  const protocol = fakeProtocol();
  protocol.roles = { combined: 0x39, steer: null };
  const granted = await createRideStreams({ protocol }).acquire();
  assert.equal(granted.includes('position'), false);
  assert.ok(granted.includes('speed'));
  assert.equal(protocol.calls.some((c) => c.name === 'subscribeToPosition'), false);
});

test('release also sweeps the holder off every stream the protocol still tracks', async () => {
  const protocol = fakeProtocol();
  const swept = [];
  protocol.releaseStreams = async (holder) => { swept.push(holder); };
  const s = createRideStreams({ protocol });
  await s.acquire();
  await s.release();
  assert.deepEqual(swept, [RECORDER_HOLDER]);
});

test('the provenance header gets the gains the state event does not carry', () => {
  const detail = { driveMode: 'playvm', trim: 4, sent: {} };
  const enriched = rideState(detail, { steerGain: 80, maxSpeed: 60, trim: 0 });
  assert.equal(enriched.steerGain, 80);
  assert.equal(enriched.maxSpeed, 60);
  assert.equal(enriched.trim, 4);
  assert.equal(enriched.driveMode, 'playvm');
});

test('a state event with no params behind it still yields a usable header', () => {
  const enriched = rideState({ driveMode: 'tracked' }, undefined);
  assert.equal(enriched.steerGain, null);
  assert.equal(enriched.maxSpeed, null);
  assert.equal(enriched.trim, null);
});

test('orientation telemetry arrives as degrees the converter can read', () => {
  const flat = rideTelemetry('orientation', { values: [0, 0, 0, 1] });
  assert.deepEqual(flat, { roll: 0, pitch: 0, yaw: 0 });
  const spun = rideTelemetry('orientation', { values: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] });
  assert.deepEqual(spun, { roll: 0, pitch: 0, yaw: -90 });
});

test('an unusable orientation sample is dropped rather than recorded as noise', () => {
  assert.equal(rideTelemetry('orientation', { values: [0, 0, 0] }), null);
  assert.equal(rideTelemetry('orientation', {}), null);
});

test('position telemetry lands on the field the converter looks for', () => {
  assert.deepEqual(rideTelemetry('position', { port: 0x36, pos: 12 }), { port: 0x36, position: 12 });
  assert.equal(rideTelemetry('position', { port: 0x36 }), null);
});

test('speed telemetry keeps its port', () => {
  assert.deepEqual(rideTelemetry('speed', { port: 0x39, speed: -30 }), { port: 0x39, speed: -30 });
});
