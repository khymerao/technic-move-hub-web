import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLinkPacer, LINK_FLOOR_MS } from '../src/macro/link-pacer.js';

function fakeClock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    now: () => now,
    schedule: (fn, ms) => { timers.set(++id, { at: now + ms, fn }); return id; },
    cancel: (t) => { timers.delete(t); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await Promise.resolve();
      }
      now = target;
      await Promise.resolve();
    },
  };
}

test('the first call goes straight through', async () => {
  const c = fakeClock();
  const p = createLinkPacer({ ...c, floorMs: 60 });
  assert.equal(await p.pace(() => 'now'), 'now');
});

test('a second call inside the floor waits for it', async () => {
  const c = fakeClock();
  const p = createLinkPacer({ ...c, floorMs: 60 });
  const ran = [];
  await p.pace(() => ran.push('a'));
  p.pace(() => ran.push('b'));
  await c.advance(30);
  assert.deepEqual(ran, ['a'], 'still inside the floor');
  await c.advance(30);
  assert.deepEqual(ran, ['a', 'b']);
});

test('calls run in the order they were made', async () => {
  const c = fakeClock();
  const p = createLinkPacer({ ...c, floorMs: 60 });
  const ran = [];
  await p.pace(() => ran.push(1));
  p.pace(() => ran.push(2));
  p.pace(() => ran.push(3));
  p.pace(() => ran.push(4));
  await c.advance(300);
  assert.deepEqual(ran, [1, 2, 3, 4]);
});

test('the floor is per link: three ports do not get three floors', async () => {
  const c = fakeClock();
  const p = createLinkPacer({ ...c, floorMs: 60 });
  const ran = [];
  await p.pace(() => ran.push(0x32));
  p.pace(() => ran.push(0x33));
  p.pace(() => ran.push(0x34));
  await c.advance(60);
  assert.equal(ran.length, 2, 'one write per 60ms on the link, not per port');
});

test('a throwing call rejects its own promise and does not stall the queue', async () => {
  const c = fakeClock();
  const p = createLinkPacer({ ...c, floorMs: 60 });
  await p.pace(() => {});
  const bad = p.pace(() => { throw new Error('boom'); });
  const ran = [];
  p.pace(() => ran.push('after'));
  await c.advance(200);
  await assert.rejects(bad, /boom/);
  assert.deepEqual(ran, ['after']);
});

test('clear drops everything still waiting', async () => {
  const c = fakeClock();
  const p = createLinkPacer({ ...c, floorMs: 60 });
  const ran = [];
  await p.pace(() => {});
  p.pace(() => ran.push('never')).catch(() => {});
  p.clear();
  await c.advance(500);
  assert.deepEqual(ran, []);
  assert.equal(p.waiting, 0);
});

test('the floor matches the measured safe interval', () => {
  assert.equal(LINK_FLOOR_MS, 60);
});

test('the queue is capped, so a forged flood cannot grow it without bound', async () => {
  const c = fakeClock();
  const p = createLinkPacer({ ...c, floorMs: 60, maxQueue: 4 });
  const ran = [];
  await p.pace(() => ran.push('first'));   // goes straight through, not queued

  const refused = [];
  for (let i = 0; i < 20; i++) {
    p.pace(() => ran.push(i)).catch((err) => refused.push(err.message));
  }
  await Promise.resolve();

  assert.equal(p.waiting, 4, 'the queue stops at its cap');
  assert.equal(refused.length, 16, 'everything past the cap is refused, not buffered');
  assert.match(refused[0], /too many/i);

  await c.advance(600);
  assert.deepEqual(ran, ['first', 0, 1, 2, 3], 'the calls that were accepted still go out in order');
});

test('the cap is generous enough that ordinary paced writes never hit it', async () => {
  const c = fakeClock();
  const p = createLinkPacer({ ...c, floorMs: 60 });
  const ran = [];
  await p.pace(() => {});
  for (let i = 0; i < 16; i++) p.pace(() => ran.push(i));
  await c.advance(60 * 20);
  assert.equal(ran.length, 16, 'a macro that queues a handful of writes is never refused');
});
