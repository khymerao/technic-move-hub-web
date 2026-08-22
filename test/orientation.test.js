import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quatFromOrint, quatHubToScene, quatFromTilt, quatFromEuler, eulerFromQuat,
  eulerSceneFromQuat, quatMul, quatConj, normalise, applyMount, alignSign,
  smoothingFactor,
} from '../src/orientation.js';

const near = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${a} is not within ${tol} of ${b}`);
const nearQuat = (a, b, tol = 1e-6) => {
  for (const k of ['w', 'x', 'y', 'z']) near(a[k], b[k], tol);
};

// Five poses read off the hub through the Debug port-introspection panel
// watching port 0x3B, 2026-07-30. Each array is the eight raw bytes of the
// Port Value payload; decodeWords() below reads it as four signed 16-bit
// little-endian words, the same layout `parseWords16(bytes, 4)` reads on the wire.
const LEVEL_1 = [64, 1, 17, 0, 4, 0, 77, 252]; // level, on wheels, nose away
const NOSE_UP = [214, 0, 91, 2, 166, 0, 19, 253]; // nose up ~90°, on its tail
const ROLLED_RIGHT = [231, 0, 134, 0, 61, 253, 114, 253]; // rolled onto its right side 90°
const YAWED_RIGHT = [135, 3, 7, 0, 10, 0, 85, 254]; // yawed 90° to the right, on wheels
const LEVEL_2 = [69, 1, 19, 0, 1, 0, 79, 252]; // level again, ~140s later

function decodeWords(bytes) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const v = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    out.push(v > 32767 ? v - 65536 : v);
  }
  return out;
}

// captureQ⁻¹ ⊗ q, in the scene frame — the same composition applyMount does,
// used here to relate two poses the way the provocations were physically applied:
// about the car's own axes, relative to the level pose.
function bodyRelativeScene(poseBytes, levelBytes) {
  const sceneLevel = quatHubToScene(quatFromOrint(decodeWords(levelBytes)));
  const scenePose = quatHubToScene(quatFromOrint(decodeWords(poseBytes)));
  return quatMul(quatConj(sceneLevel), scenePose);
}

function axisAngle(q) {
  let { w, x, y, z } = q;
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
  const angleDeg = 2 * Math.acos(Math.max(-1, Math.min(1, w))) * (180 / Math.PI);
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  const axis = s < 1e-8 ? { x: 0, y: 0, z: 0 } : { x: x / s, y: y / s, z: z / s };
  return { axis, angleDeg };
}

test('quatFromOrint normalises, so the fixed-point scale never has to be known', () => {
  const small = quatFromOrint([0, 0, 0, 1000]);
  const large = quatFromOrint([0, 0, 0, 16384]);
  nearQuat(small, { w: 1, x: 0, y: 0, z: 0 });
  nearQuat(large, { w: 1, x: 0, y: 0, z: 0 });
});

test('quatFromOrint takes the scalar from the last word', () => {
  nearQuat(quatFromOrint([1000, 0, 0, 0]), { w: 0, x: 1, y: 0, z: 0 });
  nearQuat(quatFromOrint([0, 1000, 0, 0]), { w: 0, x: 0, y: 1, z: 0 });
});

test('quatFromOrint refuses a short payload and an all-zero sample', () => {
  assert.equal(quatFromOrint([1, 2, 3]), null);
  assert.equal(quatFromOrint([0, 0, 0, 0]), null);
});

test('the level pose decodes with the scalar last, and its magnitude dominates', () => {
  const q = quatFromOrint(decodeWords(LEVEL_1));
  near(Math.hypot(q.w, q.x, q.y, q.z), 1, 1e-9);
  assert.ok(Math.abs(q.w) > Math.abs(q.x));
  assert.ok(Math.abs(q.w) > Math.abs(q.y));
  assert.ok(Math.abs(q.w) > Math.abs(q.z));
});

test('rolling the car onto its right side lands on the scene\'s +X (forward) axis', () => {
  const { axis, angleDeg } = axisAngle(bodyRelativeScene(ROLLED_RIGHT, LEVEL_1));
  assert.ok(axis.x > 0.95, `axis ${JSON.stringify(axis)} does not point along +X`);
  assert.ok(Math.abs(angleDeg - 92) < 15, `angle ${angleDeg} is not close to 92°`);
});

test('tipping the car nose-up lands on the scene\'s +Z (right) axis', () => {
  const { axis, angleDeg } = axisAngle(bodyRelativeScene(NOSE_UP, LEVEL_1));
  assert.ok(axis.z > 0.95, `axis ${JSON.stringify(axis)} does not point along +Z`);
  assert.ok(Math.abs(angleDeg - 76) < 15, `angle ${angleDeg} is not close to 76°`);
});

test('yawing the car right lands on the scene\'s -Y (down) axis', () => {
  const { axis, angleDeg } = axisAngle(bodyRelativeScene(YAWED_RIGHT, LEVEL_1));
  assert.ok(axis.y < -0.95, `axis ${JSON.stringify(axis)} does not point along -Y`);
  assert.ok(Math.abs(angleDeg - 92) < 15, `angle ${angleDeg} is not close to 92°`);
});

test('the scene-frame Euler readout: positive pitch nose-up, positive roll right-side-down, positive yaw right turn', () => {
  const roll = eulerSceneFromQuat(bodyRelativeScene(ROLLED_RIGHT, LEVEL_1));
  const pitch = eulerSceneFromQuat(bodyRelativeScene(NOSE_UP, LEVEL_1));
  const yaw = eulerSceneFromQuat(bodyRelativeScene(YAWED_RIGHT, LEVEL_1));
  assert.ok(roll.roll > 45, `roll ${roll.roll} is not positive and large`);
  assert.ok(pitch.pitch > 45, `pitch ${pitch.pitch} is not positive and large`);
  assert.ok(yaw.yaw > 45, `yaw ${yaw.yaw} is not positive and large`);
});

test('the level pose read twice, 140 s apart, agrees to within a degree — the drift evidence', () => {
  const { angleDeg } = axisAngle(bodyRelativeScene(LEVEL_2, LEVEL_1));
  assert.ok(angleDeg < 1, `drifted ${angleDeg}° in 140 s`);
});

test('eulerFromQuat: identity is level', () => {
  const e = eulerFromQuat({ w: 1, x: 0, y: 0, z: 0 });
  near(e.roll, 0); near(e.pitch, 0); near(e.yaw, 0);
});

test('eulerFromQuat recovers a 90 degree turn about each axis', () => {
  for (const axis of ['roll', 'pitch', 'yaw']) {
    const e = eulerFromQuat(quatFromEuler({ [axis]: 90 }));
    near(e[axis], 90, 1e-6);
    for (const other of ['roll', 'pitch', 'yaw']) {
      if (other !== axis) near(e[other], 0, 1e-6);
    }
  }
});

test('eulerFromQuat clamps at the pitch pole instead of returning NaN', () => {
  // A quaternion just past the asin domain from accumulated rounding.
  const e = eulerFromQuat(normalise({ w: 0.7071068, x: 0, y: 0.7071068, z: 0 }));
  near(e.pitch, 90, 1e-3);
  assert.ok(Number.isFinite(e.roll) && Number.isFinite(e.yaw));
});

test('quatFromTilt turns three degree readings into the same rotation', () => {
  nearQuat(quatFromTilt({ x: 90, y: 0, z: 0 }), quatFromEuler({ roll: 90 }));
});

test('applyMount is identity at the pose it was captured in', () => {
  const capture = quatFromEuler({ roll: 30, pitch: -12, yaw: 200 });
  nearQuat(applyMount(capture, capture), { w: 1, x: 0, y: 0, z: 0 });
});

test('applyMount leaves the relative rotation intact', () => {
  const capture = quatFromEuler({ roll: 30, pitch: 0, yaw: 0 });
  const later = quatMul(capture, quatFromEuler({ pitch: 20 }));
  near(eulerFromQuat(applyMount(later, capture)).pitch, 20, 1e-6);
});

test('applyMount passes the sample through when nothing was captured', () => {
  const q = quatFromEuler({ roll: 10 });
  nearQuat(applyMount(q, null), q);
});

test('quatConj and quatMul: a rotation times its conjugate is identity', () => {
  const q = quatFromEuler({ roll: 15, pitch: 25, yaw: 35 });
  nearQuat(quatMul(q, quatConj(q)), { w: 1, x: 0, y: 0, z: 0 });
});

test('alignSign takes the short way round when the stream flips sign', () => {
  const prev = quatFromEuler({ yaw: 5 });
  const next = quatFromEuler({ yaw: 15 });
  const flipped = { w: -next.w, x: -next.x, y: -next.y, z: -next.z };
  // Without the guard this is the 350 degree path.
  const dotFlipped = prev.w * flipped.w + prev.x * flipped.x
    + prev.y * flipped.y + prev.z * flipped.z;
  assert.ok(dotFlipped < 0, 'the fixture must actually be sign-flipped');
  nearQuat(alignSign(prev, flipped), next);
});

test('alignSign leaves an already-aligned sample alone', () => {
  const prev = quatFromEuler({ yaw: 5 });
  const next = quatFromEuler({ yaw: 15 });
  nearQuat(alignSign(prev, next), next);
});

test('alignSign passes the first sample through', () => {
  const next = quatFromEuler({ yaw: 15 });
  nearQuat(alignSign(null, next), next);
});

test('smoothingFactor is frame-rate independent', () => {
  // Two 8ms frames must smooth as far as one 16ms frame.
  const one = smoothingFactor(16, 100);
  const a = smoothingFactor(8, 100);
  const twice = 1 - (1 - a) * (1 - a);
  near(one, twice, 1e-9);
  near(smoothingFactor(0, 100), 0);
  assert.ok(smoothingFactor(1000, 100) < 1);
});
