import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeadzone, expCurve, axisToSpeed, axisToSteer, needsStagedBrake, applyMinPower } from '../src/control-math.js';

test('applyDeadzone: inside deadzone is zero', () => {
  assert.equal(applyDeadzone(0.1, 0.15), 0);
  assert.equal(applyDeadzone(-0.15, 0.15), 0);
});
test('applyDeadzone: full deflection stays 1', () => {
  assert.equal(applyDeadzone(1, 0.15), 1);
  assert.equal(applyDeadzone(-1, 0.15), -1);
});
test('applyDeadzone: rescales just outside deadzone near zero', () => {
  const v = applyDeadzone(0.16, 0.15);
  assert.ok(v > 0 && v < 0.05, `expected small positive, got ${v}`);
});
test('expCurve: preserves sign, compresses small inputs', () => {
  assert.equal(expCurve(0, 2), 0);
  assert.equal(expCurve(1, 2), 1);
  assert.equal(expCurve(-1, 2), -1);
  assert.ok(Math.abs(expCurve(0.5, 2) - 0.25) < 1e-9);
});
test('axisToSpeed: integer in range', () => {
  assert.equal(axisToSpeed(0), 0);
  assert.equal(axisToSpeed(1), 100);
  assert.equal(axisToSpeed(-1), -100);
  assert.equal(Number.isInteger(axisToSpeed(0.7)), true);
});
test('axisToSteer: integer in range', () => {
  assert.equal(axisToSteer(1), 100);
  assert.equal(axisToSteer(-1), -100);
});

test('needsStagedBrake: braking from high speed must be staged', () => {
  // Slamming a brake on while the motors spin fast spikes the current and
  // browns out the hub, so shed speed by coasting first.
  assert.equal(needsStagedBrake(-91, 50), true);
  assert.equal(needsStagedBrake(100, 50), true);
});
test('needsStagedBrake: low speed brakes directly', () => {
  assert.equal(needsStagedBrake(30, 50), false);
  assert.equal(needsStagedBrake(0, 50), false);
});
test('needsStagedBrake: threshold is exclusive — equal speed still brakes direct', () => {
  // The hub died on a direct brake at exactly the old threshold, which is why
  // the production threshold is now a crawl rather than half speed.
  assert.equal(needsStagedBrake(50, 50), false);
  assert.equal(needsStagedBrake(50, 10), true);
});

test('applyMinPower: sub-threshold values collapse to a clean stop', () => {
  assert.equal(applyMinPower(3, 6), 0);
  assert.equal(applyMinPower(-3, 6), 0);
  assert.equal(applyMinPower(0, 6), 0);
});
test('applyMinPower: real movement passes through untouched', () => {
  assert.equal(applyMinPower(6, 6), 6);
  assert.equal(applyMinPower(-40, 6), -40);
});
