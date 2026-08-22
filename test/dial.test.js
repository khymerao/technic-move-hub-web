import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arcPoint, arcPath } from '../src/ui/dial.js';

const onCircle = (p) => Math.round(Math.hypot(p.x - 50, p.y - 50) * 10) / 10;

test('every arc point sits on the shipped circle', () => {
  for (const v of [-100, -62, 0, 18, 100]) assert.equal(onCircle(arcPoint(v)), 44);
});

test('zero is the top of the dial', () => {
  const p = arcPoint(0);
  assert.equal(Math.round(p.x), 50);
  assert.equal(Math.round(p.y), 6);
});

test('full deflection reaches the track ends', () => {
  assert.deepEqual([Math.round(arcPoint(100).x), Math.round(arcPoint(100).y)], [94, 50]);
  assert.deepEqual([Math.round(arcPoint(-100).x), Math.round(arcPoint(-100).y)], [6, 50]);
});

test('arcPath sweeps the short way in both directions', () => {
  assert.match(arcPath(0, 40), /^M50 6 A44 44 0 0 1 /);
  assert.match(arcPath(0, -40), /^M50 6 A44 44 0 0 0 /);
});
