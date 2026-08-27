import { log } from './debug-log.js';

const MIN_DURATION_MS = 30;
const MAX_DURATION_MS = 1000;
const EPSILON = 0.02;
// The bed gets a wider one than the transient. It is driven continuously from
// stick position, so at the transient's threshold it re-emits on noise; a hit
// has to stay crisp, so it keeps EPSILON.
// See docs/DESIGN-NOTES.md § The bed answers the ride, not the stick's noise
export const WEAK_EPSILON = 0.07;
// How long after the last tick a hit assumes there is no poll loop left to
// write its zero, so it must arm its own. Its own constant, not a multiple of
// the emission floor: tying the two meant a longer floor could leave the motor
// running after a staged brake, with nothing scheduled to stop it.
const TRAILING_ARM_MS = 240;
const PERCEPTUAL_FLOOR = 0.05;

export function createHapticsDriver({
  mix,
  intervalMs = 80,
  durationMs = 140,
  // Injectable so a test can put the old, narrower threshold and the current
  // one side by side in one run rather than compare against a frozen number.
  weakEpsilon = WEAK_EPSILON,
  now = () => performance.now(),
  onStatus = () => {},
} = {}) {
  const duration = Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, durationMs));
  let state = 'unknown';
  let disabled = false;
  let lastAt = -Infinity;
  let last = null;
  let target = null;
  let onBlur = null;
  let onVisibility = null;
  let lastPad = null;
  let lastTickAt = -Infinity;
  let trailing = null;
  let timers = [];
  let testResolve = null;

  const messageOf = (err) => {
    try {
      return err?.message ?? String(err);
    } catch {
      return 'unknown error';
    }
  };

  const setState = (next) => {
    if (state === next) return;
    state = next;
    try {
      onStatus(state);
    } catch (err) {
      log('haptics onStatus failed:', messageOf(err));
    }
  };

  const callMix = (method, ...args) => {
    try {
      const fn = mix?.[method];
      if (typeof fn !== 'function') return undefined;
      return fn.apply(mix, args);
    } catch (err) {
      log('haptics mix failed:', method, messageOf(err));
      return undefined;
    }
  };

  // Not the shared clampUnit: this one coerces, and anything under the
  // perceptual floor becomes exact zero — which is what makes it silent, and
  // silence is treated differently here from a quiet rumble.
  // See docs/DESIGN-NOTES.md § One name for one behaviour
  const clampAudible = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    if (n < PERCEPTUAL_FLOOR) return 0;
    return n > 1 ? 1 : n;
  };

  const actuatorOf = (pad) => pad?.vibrationActuator ?? null;

  const finishTest = () => {
    if (!testResolve) return;
    const resolve = testResolve;
    testResolve = null;
    resolve(state);
  };

  const clearTimers = () => {
    for (const id of timers) clearTimeout(id);
    timers = [];
    if (trailing) { clearTimeout(trailing); trailing = null; }
    finishTest();
  };

  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers = timers.filter((t) => t !== id);
      fn();
    }, ms);
    timers.push(id);
  };

  const emit = (actuator, rawStrong, rawWeak, force = false) => {
    if (disabled && !force) return;
    const strong = clampAudible(rawStrong);
    const weak = clampAudible(rawWeak);
    last = { strong, weak };
    let played;
    try {
      played = actuator.playEffect('dual-rumble', {
        duration,
        startDelay: 0,
        strongMagnitude: strong,
        weakMagnitude: weak,
      });
    } catch (err) {
      last = null;
      if (err?.name === 'NotSupportedError') {
        disabled = true;
        setState('unsupported');
        log('haptics unsupported:', messageOf(err));
      } else {
        log('haptics play failed:', messageOf(err));
      }
      return;
    }
    setState(strong === 0 && weak === 0 ? 'idle' : 'playing');
    Promise.resolve(played).catch((err) => {
      if (err?.name !== 'NotSupportedError') return;
      disabled = true;
      setState('unsupported');
      log('haptics unsupported:', messageOf(err));
    });
  };

  const same = (a, b) => a && Math.abs(a.strong - b.strong) < EPSILON
    && Math.abs(a.weak - b.weak) < weakEpsilon;

  const isExactZero = (v) => Boolean(v) && v.strong === 0 && v.weak === 0;

  const doReset = (pad = null) => {
    const actuator = actuatorOf(pad ?? lastPad);
    clearTimers();
    callMix('silence');
    last = null;
    lastAt = -Infinity;
    if (!actuator) return;
    try {
      Promise.resolve(actuator.reset()).catch(() => {});
    } catch (err) {
      log('haptics reset failed:', messageOf(err));
    }
  };

  const doDetach = () => {
    clearTimers();
    if (!target) return;
    try {
      target.removeEventListener('blur', onBlur);
      target.removeEventListener('visibilitychange', onVisibility);
    } catch (err) {
      log('haptics detach failed:', messageOf(err));
    }
    target = null;
    onBlur = null;
    onVisibility = null;
  };

  return {
    drive(input) { callMix('drive', input); },

    // Emits on the spot rather than waiting for the next poll tick. The stop a
    // collision triggers tears that loop down in the same synchronous turn, so
    // a hit that waits for a tick is a hit that never plays.
    // See docs/DESIGN-NOTES.md § The alert cannot wait for the next tick
    hit(channel, magnitude) {
      callMix('hit', channel, magnitude);
      if (disabled) return;
      const actuator = actuatorOf(lastPad);
      if (!actuator) return;
      const t = now();
      const mixed = callMix('tick', t);
      if (!mixed || mixed.strong <= 0) return;
      lastAt = t;
      emit(actuator, mixed.strong, mixed.weak, true);
      // Nothing else will write the zero when the poll loop is gone — an
      // emergency stop tears it down, and a staged brake announces after that.
      if (t - lastTickAt >= TRAILING_ARM_MS) {
        const left = callMix('transientRemaining', t) ?? 0;
        if (trailing) { clearTimeout(trailing); trailing = null; }
        trailing = setTimeout(() => {
          trailing = null;
          const a = actuatorOf(lastPad);
          if (a) emit(a, 0, 0, true);
        }, Math.max(0, left));
      }
    },

    setSettings(settings) { callMix('setSettings', settings); },

    tick(pad, t = now()) {
      lastTickAt = t;
      if (pad) lastPad = pad;
      if (disabled) return;
      const actuator = actuatorOf(pad);
      if (!actuator) {
        if (pad) setState('unsupported');
        return;
      }
      const out = callMix('tick', t);
      if (!out || typeof out !== 'object') return;
      const strong = clampAudible(out.strong);
      const weak = clampAudible(out.weak);
      const silent = strong === 0 && weak === 0;
      // The floor is waived for a transient LETTING GO — a hit that has ended
      // must not hang on for the rest of the interval. It is not waived merely
      // because the bed reached zero: a bed hovering on the perceptual floor
      // quantises to zero and back, and waiving the floor for that wrote at
      // frame rate. A real stop does not come through here at all; silence()
      // and hit() force their own writes.
      // See docs/DESIGN-NOTES.md § The bed answers the ride, not the stick's noise
      const releasing = strong === 0 && (last?.strong ?? 0) > 0;
      if (!releasing && t - lastAt < intervalMs) return;
      if (same(last, { strong, weak }) && !(silent && !isExactZero(last))) return;
      lastAt = t;
      emit(actuator, strong, weak);
    },

    silence(pad = null) {
      const t = now();
      const remaining = callMix('transientRemaining', t) ?? 0;
      // A stop that lands while an earlier stop's transient is still playing
      // leaves it alone: the disconnect path silences twice for one event.
      if (trailing && remaining <= 0) return;
      clearTimers();
      const held = remaining > 0 ? (callMix('tick', t)?.strong ?? 0) : 0;
      callMix('silenceBed');
      last = null;
      lastAt = -Infinity;
      const actuator = actuatorOf(pad ?? lastPad);
      if (!actuator) return;
      // The bed goes at once. A transient still running is the crash itself —
      // it plays out, then silence lands.
      if (held > 0) {
        emit(actuator, held, 0, true);
        if (trailing) clearTimeout(trailing);
        trailing = setTimeout(() => {
          trailing = null;
          const a = actuatorOf(pad ?? lastPad);
          if (a) emit(a, 0, 0, true);
        }, remaining);
        return;
      }
      emit(actuator, 0, 0, true);
    },

    reset(pad = null) { doReset(pad); },

    test(pad) {
      if (pad) lastPad = pad;
      const actuator = actuatorOf(pad ?? lastPad);
      if (!actuator) {
        setState('unsupported');
        return Promise.resolve(state);
      }
      if (disabled) return Promise.resolve(state);
      clearTimers();
      emit(actuator, 0, 0.5);
      return new Promise((resolve) => {
        testResolve = resolve;
        later(() => {
          emit(actuator, 1, 0);
          later(() => {
            emit(actuator, 0, 0);
            finishTest();
          }, duration);
        }, duration);
      });
    },

    attach(t) {
      doDetach();
      target = t;
      onBlur = () => doReset(lastPad);
      onVisibility = () => {
        if (target?.document?.visibilityState === 'hidden') doReset(lastPad);
      };
      target.addEventListener('blur', onBlur);
      target.addEventListener('visibilitychange', onVisibility);
    },

    detach() { doDetach(); },

    status: () => state,
  };
}
