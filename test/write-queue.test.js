import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandQueue } from '../src/write-queue.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('runs writes strictly one at a time (no overlap)', async () => {
  let active = 0, maxActive = 0;
  const q = createCommandQueue(async () => {
    active++; maxActive = Math.max(maxActive, active);
    await tick(5);
    active--;
  });
  q.send([1]); q.send([2]); q.send([3]);
  await q.idle();
  assert.equal(maxActive, 1);
});

test('keyed sends coalesce: only the latest value per key survives', async () => {
  const seen = [];
  const q = createCommandQueue(async (b) => { seen.push(b[0]); await tick(10); });
  q.send([1], 'motor');       // starts immediately
  q.send([2], 'motor');       // queued
  q.send([3], 'motor');       // replaces 2
  q.send([4], 'motor');       // replaces 3
  await q.idle();
  assert.deepEqual(seen, [1, 4], 'stale intermediate values must be dropped');
});

test('different keys are all delivered', async () => {
  const seen = [];
  const q = createCommandQueue(async (b) => { seen.push(b[0]); await tick(2); });
  q.send([1], 'a'); q.send([2], 'b'); q.send([3], 'c');
  await q.idle();
  assert.deepEqual(seen.sort(), [1, 2, 3]);
});

test('unkeyed sends are never dropped (sequences stay intact)', async () => {
  const seen = [];
  const q = createCommandQueue(async (b) => { seen.push(b[0]); await tick(2); });
  for (let i = 1; i <= 5; i++) q.send([i]);
  await q.idle();
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test('a failing write does not stall the queue', async () => {
  const seen = [];
  const q = createCommandQueue(async (b) => {
    if (b[0] === 1) throw new Error('boom');
    seen.push(b[0]);
  });
  q.send([1]); q.send([2]);
  await q.idle();
  assert.deepEqual(seen, [2]);
});

test('idle() resolves when nothing is pending', async () => {
  const q = createCommandQueue(async () => { await tick(2); });
  await q.idle();
  q.send([1]);
  await q.idle();
  assert.ok(true);
});
