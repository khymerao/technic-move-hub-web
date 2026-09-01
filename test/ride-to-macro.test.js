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
  assert.match(source, /await drive\(40, -60\);/);
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
  const drives = source.split('\n').filter((l) => l.includes('await drive('));
  assert.ok(drives.length >= 3);
  assert.ok(warnings.some((w) => /10000|ceiling|chunk/i.test(w)));
});

test('durations round to the link floor, not to the millisecond', () => {
  const { source } = rideToMacro(ride([{ t: 0, speed: 40, steer: 0 }, { t: 1237, speed: 0, steer: 0 }]));
  assert.match(source, /await drive\(40, 0\);/);
  assert.match(source, /await wait\(1250\);/);
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

test('a tracked ride is emitted as tank frames, never through the combined frame', () => {
  const r = ride([{ t: 0, left: 80, right: 20 }, { t: 1000, left: 0, right: 0 }],
    { path: 'tank', sourceMode: 'tracked' });
  const { source } = rideToMacro(r);
  assert.match(source, /await tankFor\(80, 20, \d+\);/);
  assert.doesNotMatch(source, /mode\('playvm'\)/);
  assert.doesNotMatch(source, /k = 1/);
  assert.match(source, /tank steering/i);
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

// On a tank the two tracks turning against each other is a spin in place, not
// an arc: calling it an arc tells the reader the machine travelled while it
// turned, which is the one thing it did not do.
test('counter-rotating tracks read as a spin, not an arc', () => {
  const r = ride([{ t: 0, left: 80, right: -80 }, { t: 900, left: 0, right: 0 }],
    { path: 'tank', sourceMode: 'tracked' });
  const { source, segments } = rideToMacro(r);
  const spin = segments.find((s) => s.kind === 'spin');
  assert.ok(spin, 'a counter-rotation was not classified as a spin');
  assert.match(source, /spin right/);
  assert.doesNotMatch(source, /arc/);
});

test('a spin still carries the drift warning a turn deserves', () => {
  const { source } = rideToMacro(ride([{ t: 0, left: 70, right: -70 }, { t: 900, left: 0, right: 0 }],
    { path: 'tank', sourceMode: 'tracked' }));
  const spinLine = source.split('\n').find((l) => l.includes('spin'));
  assert.match(spinLine, /drift/i);
});

test('tracks at different speeds but the same direction are still an arc', () => {
  const { source } = rideToMacro(ride([{ t: 0, left: 80, right: 30 }, { t: 900, left: 0, right: 0 }],
    { path: 'tank', sourceMode: 'tracked' }));
  assert.match(source, /arc right/);
  assert.doesNotMatch(source, /spin/);
});

// The recorded ride was continuous; the replay has to be too. `driveFor` holds,
// sleeps, then RELEASES — so a ride cut into eight segments became eight
// accelerate-and-stop cycles, and the car covered visibly less ground than it
// had when it was driven.
test('consecutive motion segments do not stop the car between them', () => {
  const { source } = rideToMacro(ride([
    { t: 0, speed: 40, steer: 0 },
    { t: 900, speed: 80, steer: 0 },
    { t: 1800, speed: 80, steer: -40 },
  ]));
  const motion = source.split('\n').filter((l) => l.startsWith('await') && !l.includes('mode('));
  const stops = motion.filter((l) => l.includes('stopDrive'));
  assert.equal(stops.length, 1, 'the car is stopped more than once — only the tail may stop it');
  assert.ok(source.trimEnd().endsWith('await stopDrive();'), 'the tail does not stop the car');
  assert.doesNotMatch(source, /driveFor/, 'driveFor releases the hold at the end of every segment');
});

test('a hold carries its own duration as a wait', () => {
  const { source } = rideToMacro(ride([
    { t: 0, speed: 45, steer: 0 },
    { t: 1200, speed: 0, steer: 0 },
  ]));
  assert.match(source, /await drive\(45, 0\);/);
  assert.match(source, /await wait\(1200\);/);
});

test('a stop segment stops the car before it waits', () => {
  const lines = rideToMacro(ride([
    { t: 0, speed: 45, steer: 0 },
    { t: 1000, speed: 0, steer: 0 },
    { t: 1400, speed: 45, steer: 0 },
  ])).source.split('\n').filter((l) => l.startsWith('await'));
  const iStop = lines.findIndex((l) => l.includes('stopDrive'));
  assert.ok(iStop > 0, 'the middle stop never releases the hold');
  assert.match(lines[iStop + 1], /await wait\(400\);/, 'the stop is not held for its own time');
});

// tankFor writes the speed, arms a safety deadline and returns AT ONCE — it
// does not sleep. Emitted back to back, every tank segment overwrote the one
// before it and the whole ride collapsed into the last command.
test('a tank ride carries its durations as waits, since tankFor does not sleep', () => {
  const { source } = rideToMacro(ride([
    { t: 0, left: 70, right: 70 },
    { t: 1100, left: 0, right: 0 },
  ], { path: 'tank', sourceMode: 'tracked' }));
  assert.match(source, /await tankFor\(70, 70, 1100\);\s*(\/\/[^\n]*)?\n\s*await wait\(1100\);/);
});
