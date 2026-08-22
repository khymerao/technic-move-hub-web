import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impactMagnitude, isImpact } from '../src/impact.js';

const at = (x, y, z) => ({ x, y, z });

test('impactMagnitude: a still model registers nothing', () => {
  assert.equal(impactMagnitude(at(0, 0, 1000), at(0, 0, 1000)), 0);
});

test('impactMagnitude: measures the jump between samples, not the absolute value', () => {
  // Sitting on its side is still 1000mG of gravity, but it is not a crash.
  assert.equal(impactMagnitude(at(1000, 0, 0), at(1000, 0, 0)), 0);
});

test('impactMagnitude: a sharp hit on one axis', () => {
  assert.equal(impactMagnitude(at(0, 0, 1000), at(2400, 0, 1000)), 2400);
});

test('impactMagnitude: combines all three axes', () => {
  assert.equal(impactMagnitude(at(0, 0, 0), at(300, 400, 0)), 500);
});

test('impactMagnitude: missing samples are not a crash', () => {
  assert.equal(impactMagnitude(null, at(9999, 0, 0)), 0);
  assert.equal(impactMagnitude(at(0, 0, 0), null), 0);
});

test('isImpact: ordinary driving stays below the threshold', () => {
  // Hard acceleration and cornering move the vector, but nothing like a wall.
  assert.equal(isImpact(impactMagnitude(at(0, 0, 1000), at(350, 120, 980)), 1500), false);
});

test('isImpact: hitting something crosses it', () => {
  assert.equal(isImpact(impactMagnitude(at(0, 0, 1000), at(2600, 400, 900)), 1500), true);
});

test('isImpact: threshold is inclusive at the boundary', () => {
  assert.equal(isImpact(1500, 1500), true);
  assert.equal(isImpact(1499, 1500), false);
});
