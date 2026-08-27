// Pure haptics mixer: per-channel transient envelopes for the strong motor, a
// modulated bed for the weak motor, ducking, staleness fade and the per-motor
// intensity scale. Time is injected so it can be driven deterministically from
// tests; it knows nothing about the Gamepad API, the DOM or the hub. Every
// numeric entry point is finite-guarded, so no NaN can reach the driver.
//
// See docs/superpowers/specs/2026-08-24-gamepad-haptic-feedback-design.md
// § `src/haptics-mix.js` — pure mixer, for holdMs, decayMs, duckTailMs,
// duckThreshold, bedStaleMs and bedFadeMs.
// See docs/superpowers/specs/2026-08-24-gamepad-haptic-feedback-design.md
// § Channels, for bedFloor, bedSpan, turnWeight and accelWeight.
import { clampUnit } from './control-math.js';

const round2 = (v) => (v === 0 ? 0 : Math.round(v * 100) / 100);

const CHANNELS = ['impact', 'cut', 'brake'];

export function createHapticsMix({
  now = () => performance.now(),
  holdMs = 60,
  decayMs = 220,
  duckTailMs = 140,
  bedStaleMs = 600,
  bedFadeMs = 400,
  duckThreshold = 0.05,
  bedFloor = 0.08,
  bedSpan = 0.55,
  turnWeight = 0.25,
  accelWeight = 0.15,
} = {}) {
  const hits = new Map();
  let bedInput = { drive: 0, turn: 0, accel: 0 };
  let bedAt = -Infinity;
  let lastDrive = 0;
  let duckedUntil = -Infinity;
  let settings = { enabled: false, transient: 1, bed: 1 };

  const stamp = () => {
    const t = now();
    return Number.isFinite(t) ? t : null;
  };

  const envelope = (hit, t) => {
    const age = t - hit.at;
    if (age < 0) return hit.magnitude;
    if (age <= holdMs) return hit.magnitude;
    const fade = 1 - (age - holdMs) / decayMs;
    return fade <= 0 ? 0 : hit.magnitude * fade;
  };

  const bedLevel = (t) => {
    const age = t - bedAt;
    if (age >= bedStaleMs + bedFadeMs) return 0;
    const raw = clampUnit(
      bedInput.drive * bedSpan
      + bedInput.turn * turnWeight
      + bedInput.accel * accelWeight,
    );
    const level = raw > 0 ? clampUnit(bedFloor + raw) : 0;
    if (age <= bedStaleMs) return level;
    return level * (1 - (age - bedStaleMs) / bedFadeMs);
  };

  return {
    hit(channel, magnitude) {
      if (!CHANNELS.includes(channel)) return;
      const m = clampUnit(magnitude);
      if (m === 0) return;
      const at = stamp();
      if (at === null) return;
      const live = hits.get(channel);
      if (live && m <= envelope(live, at)) return;
      hits.set(channel, { magnitude: m, at });
    },

    drive({ drive = 0, turn = 0, dtMs = 16 } = {}) {
      const at = stamp();
      if (at === null) return;
      const d = clampUnit(Math.abs(drive));
      const rate = Number.isFinite(dtMs) && dtMs > 0
        ? Math.abs(d - lastDrive) / (dtMs / 1000)
        : 0;
      lastDrive = d;
      bedInput = { drive: d, turn: clampUnit(Math.abs(turn)), accel: clampUnit(rate) };
      bedAt = at;
    },

    setSettings({ enabled = false, transient = 1, bed = 1 } = {}) {
      settings = { enabled: !!enabled, transient: clampUnit(transient), bed: clampUnit(bed) };
    },

    tick(t = now()) {
      if (!settings.enabled) return { strong: 0, weak: 0 };
      const at = Number.isFinite(t) ? t : stamp();
      if (at === null) return { strong: 0, weak: 0 };
      let strongRaw = 0;
      for (const [channel, hit] of hits) {
        const level = envelope(hit, at);
        if (level <= 0) hits.delete(channel);
        else strongRaw = Math.max(strongRaw, level);
      }
      const strong = clampUnit(strongRaw) * settings.transient;
      if (strong > duckThreshold) duckedUntil = at + duckTailMs;
      const weakRaw = at < duckedUntil ? 0 : bedLevel(at);
      return {
        strong: round2(strong),
        weak: round2(clampUnit(weakRaw) * settings.bed),
      };
    },

    // How long the loudest live transient still has to run, in ms. The
    // emergency stop asks this before it silences: the crash it is reacting to
    // is the one hit that must not be cancelled by the stop it caused.
    // See docs/DESIGN-NOTES.md § A rumble bug must not be able to stop the car
    transientRemaining(t = now()) {
      const at = Number.isFinite(t) ? t : stamp();
      if (at === null || !settings.enabled) return 0;
      let left = 0;
      for (const hit of hits.values()) {
        if (envelope(hit, at) <= 0) continue;
        left = Math.max(left, hit.at + holdMs + decayMs - at);
      }
      return left > 0 ? left : 0;
    },

    // Drops the bed and leaves the transients alone. A stop clears the ride
    // feel; it must not erase the crash that caused it, nor the second hit the
    // same collision is about to deliver.
    // See docs/DESIGN-NOTES.md § The alert cannot wait for the next tick
    silenceBed() {
      bedInput = { drive: 0, turn: 0, accel: 0 };
      bedAt = -Infinity;
      lastDrive = 0;
    },

    silence() {
      hits.clear();
      bedInput = { drive: 0, turn: 0, accel: 0 };
      bedAt = -Infinity;
      lastDrive = 0;
      duckedUntil = -Infinity;
    },
  };
}
