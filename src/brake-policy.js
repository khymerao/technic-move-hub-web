// Pure brake/peak state machine: float-vs-brake decision, recent-peak tracking,
// staging and the duplicate guard. Time is injected so it can be driven
// deterministically from tests; it knows nothing about BLE or the DOM.
//
// See docs/DESIGN-NOTES.md § Braking from speed browns out the hub

import { needsStagedBrake } from './control-math.js';

export function createBrakePolicy({
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  // How long a high speed still counts as "spinning fast" after it was commanded.
  peakWindowMs = 1500,
  brakeStageMs = 400,     // the coast window before the brake lands
  // See docs/DESIGN-NOTES.md § The staging threshold is far lower than it looks like it should be
  brakeDirectMax = 10,
} = {}) {
  const lastSpeed = new Map();  // key -> last commanded speed
  const peak = new Map();       // key -> {speed, at}, recent peak
  const stages = new Map();     // key -> the pending stage it takes part in

  const asKeys = (keys) => (Array.isArray(keys) ? keys : [keys]);

  const forget = (stage) => {
    for (const key of stage.keys) if (stages.get(key) === stage) stages.delete(key);
  };

  // Settles every settled() caller attached to THIS stage, once `written` —
  // whatever the brake action returned — has settled. A write that rejected
  // rejects them; with nobody attached, the failure is dropped here.
  const release = (stage, written) => {
    const waiters = stage.waiters.splice(0);
    Promise.resolve(written).then(
      () => { for (const w of waiters) w.resolve(); },
      (err) => { for (const w of waiters) w.reject(err); },
    );
  };

  const cancel = (keys) => {
    for (const key of asKeys(keys)) {
      const stage = stages.get(key);
      if (!stage) continue;
      clearTimer(stage.timer);
      forget(stage);
      release(stage, undefined);
    }
  };

  // What speed the motor is really doing: the recent peak, else the last command.
  // See docs/DESIGN-NOTES.md § The recent peak, not the last command, decides whether to stage
  const reference = (key) => {
    const p = peak.get(key);
    const recent = p && now() - p.at < peakWindowMs ? p.speed : 0;
    const last = lastSpeed.get(key) ?? 0;
    return Math.abs(recent) > Math.abs(last) ? recent : last;
  };

  const note = (keys, speed) => {
    const at = now();
    for (const key of asKeys(keys)) {
      lastSpeed.set(key, speed);
      const prev = peak.get(key);
      if (!prev || at - prev.at > peakWindowMs || Math.abs(speed) > Math.abs(prev.speed)) {
        peak.set(key, { speed, at });
      }
    }
  };

  return {
    // A real drive command supersedes a pending stop; a zero command does not.
    // See docs/DESIGN-NOTES.md § A pending stop survives a zero command but not a real one
    noteSpeed(keys, speed) {
      if (speed !== 0) cancel(keys);
      note(keys, speed);
    },

    // Returns whatever the invoked callback returned, so callers can await the
    // write. Nothing is returned when the request is dropped.
    requestBrake(keys, { coast, brake }) {
      const list = asKeys(keys);
      // A stage already running for any of these keys is left to finish.
      // See docs/DESIGN-NOTES.md § A second brake request must not restart the staging
      if (list.some((key) => stages.has(key))) return undefined;
      const staged = list.some((key) => needsStagedBrake(reference(key), brakeDirectMax));
      note(list, 0);
      if (!staged) return brake();
      const stage = { keys: list, timer: null, waiters: [] };
      stage.timer = setTimer(() => {
        forget(stage);
        try {
          const written = brake();
          release(stage, written);
          return written;
        } catch (err) {
          release(stage, Promise.reject(err));
          throw err;
        }
      }, brakeStageMs);
      for (const key of list) stages.set(key, stage);
      return coast();
    },

    // Awaitable completion of a pending stop, alongside — never instead of —
    // what requestBrake returns. Resolves once nothing is staged for the keys,
    // and rejects with what the brake write rejected with.
    settled(keys) {
      const pending = asKeys(keys)
        .map((key) => stages.get(key))
        .filter((stage) => stage !== undefined)
        .map((stage) => new Promise((resolve, reject) => {
          stage.waiters.push({ resolve, reject });
        }));
      return Promise.all(pending).then(() => undefined);
    },
  };
}
