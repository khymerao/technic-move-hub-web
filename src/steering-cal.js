// Pure steering math: calibration + P-controller. No BLE, no DOM.

// Zero is tracked in software; the hub does not reliably honour a POS preset.
// See docs/DESIGN-NOTES.md § Steering zero is tracked in software
export function relativePos(rawPos, zeroOffset) {
  return rawPos - zeroOffset;
}

// Position far outside the configured throw means the loop lost the mechanism.
// See docs/DESIGN-NOTES.md § A runaway means the mechanism, not the loop, is wrong
export function isRunaway(pos, maxAngle) {
  return Math.abs(pos) > Math.max(30, maxAngle * 3);
}

export function positionControlStep(targetPos, currentPos, { kp = 0.5, maxSpeed = 60, deadband = 3, minPower = 0 } = {}) {
  const error = targetPos - currentPos;
  if (Math.abs(error) <= deadband) return 0;
  const speed = kp * error;
  const clamped = Math.round(Math.max(-maxSpeed, Math.min(maxSpeed, speed)));
  // Power too small to turn the mechanism only stalls the motor.
  return Math.abs(clamped) < minPower ? 0 : clamped;
}
