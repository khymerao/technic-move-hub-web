// Pure attitude math: fixed-point quaternions in, degrees and smoothing out.
// No DOM, no BLE, no three.js.
//
// See docs/superpowers/specs/2026-07-30-motion-visualisation-design.md

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

export function normalise(q) {
  const n = Math.hypot(q.w, q.x, q.y, q.z);
  if (!n || !Number.isFinite(n)) return null;
  return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
}

// See docs/DESIGN-NOTES.md § A normalised quaternion needs no scale constant
export function quatFromOrint(values) {
  if (!values || values.length < 4) return null;
  const [x, y, z, w] = values;
  return normalise({ w, x, y, z });
}

// See docs/DESIGN-NOTES.md § The hub's axes are not the renderer's
export function quatHubToScene(q) {
  if (!q) return null;
  return { w: q.w, x: q.z, y: q.x, z: -q.y };
}

export function quatFromEuler({ roll = 0, pitch = 0, yaw = 0 }) {
  const cr = Math.cos(roll * RAD / 2), sr = Math.sin(roll * RAD / 2);
  const cp = Math.cos(pitch * RAD / 2), sp = Math.sin(pitch * RAD / 2);
  const cy = Math.cos(yaw * RAD / 2), sy = Math.sin(yaw * RAD / 2);
  return {
    w: cr * cp * cy + sr * sp * sy,
    x: sr * cp * cy - cr * sp * sy,
    y: cr * sp * cy + sr * cp * sy,
    z: cr * cp * sy - sr * sp * cy,
  };
}

export const quatFromTilt = ({ x = 0, y = 0, z = 0 }) =>
  quatFromEuler({ roll: x, pitch: y, yaw: z });

export function eulerFromQuat(q) {
  if (!q) return null;
  const { w, x, y, z } = q;
  const sp = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  return {
    roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * DEG,
    pitch: Math.asin(sp) * DEG,
    yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * DEG,
  };
}

// See docs/DESIGN-NOTES.md § The hub's axes are not the renderer's
export function eulerSceneFromQuat(q) {
  if (!q) return null;
  return eulerFromQuat({ w: q.w, x: q.x, y: q.z, z: -q.y });
}

export const quatConj = (q) => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });

export function quatMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

// See docs/DESIGN-NOTES.md § The mounting correction is a re-centre, not a constant
export const applyMount = (q, captureQ) =>
  captureQ ? quatMul(quatConj(captureQ), q) : q;

// See docs/DESIGN-NOTES.md § q and -q are the same rotation, and the stream flips
export function alignSign(prev, next) {
  if (!prev || !next) return next;
  const dot = prev.w * next.w + prev.x * next.x + prev.y * next.y + prev.z * next.z;
  return dot < 0 ? { w: -next.w, x: -next.x, y: -next.y, z: -next.z } : next;
}

// See docs/DESIGN-NOTES.md § Smoothing is time-based, not per-frame
export const smoothingFactor = (dtMs, tauMs = 100) =>
  tauMs <= 0 ? 1 : 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
