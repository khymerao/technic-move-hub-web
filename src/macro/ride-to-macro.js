// Turns a recorded ride into macro source.
//
// See docs/superpowers/specs/2026-08-28-ride-recorder-design.md

const MAX_COMMAND_MS = 10000;
const ROUND_MS = 50;
const DRIFT_NOTE = 'replay drifts on turns';
const TELEMETRY_FIELDS = ['yaw', 'pitch', 'roll', 'position', 'left', 'right'];
const CODE_COLUMN = 32;

export const MIN_SEGMENT_MS = 120;
export const DEFAULT_EPSILON = { speed: 5, steer: 5 };

const roundMs = (ms) => Math.max(ROUND_MS, Math.round(ms / ROUND_MS) * ROUND_MS);
const mid = (lo, hi) => Math.round((lo + hi) / 2);
const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;
const signed = (n) => `${n >= 0 ? '+' : ''}${Math.round(n)}`;

function cutPoints(frames, key, eps) {
  const cuts = [];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < frames.length; i += 1) {
    const v = frames[i][key] ?? 0;
    const nlo = Math.min(lo, v), nhi = Math.max(hi, v);
    if (nhi - nlo > 2 * eps) { cuts.push(i); lo = v; hi = v; }
    else { lo = nlo; hi = nhi; }
  }
  return cuts;
}

const collapse = (frames, keys) => frames.filter((f, i) => {
  if (i === 0) return true;
  const prev = frames[i - 1];
  return keys.some((k) => (f[k] ?? 0) !== (prev[k] ?? 0));
});

function trimStillness(frames, keys) {
  let i = 0;
  while (i < frames.length && keys.every((k) => (frames[i][k] ?? 0) === 0)) i += 1;
  return i >= frames.length ? [] : frames.slice(i);
}

const spanOf = (frames, idx, key) => {
  let lo = Infinity, hi = -Infinity;
  for (const i of idx) {
    const v = frames[i][key] ?? 0;
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  return { lo, hi };
};

const constant = (frames, idx, keys, epsFor) =>
  keys.every((k) => {
    const { lo, hi } = spanOf(frames, idx, k);
    return hi - lo <= 2 * epsFor(k);
  });

function boundaries(frames, keys, epsFor) {
  const cuts = new Set([0]);
  for (const key of keys) for (const i of cutPoints(frames, key, epsFor(key))) cuts.add(i);
  return [...cuts].sort((a, b) => a - b);
}

function build(frames, keys, epsFor, endT) {
  const bounds = boundaries(frames, keys, epsFor);
  const segs = [];
  for (let k = 0; k < bounds.length; k += 1) {
    const start = bounds[k];
    const stop = k + 1 < bounds.length ? bounds[k + 1] : frames.length;
    const t = frames[start].t;
    const tEnd = k + 1 < bounds.length ? frames[bounds[k + 1]].t : Math.max(endT, t + ROUND_MS);
    const idx = [];
    for (let i = start; i < stop; i += 1) idx.push(i);
    segs.push({ t, durationMs: tEnd - t, idx });
  }
  return segs;
}

// A sliver is dropped only when the runs on either side of it are one constant
// without it; otherwise it is real change, and folding it would break the
// epsilon guarantee the module exists to make.
function foldSlivers(segs, frames, keys, epsFor) {
  let out = segs;
  for (;;) {
    let at = -1;
    for (let i = 1; i < out.length - 1; i += 1) {
      if (out[i].durationMs >= MIN_SEGMENT_MS) continue;
      const merged = [...out[i - 1].idx, ...out[i + 1].idx];
      if (constant(frames, merged, keys, epsFor)) { at = i; break; }
    }
    if (at < 0) return out;
    const prev = out[at - 1], next = out[at + 1];
    const joined = {
      t: prev.t,
      durationMs: next.t + next.durationMs - prev.t,
      idx: [...prev.idx, ...next.idx],
    };
    out = [...out.slice(0, at - 1), joined, ...out.slice(at + 2)];
  }
}

function describe(seg, frames, keys, epsFor, path, epsilon) {
  const value = {};
  for (const k of keys) {
    const { lo, hi } = spanOf(frames, seg.idx, k);
    value[k] = mid(lo, hi);
  }
  const primary = keys[0];
  const from = frames[seg.idx[0]][primary] ?? 0;
  const to = frames[seg.idx[seg.idx.length - 1]][primary] ?? 0;
  const ramp = Math.abs(to - from) > epsFor(primary) ? { from, to } : null;

  let kind;
  if (path === 'tank') {
    if (value.left === 0 && value.right === 0) kind = 'stop';
    // Tracks pulling against each other turn the machine without moving it.
    else if (value.left * value.right < 0) kind = 'spin';
    else kind = Math.abs(value.left - value.right) <= 2 * epsFor('left') ? 'straight' : 'arc';
  } else if (value.speed === 0) kind = 'stop';
  else kind = Math.abs(value.steer) <= epsilon.steer ? 'straight' : 'arc';

  return { t: seg.t, durationMs: seg.durationMs, ...value, kind, ramp };
}

function localTime(ms) {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function telemetryNotes(ride, seg) {
  const notes = [];
  const samples = ride.telemetry ?? [];
  const end = seg.t + seg.durationMs;
  for (const field of TELEMETRY_FIELDS) {
    const withField = samples.filter((s) => typeof s[field] === 'number');
    const inside = withField.filter((s) => s.t >= seg.t && s.t < end);
    if (!inside.length) continue;
    const before = withField.filter((s) => s.t < seg.t);
    const base = before.length ? before[before.length - 1] : inside[0];
    if (base === inside[0] && inside.length < 2) continue;
    const delta = inside[inside.length - 1][field] - base[field];
    if (Math.abs(delta) < 1) continue;
    notes.push(`${field} ${signed(delta)} deg`);
  }
  return notes;
}

const sideOf = (seg, path) => {
  const turn = path === 'tank' ? seg.left - seg.right : seg.steer;
  return turn < 0 ? 'left' : 'right';
};

function comment(seg, ride, path, chunkMs) {
  const parts = [];
  if (seg.kind === 'stop') parts.push('stopped');
  else if (seg.kind === 'spin') parts.push(`spin ${sideOf(seg, path)}`);
  else if (seg.kind === 'arc') parts.push(`arc ${sideOf(seg, path)}`);
  else parts.push('straight');
  parts.push(seconds(chunkMs));
  if (seg.ramp) {
    const value = path === 'tank' ? seg.left : seg.speed;
    const half = Math.round(Math.abs(seg.ramp.to - seg.ramp.from) / 2);
    parts.push(`you drove ${seg.ramp.from}→${seg.ramp.to}, flattened to ${value} (±${half})`);
  }
  parts.push(...telemetryNotes(ride, seg));
  if (seg.kind === 'arc' || seg.kind === 'spin') parts.push(DRIFT_NOTE);
  return parts.join(' · ');
}

const line = (code, note) => `${code.padEnd(CODE_COLUMN)}  // ${note}`;

// The command and the time it lasts are emitted separately, and that is the
// whole point: `driveFor` releases its hold when it returns, so a ride cut into
// eight segments replayed as eight accelerate-and-stop cycles and came up
// short. A hold plus a wait keeps the motors turning across the seam.
// `tankFor` has the opposite problem — it arms a deadline and returns at once,
// never sleeping — so its duration has to be a wait too, or the whole ride
// collapses into the last command.
// See docs/DESIGN-NOTES.md § A replayed ride is held, not restarted
function callFor(seg, path, ms) {
  if (seg.kind === 'stop') return null;
  if (path === 'tank') return `await tankFor(${seg.left}, ${seg.right}, ${ms});`;
  return `await drive(${seg.speed}, ${seg.steer});`;
}

function emitSegment(seg, ride, path, warnings, prev) {
  const lines = [];
  const total = roundMs(seg.durationMs);

  if (seg.kind === 'stop') {
    // Only worth releasing if something was still holding the motors.
    if (prev && prev.kind !== 'stop') {
      lines.push(line(path === 'tank' ? 'await brakeAll();' : 'await stopDrive();',
        comment(seg, ride, path, total)));
      lines.push(`await wait(${total});`);
    } else {
      lines.push(line(`await wait(${total});`, comment(seg, ride, path, total)));
    }
    return lines;
  }

  let left = total;
  if (left > MAX_COMMAND_MS) {
    warnings.push(
      `a ${seconds(total)} segment at ${seg.t}ms is past the ${MAX_COMMAND_MS}ms `
      + 'command ceiling and was chunked');
  }
  while (left > 0) {
    const ms = Math.min(left, MAX_COMMAND_MS);
    lines.push(line(callFor(seg, path, ms), comment(seg, ride, path, ms)));
    lines.push(`await wait(${ms});`);
    left -= ms;
  }
  return lines;
}

function header(ride, path, segments) {
  const s = ride.settings ?? {};
  const label = path === 'tank' ? 'tank frame' : 'combined frame';
  const lines = [
    `// recorded ${localTime(ride.startedAtWall)} · ${label} `
    + `· ${(ride.durationMs / 1000).toFixed(1)} s · ${segments.length} segments`,
    `// stopped by: ${ride.stopReason}`,
    `// settings: steerGain ${s.steerGain}, trim ${s.trim}, maxSpeed ${s.maxSpeed}`,
    ride.channels?.length
      ? `// telemetry: ${ride.channels.join(', ')}`
      : '// no telemetry was live — turn on Telemetry, or record with the Drive tab open',
  ];
  if (ride.sourceMode === 'tracked') {
    lines.push('// tank steering: the two tracks are driven separately, as they were recorded');
  }
  if (ride.sourceMode === 'independent') {
    lines.push('// independent mode is not a chassis model — emitted on the raw path as tankFor');
  }
  if (ride.sourceMode === 'linked') {
    lines.push('// linked mode: raw steer is a power-to-angle approximation');
  }
  return lines;
}

export function rideToMacro(ride, { epsilon, trimLeadingStillness = false } = {}) {
  const eps = { ...DEFAULT_EPSILON, ...(epsilon ?? {}) };
  const path = ride.path === 'tank' ? 'tank' : 'playvm';
  const keys = path === 'tank' ? ['left', 'right'] : ['speed', 'steer'];
  const epsFor = (key) => (key === 'steer' ? eps.steer : eps.speed);
  const warnings = [];

  let frames = ride.frames ?? [];
  if (trimLeadingStillness) frames = trimStillness(frames, keys);
  frames = collapse(frames, keys);

  const raw = frames.length
    ? foldSlivers(build(frames, keys, epsFor, ride.durationMs), frames, keys, epsFor)
    : [];
  const segments = raw.map((seg) => describe(seg, frames, keys, epsFor, path, eps));

  if (ride.sourceMode === 'tracked') {
    warnings.push('a tank ride replays on the raw path, which has no device-side '
      + 'failsafe of its own — every command carries a deadline instead');
  }
  if (ride.sourceMode === 'independent') {
    warnings.push('independent mode was emitted on the raw path, off the canonical '
      + 'playvm path and without its device-side failsafe');
  }

  const body = [];
  segments.forEach((seg, i) => body.push(...emitSegment(seg, ride, path, warnings, segments[i - 1])));

  const source = [
    ...header(ride, path, segments),
    '',
    ...(path === 'tank' ? [] : ["await mode('playvm');"]),
    ...body,
    ...(segments[segments.length - 1]?.kind === 'stop' ? []
      : [path === 'tank' ? 'await brakeAll();' : 'await stopDrive();']),
    '',
  ].join('\n');

  return { source, segments, warnings };
}
