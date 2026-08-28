// Accumulates a hand-driven ride from the gamepad's own state event. No DOM,
// no BLE, no writes to the hub.
//
// See docs/superpowers/specs/2026-08-28-ride-recorder-design.md

export const RECORD_CAP_MS = 600000;

const MODE_PATH = {
  playvm: 'playvm', tracked: 'playvm', linked: 'playvm', independent: 'tank',
};

function frameFor(mode, sent, steerStick) {
  if (mode === 'independent') {
    return { left: sent.driveA ?? 0, right: sent.driveB ?? 0 };
  }
  if (mode === 'tracked') {
    const L = sent.tankL ?? 0, R = sent.tankR ?? 0;
    const stick = sent.steer ?? steerStick;
    return {
      speed: Math.round((L + R) / 2),
      steer: Number.isFinite(stick) && stick !== 0 ? Math.round(stick) : Math.round((L - R) / 2),
    };
  }
  if (mode === 'linked') {
    return { speed: Math.round(sent.driveA ?? 0), steer: Math.round(sent.steer ?? steerStick ?? 0) };
  }
  return {
    speed: Math.round(sent.playvmSpeed ?? 0),
    steer: Math.round(sent.playvmSteer ?? 0),
  };
}

const sameFrame = (a, b) => !!a && !!b
  && a.speed === b.speed && a.steer === b.steer
  && a.left === b.left && a.right === b.right;

export function createRideRecorder({ now, wallClock }) {
  let live = false;
  let startedAt = 0, startedAtWall = 0;
  let mode = null, settings = null, stopReason = null, endedAt = null;
  let frames = [], telemetry = [], channels = [];
  let last = null;

  const finish = (reason) => { stopReason = reason; endedAt = now(); live = false; };

  return {
    get recording() { return live; },

    start() {
      live = true;
      startedAt = now();
      startedAtWall = wallClock();
      mode = null; settings = null; stopReason = null; endedAt = null; last = null;
      frames = []; telemetry = []; channels = [];
    },

    channel(name) { if (live && !channels.includes(name)) channels.push(name); },

    observe(detail) {
      if (!live) return;
      const t = now() - startedAt;
      if (t > RECORD_CAP_MS) { finish('cap'); return; }
      const seen = detail?.driveMode ?? 'playvm';
      if (mode === null) {
        mode = seen;
        settings = {
          steerGain: detail?.steerGain ?? null,
          trim: detail?.trim ?? null,
          maxSpeed: detail?.maxSpeed ?? null,
        };
      } else if (seen !== mode) { finish('mode-switch'); return; }
      const f = frameFor(mode, detail?.sent ?? {}, detail?.steer);
      if (sameFrame(f, last)) return;
      last = f;
      frames.push({ t: Math.round(t), ...f });
    },

    telemetry(kind, detail) {
      if (!live || !channels.includes(kind)) return;
      telemetry.push({ t: Math.round(now() - startedAt), kind, ...detail });
    },

    stop(reason) {
      if (!live && stopReason === null) return null;
      if (live) finish(reason);
      const durationMs = Math.round(endedAt - startedAt);
      const ride = {
        path: MODE_PATH[mode ?? 'playvm'],
        sourceMode: mode ?? 'playvm',
        startedAtWall, durationMs, stopReason,
        settings: settings ?? { steerGain: null, trim: null, maxSpeed: null },
        channels, frames, telemetry,
      };
      stopReason = null;
      endedAt = null;
      last = null;
      return ride;
    },
  };
}
