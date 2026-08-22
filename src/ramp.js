// Acceleration profiles for the drive output: how fast the motor is allowed to
// reach the speed the stick curve asked for.
//
// Pure: no timers, no clock. The caller supplies elapsed time.
//
// See docs/DESIGN-NOTES.md § Deceleration is never rate-limited

export const RAMP_MODES = ['instant', 'linear', 'expo'];

// Percent per second: how fast linear mode may change the commanded speed.
export const DEFAULT_RATE = 220;
// Time constant in ms for expo mode: the lag reaches ~63% of the gap per tau.
export const DEFAULT_TAU = 260;

// One step toward `target`. Returns the new commanded speed.
export function rampStep(current, target, dtMs, { mode = 'instant', rate = DEFAULT_RATE, tau = DEFAULT_TAU } = {}) {
  if (mode === 'instant' || dtMs <= 0) return target;
  // Only acceleration is limited. The `current !== 0` test is load-bearing:
  // sign(0) is 0, so a start from standstill would otherwise read as a reversal.
  const reversing = current !== 0 && target !== 0 && Math.sign(target) !== Math.sign(current);
  if (Math.abs(target) < Math.abs(current) || reversing) return target;

  if (mode === 'linear') {
    const maxDelta = (rate * dtMs) / 1000;
    const delta = target - current;
    if (Math.abs(delta) <= maxDelta) return target;
    return Math.round(current + Math.sign(delta) * maxDelta);
  }

  if (mode === 'expo') {
    // First-order lag: quick off the mark, easing as it closes on the target.
    const alpha = 1 - Math.exp(-dtMs / tau);
    const next = current + (target - current) * alpha;
    // Rounding alone can stall a slow approach; nudge at least one unit.
    const rounded = Math.round(next);
    if (rounded === current && target !== current) return current + Math.sign(target - current);
    return rounded;
  }

  return target;
}
