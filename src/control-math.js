// Pure control-input math: deadzone, response curve, axis mapping. No DOM.

export function applyDeadzone(value, threshold = 0.15) {
  const a = Math.abs(value);
  if (a <= threshold) return 0;
  const scaled = (a - threshold) / (1 - threshold);
  return Math.sign(value) * scaled;
}

export function expCurve(value, exponent = 2) {
  return Math.sign(value) * Math.pow(Math.abs(value), exponent);
}

export function clampUnit(value) {
  return Number.isFinite(value) ? (value > 0 ? (value < 1 ? value : 1) : 0) : 0;
}

export function axisToSpeed(axis) {
  return Math.round(expCurve(applyDeadzone(axis)) * 100);
}

export function axisToSteer(axis) {
  return Math.round(expCurve(applyDeadzone(axis)) * 100);
}

// Above this speed the stop is staged: coast to shed energy, then brake.
// See docs/DESIGN-NOTES.md § Braking from speed browns out the hub
export function needsStagedBrake(lastSpeed, threshold = 50) {
  return Math.abs(lastSpeed ?? 0) > threshold;
}

// Below `min` a motor only stalls and buzzes, so treat it as a stop.
// See docs/DESIGN-NOTES.md § Below the stall threshold, jitter re-triggers the staged brake
export function applyMinPower(value, min) {
  return Math.abs(value) < min ? 0 : value;
}
