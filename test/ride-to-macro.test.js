import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rideToMacro, MIN_SEGMENT_MS, DEFAULT_EPSILON } from '../src/macro/ride-to-macro.js';

const ride = (frames, over = {}) => ({
  path: 'playvm', sourceMode: 'playvm',
  startedAtWall: Date.UTC(2026, 7, 28, 11, 2),
  durationMs: frames.length ? frames[frames.length - 1].t + 1000 : 0,
  stopReason: 'user',
  settings: { steerGain: 100, trim: 0, maxSpeed: 100 },
  channels: [], telemetry: [], frames,
  ...over,
});

test('a held value is one segment however many frames carried it', () => {
  const r = ride([{ t: 0, speed: 45, steer: 0 }, { t: 60, speed: 45, steer: 0 }]);
  const { segments } = rideToMacro(r);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].speed, 45);
});

test('a linear ramp does not collapse to one constant', () => {
  const frames = [];
  for (let i = 0; i <= 50; i += 1) frames.push({ t: i * 60, speed: i * 2, steer: 0 });
  const { segments } = rideToMacro(ride(frames), { epsilon: { speed: 5, steer: 5 } });
  assert.ok(segments.length >= 8, `a 0-to-100 ramp collapsed to ${segments.length} segment(s)`);
  for (const s of segments) {
    assert.ok(s.ramp === null || Math.abs(s.ramp.to - s.ramp.from) <= 2 * 5 + 1);
  }
});

test('jitter inside the tolerance stays one segment', () => {
  const frames = [];
  for (let i = 0; i <= 20; i += 1) {
    frames.push({ t: i * 60, speed: 50 + (i % 2 ? 3 : -3), steer: 0 });
  }
  const { segments } = rideToMacro(ride(frames), { epsilon: { speed: 5, steer: 5 } });
  assert.equal(segments.length, 1);
});

test('no emitted speed is further than epsilon from what was driven', () => {
  const frames = [];
  for (let i = 0; i <= 40; i += 1) frames.push({ t: i * 60, speed: Math.round(Math.sin(i / 3) * 60), steer: 0 });
  const eps = { speed: 5, steer: 5 };
  const { segments } = rideToMacro(ride(frames), { epsilon: eps });
  for (const f of frames) {
    const s = segments.find((g) => f.t >= g.t && f.t < g.t + g.durationMs);
    if (!s || s.speed === undefined) continue;
    assert.ok(Math.abs(s.speed - f.speed) <= eps.speed + 1,
      `frame ${f.t} drove ${f.speed}, emitted ${s.speed}`);
  }
});

test('a sliver shorter than the floor folds into its neighbour', () => {
  const frames = [
    { t: 0, speed: 40, steer: 0 },
    { t: 900, speed: 90, steer: 0 },
    { t: 960, speed: 40, steer: 0 },
    { t: 2000, speed: 40, steer: 0 },
  ];
  const { segments } = rideToMacro(ride(frames));
  assert.ok(segments.every((s) => s.durationMs >= MIN_SEGMENT_MS));
});

test('a zero segment becomes a wait, not a drive', () => {
  const frames = [
    { t: 0, speed: 0, steer: 0 },
    { t: 500, speed: 40, steer: 0 },
  ];
  const { source } = rideToMacro(ride(frames));
  assert.match(source, /await wait\(500\);/);
});

test('a steered segment reads as an arc and names its side', () => {
  const { source } = rideToMacro(ride([{ t: 0, speed: 40, steer: -60 }]));
  assert.match(source, /await driveFor\(40, -60, \d+\);/);
  assert.match(source, /arc left/);
});

test('the preamble forces the mode and the tail stops the car', () => {
  const { source } = rideToMacro(ride([{ t: 0, speed: 40, steer: 0 }]));
  const lines = source.split('\n').filter((l) => l.startsWith('await'));
  assert.equal(lines[0], "await mode('playvm');");
  assert.equal(lines[lines.length - 1], 'await stopDrive();');
});

test('a segment past the command ceiling is chunked and warned about', () => {
  const frames = [{ t: 0, speed: 40, steer: 0 }, { t: 25000, speed: 40, steer: 0 }];
  const { source, warnings } = rideToMacro(ride(frames));
  const drives = source.split('\n').filter((l) => l.includes('driveFor'));
  assert.ok(drives.length >= 3);
  assert.ok(warnings.some((w) => /10000|ceiling|chunk/i.test(w)));
});

test('durations round to the link floor, not to the millisecond', () => {
  const { source } = rideToMacro(ride([{ t: 0, speed: 40, steer: 0 }, { t: 1237, speed: 0, steer: 0 }]));
  assert.match(source, /await driveFor\(40, 0, 1250\);/);
});

test('the header is local time and never an ISO string', () => {
  const { source } = rideToMacro(ride([{ t: 0, speed: 40, steer: 0 }]));
  assert.doesNotMatch(source, /\d{4}-\d{2}-\d{2}T/);
  assert.match(source, /^\/\/ recorded \d{1,2}:\d{2}/m);
});

test('no generated-file marker is emitted', () => {
  const { source } = rideToMacro(ride([{ t: 0, speed: 40, steer: 0 }]));
  assert.doesNotMatch(source, /@generated|DO NOT EDIT/i);
});

test('an empty channel list says so and a populated one does not', () => {
  const bare = rideToMacro(ride([{ t: 0, speed: 40, steer: 0 }])).source;
  assert.match(bare, /no telemetry/i);
  const rich = rideToMacro(ride([{ t: 0, speed: 40, steer: 0 }], {
    channels: ['orientation'],
    telemetry: [{ t: 10, kind: 'orientation', yaw: 0 }, { t: 900, kind: 'orientation', yaw: 34 }],
  })).source;
  assert.doesNotMatch(rich, /no telemetry/i);
  assert.match(rich, /yaw \+34/);
});

test('turning segments carry a drift warning and straights do not', () => {
  const { source } = rideToMacro(ride([
    { t: 0, speed: 40, steer: 0 },
    { t: 1000, speed: 40, steer: -60 },
    { t: 2000, speed: 0, steer: 0 },
  ]));
  const arc = source.split('\n').find((l) => l.includes('arc left'));
  const straight = source.split('\n').find((l) => l.includes('straight'));
  assert.match(arc, /drift/i);
  assert.doesNotMatch(straight, /drift/i);
});

test('the independent path emits tankFor on the raw path', () => {
  const r = ride([{ t: 0, left: 70, right: -30 }, { t: 1000, left: 0, right: 0 }],
    { path: 'tank', sourceMode: 'independent' });
  const { source } = rideToMacro(r);
  assert.match(source, /await tankFor\(70, -30, \d+\);/);
  assert.doesNotMatch(source, /mode\('playvm'\)/);
  assert.match(source, /independent/i);
});

test('the tracked source declares its reconstruction factor', () => {
  const { source } = rideToMacro(ride([{ t: 0, speed: 50, steer: 30 }], { sourceMode: 'tracked' }));
  assert.match(source, /k = 1/);
});

test('the settings that the conversion depends on are named', () => {
  const { source } = rideToMacro(ride([{ t: 0, speed: 40, steer: 0 }]));
  assert.match(source, /steerGain 100/);
  assert.match(source, /trim 0/);
});

test('the stop reason reaches the header', () => {
  const { source } = rideToMacro(ride([{ t: 0, speed: 40, steer: 0 }], { stopReason: 'collision' }));
  assert.match(source, /stopped by: collision/);
});

test('leading stillness is trimmed', () => {
  const frames = [
    { t: 0, speed: 0, steer: 0 },
    { t: 3000, speed: 40, steer: 0 },
  ];
  const { segments } = rideToMacro(ride(frames), { trimLeadingStillness: true });
  assert.equal(segments[0].kind, 'straight');
});

test('a ride with no frames produces a comment and no motion', () => {
  const { source, segments } = rideToMacro(ride([]));
  assert.equal(segments.length, 0);
  assert.doesNotMatch(source, /driveFor|tankFor/);
});

test('the default epsilon floors at the playvm deadband', () => {
  assert.ok(DEFAULT_EPSILON.speed >= 3);
  assert.ok(DEFAULT_EPSILON.steer >= 3);
});

test('a segment with one sample still reports a delta, measured from the last one before it', () => {
  const { source } = rideToMacro(ride([
    { t: 0, speed: 40, steer: 0 },
    { t: 1000, speed: 40, steer: -60 },
    { t: 2000, speed: 0, steer: 0 },
  ], {
    channels: ['orientation'],
    telemetry: [
      { t: 10, kind: 'orientation', yaw: 0 },
      { t: 1500, kind: 'orientation', yaw: 34 },
    ],
  }));
  const arc = source.split('\n').find((l) => l.includes('arc left'));
  assert.match(arc, /yaw \+34/);
});

test('a segment with no sample at all reports nothing rather than a zero', () => {
  const { source } = rideToMacro(ride([
    { t: 0, speed: 40, steer: 0 },
    { t: 1000, speed: 40, steer: -60 },
  ], {
    channels: ['orientation'],
    telemetry: [{ t: 10, kind: 'orientation', yaw: 0 }],
  }));
  const arc = source.split('\n').find((l) => l.includes('arc left'));
  assert.doesNotMatch(arc, /yaw/);
});
