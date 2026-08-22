import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInputMix } from '../src/input-mix.js';

const mix = () => createInputMix({ deadzone: 0.1 });

test('an untouched axis passes the pad value through', () => {
  const m = mix();
  assert.equal(m.resolve('throttle', 0.8), 0.8);
});

test('a pad resting inside the deadzone never becomes engaged', () => {
  const m = mix();
  for (let i = 0; i < 100; i++) m.resolve('steer', 0.05);
  assert.equal(m.engaged('steer'), false);
});

test('a pad resting off-centre inside the deadzone cannot lock out touch', () => {
  const m = mix();
  for (let i = 0; i < 100; i++) m.resolve('steer', 0.07);
  m.setTouch('steer', 0.6);
  assert.equal(m.resolve('steer', 0.07), 0.6, 'touch must win over a resting stick');
});

test('an engaged pad wins over an idle touch axis', () => {
  const m = mix();
  assert.equal(m.resolve('throttle', 0.9), 0.9);
});

test('an untouched touch axis contributes nothing, it does not zero the pad', () => {
  const m = mix();
  m.setTouch('throttle', 0.5);
  m.releaseTouch('throttle');
  assert.equal(m.resolve('throttle', 0.9), 0.9);
});

test('the most recent engagement wins, and holding still does not lose it', () => {
  const m = mix();
  m.resolve('steer', 0.8);            // pad engages
  m.setTouch('steer', 0.4);           // touch engages later
  assert.equal(m.resolve('steer', 0.8), 0.4);
  for (let i = 0; i < 50; i++) assert.equal(m.resolve('steer', 0.8), 0.4);
});

test('arbitration is per axis', () => {
  const m = mix();
  m.setTouch('steer', 0.5);
  assert.equal(m.resolve('steer', 0.05), 0.5, 'an idle pad axis leaves touch in control');
  assert.equal(m.resolve('throttle', 0.9), 0.9, 'a touched steer must not take throttle');
});

test('when both engage on one axis, the later engagement wins', () => {
  const m = mix();
  m.setTouch('steer', 0.5);                       // touch engages first
  assert.equal(m.resolve('steer', 0.9), 0.9, 'a pad engaging after touch takes the axis');
});

test('releaseAll drops every touch axis', () => {
  const m = mix();
  m.setTouch('steer', 0.5);
  m.setTouch('throttle', 0.5);
  m.releaseAll();
  assert.equal(m.anyEngaged(), false);
  assert.equal(m.resolve('steer', 0.9), 0.9);
});

test('releasing twice is harmless', () => {
  const m = mix();
  m.setTouch('steer', 0.5);
  m.releaseTouch('steer');
  m.releaseTouch('steer');
  assert.equal(m.engaged('steer'), false);
});

test('anyEngaged reports touch only — it is what keeps the loop alive without a pad', () => {
  const m = mix();
  assert.equal(m.anyEngaged(), false);
  m.setTouch('throttle', 0.3);
  assert.equal(m.anyEngaged(), true);
  m.releaseTouch('throttle');
  assert.equal(m.anyEngaged(), false);
});
