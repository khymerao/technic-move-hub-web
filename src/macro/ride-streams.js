// The telemetry streams a recording asks for, and gives back. No DOM, no BLE:
// the protocol is passed in and every call goes through it.
//
// See docs/superpowers/specs/2026-08-28-ride-recorder-design.md

import { quatFromOrint, quatHubToScene, eulerSceneFromQuat } from '../orientation.js';

export const RECORDER_HOLDER = 'recorder';

const ORINT_MODE = 0x00;
const ORINT_DELTA = 40;
const SPEED_DELTA = 20;
const STEER_DELTA = 15;

export const RIDE_STREAMS = [
  {
    name: 'orientation',
    subscribe: 'subscribeOrientation',
    unsubscribe: 'unsubscribeOrientation',
    roles: null,
    args: () => [ORINT_MODE, ORINT_DELTA],
  },
  {
    name: 'speed',
    subscribe: 'subscribeToSpeed',
    unsubscribe: 'unsubscribeTelemetry',
    roles: ['combined', 'driveA'],
    args: (port) => [port, SPEED_DELTA],
  },
  {
    name: 'position',
    subscribe: 'subscribeToPosition',
    unsubscribe: null,
    roles: ['steer'],
    args: (port) => [port, STEER_DELTA],
  },
];

function portFor(entry, protocol) {
  if (!entry.roles) return { ok: true, port: undefined };
  const roles = protocol?.roles;
  if (!roles) return { ok: true, port: undefined };
  for (const role of entry.roles) {
    if (roles[role] != null) return { ok: true, port: roles[role] };
  }
  return { ok: false, port: null };
}

export function createRideStreams({ protocol, onChannel, log } = {}) {
  const resolve = () => (typeof protocol === 'function' ? protocol() : protocol);
  let granted = [];

  return {
    async acquire() {
      if (granted.length) return [...granted];
      const p = resolve();
      for (const entry of RIDE_STREAMS) {
        const { ok, port } = portFor(entry, p);
        if (!ok) { log?.(`recorder: no ${entry.name} stream — port not attached`); continue; }
        try {
          await p[entry.subscribe](...entry.args(port), RECORDER_HOLDER);
          granted.push(entry.name);
          onChannel?.(entry.name);
        } catch (err) {
          log?.(`recorder: no ${entry.name} stream — ${err.message}`);
        }
      }
      return [...granted];
    },

    async release() {
      const p = resolve();
      const done = new Set();
      for (const name of granted) {
        const entry = RIDE_STREAMS.find((e) => e.name === name);
        if (!entry?.unsubscribe || done.has(entry.unsubscribe)) continue;
        done.add(entry.unsubscribe);
        try {
          await p[entry.unsubscribe](RECORDER_HOLDER);
        } catch { /* the link may already be gone */ }
      }
      try {
        await p?.releaseStreams?.(RECORDER_HOLDER);
      } catch { /* the link may already be gone */ }
      granted = [];
    },
  };
}

// See docs/superpowers/specs/2026-08-28-ride-recorder-design.md
export function rideState(detail, params) {
  return {
    ...detail,
    steerGain: detail?.steerGain ?? params?.steerGain ?? null,
    maxSpeed: detail?.maxSpeed ?? params?.maxSpeed ?? null,
    trim: detail?.trim ?? params?.trim ?? null,
  };
}

export function rideTelemetry(kind, detail) {
  if (kind === 'orientation') {
    const e = eulerSceneFromQuat(quatHubToScene(quatFromOrint(detail?.values)));
    if (!e) return null;
    const deg = (v) => Math.round(v) + 0;
    return { roll: deg(e.roll), pitch: deg(e.pitch), yaw: deg(e.yaw) };
  }
  if (kind === 'position') {
    if (typeof detail?.pos !== 'number') return null;
    return { port: detail.port, position: detail.pos };
  }
  if (kind === 'speed') {
    if (typeof detail?.speed !== 'number') return null;
    return { port: detail.port, speed: detail.speed };
  }
  return detail ?? null;
}
