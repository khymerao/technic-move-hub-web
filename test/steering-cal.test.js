import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionControlStep, relativePos, isRunaway } from '../src/steering-cal.js';

test('positionControlStep: proportional, clamped, deadband', () => {
  assert.equal(positionControlStep(100, 0, { kp: 0.5, maxSpeed: 60, deadband: 3 }), 50);
  assert.equal(positionControlStep(1000, 0, { kp: 0.5, maxSpeed: 60, deadband: 3 }), 60);
  assert.equal(positionControlStep(-1000, 0, { kp: 0.5, maxSpeed: 60, deadband: 3 }), -60);
  assert.equal(positionControlStep(2, 0, { kp: 0.5, maxSpeed: 60, deadband: 3 }), 0);
});
test('relativePos: zero is tracked in software, not on the hub', () => {
  // Hub keeps reporting its own POS; we subtract the captured offset.
  assert.equal(relativePos(-232, -232), 0);
  assert.equal(relativePos(-200, -232), 32);
  assert.equal(relativePos(-300, -232), -68);
});
test('isRunaway: true once position leaves the safe envelope', () => {
  assert.equal(isRunaway(100, 90), false);   // within throw
  assert.equal(isRunaway(200, 90), false);   // 2x throw, still tolerated
  assert.equal(isRunaway(300, 90), true);    // >3x throw = mechanism lost
  assert.equal(isRunaway(-300, 90), true);
});

test('positionControlStep: output below minPower is dropped to zero', () => {
  // A couple of percent cannot turn the rack — it just stalls the motor.
  assert.equal(positionControlStep(110, 100, { kp: 0.3, maxSpeed: 60, deadband: 8, minPower: 6 }), 0);
});
test('positionControlStep: output at or above minPower passes through', () => {
  assert.equal(positionControlStep(200, 100, { kp: 0.3, maxSpeed: 60, deadband: 8, minPower: 6 }), 30);
});
