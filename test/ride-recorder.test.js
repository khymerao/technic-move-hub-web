import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRideRecorder, RECORD_CAP_MS } from '../src/macro/ride-recorder.js';

const state = (over = {}) => ({
  driveMode: 'playvm', trim: 0,
  sent: { playvmSpeed: 40, playvmSteer: 0 },
  ...over,
});

function rig(t0 = 0) {
  let t = t0;
  const r = createRideRecorder({ now: () => t, wallClock: () => 1756389720000 });
  const cursor = Object.create(r);
  cursor.r = r;
  return { r, at(ms) { t = ms; return cursor; } };
}

test('a recorder that was never started ignores everything', () => {
  const { r } = rig();
  r.observe(state());
  assert.equal(r.recording, false);
  assert.equal(r.stop('user'), null);
});

test('frames are timestamped from the start, not from the clock origin', () => {
  const g = rig(5000);
  g.r.start();
  g.at(5120).observe(state());
  const ride = g.at(5300).r.stop('user');
  assert.deepEqual(ride.frames[0], { t: 120, speed: 40, steer: 0 });
  assert.equal(ride.durationMs, 300);
});

test('an identical frame is not stored twice', () => {
  const g = rig();
  g.r.start();
  g.at(60).observe(state());
  g.at(120).observe(state());
  g.at(180).observe(state({ sent: { playvmSpeed: 55, playvmSteer: 0 } }));
  const ride = g.at(240).r.stop('user');
  assert.deepEqual(ride.frames.map((f) => f.speed), [40, 55]);
});

test('the tracked mode converts to speed and steer around the midpoint', () => {
  const g = rig();
  g.r.start();
  g.at(60).observe(state({ driveMode: 'tracked', sent: { tankL: 80, tankR: 20 } }));
  const ride = g.at(120).r.stop('user');
  assert.equal(ride.path, 'playvm');
  assert.deepEqual(ride.frames[0], { t: 60, speed: 50, steer: 30 });
});

test('a live steer stick beats the reconstructed tank differential', () => {
  const g = rig();
  g.r.start();
  g.at(60).observe(state({
    driveMode: 'tracked', steer: -70, sent: { tankL: 80, tankR: 20, steer: -70 },
  }));
  const ride = g.at(120).r.stop('user');
  assert.equal(ride.frames[0].steer, -70);
});

test('linked mode takes the drive value straight', () => {
  const g = rig();
  g.r.start();
  g.at(60).observe(state({ driveMode: 'linked', sent: { driveA: 65, driveB: 65, steer: 10 } }));
  const ride = g.at(120).r.stop('user');
  assert.deepEqual(ride.frames[0], { t: 60, speed: 65, steer: 10 });
});

test('independent mode records the tank path instead of inventing a chassis', () => {
  const g = rig();
  g.r.start();
  g.at(60).observe(state({ driveMode: 'independent', sent: { driveA: 70, driveB: -30 } }));
  const ride = g.at(120).r.stop('user');
  assert.equal(ride.path, 'tank');
  assert.deepEqual(ride.frames[0], { t: 60, left: 70, right: -30 });
});

test('a mode change during a recording ends it', () => {
  const g = rig();
  g.r.start();
  g.at(60).observe(state());
  g.at(120).observe(state({ driveMode: 'tracked', sent: { tankL: 10, tankR: 10 } }));
  assert.equal(g.r.recording, false);
});

test('the cap stops the recording with its own reason', () => {
  const g = rig();
  g.r.start();
  g.at(RECORD_CAP_MS + 60).observe(state());
  assert.equal(g.r.recording, false);
});

test('only granted channels are reported', () => {
  const g = rig();
  g.r.start();
  g.r.channel('orientation');
  g.at(60).telemetry('orientation', { yaw: 12 });
  g.at(60).telemetry('speed', { speed: 40 });
  const ride = g.at(120).r.stop('user');
  assert.deepEqual(ride.channels, ['orientation']);
  assert.equal(ride.telemetry.length, 1);
});

test('stopping twice yields the ride once', () => {
  const g = rig();
  g.r.start();
  g.at(60).observe(state());
  assert.ok(g.at(120).r.stop('user'));
  assert.equal(g.r.stop('user'), null);
});

test('an auto-finished ride keeps the duration it ended at, not the one it was collected at', () => {
  const g = rig();
  g.r.start();
  g.at(60).observe(state());
  g.at(120).observe(state({ driveMode: 'tracked', sent: { tankL: 10, tankR: 10 } }));
  assert.equal(g.r.recording, false);
  const ride = g.at(9000).r.stop('user');
  assert.equal(ride.stopReason, 'mode-switch');
  assert.equal(ride.durationMs, 120);
});
