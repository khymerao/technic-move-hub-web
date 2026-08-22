// Collision detection from the accelerometer, which reports a gravity vector in mG.
//
// See docs/DESIGN-NOTES.md § Comparing successive samples makes mounting orientation irrelevant

// Length of the difference between two acceleration vectors, in mG.
export function impactMagnitude(prev, cur) {
  if (!prev || !cur) return 0;
  const dx = cur.x - prev.x, dy = cur.y - prev.y, dz = cur.z - prev.z;
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
}

// A hit is a jump past the threshold; anything gentler is normal driving.
export function isImpact(magnitude, thresholdMg) {
  return magnitude >= thresholdMg;
}
