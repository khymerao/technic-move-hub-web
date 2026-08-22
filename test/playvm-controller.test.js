import { test } from 'node:test';
import assert from 'node:assert/strict';
// The controller logs through the debug panel, which reaches for the DOM.
globalThis.document = globalThis.document ?? { getElementById: () => null };

import { createRateLimitedSender, PlayVmController } from '../src/playvm-controller.js';

// Controllable clock and timer, so the rate limiter can be tested without
// waiting on real milliseconds.
function harness() {
  let t = 0;
  const timers = new Map();
  let nextId = 1;
  const sent = [];
  const api = {
    now: () => t,
    schedule: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
    cancel: (id) => { timers.delete(id); },
    advance(ms) {
      t += ms;
      // Loop: a timer callback may schedule the next one, and a single pass
      // would fire it never — which is exactly how a heartbeat works.
      for (let guard = 0; guard < 10000; guard++) {
        const due = [...timers].filter(([, v]) => v.at <= t);
        if (!due.length) return;
        for (const [id, { fn }] of due) { timers.delete(id); fn(); }
      }
      throw new Error('timer loop did not settle');
    },
    sent,
    pendingTimers: () => timers.size,
    // Real time passes continuously; a single jump lets a self-rescheduling
    // timer fire only once, which understates a heartbeat badly.
    advanceSteadily(total, step = 25) {
      for (let elapsed = 0; elapsed < total; elapsed += step) api.advance(step);
    },
  };
  return api;
}

test('rate limiter: first value goes out immediately', () => {
  const h = harness();
  const s = createRateLimitedSender((v) => h.sent.push(v), { intervalMs: 60, ...h });
  s.push('a');
  assert.deepEqual(h.sent, ['a']);
});

test('rate limiter: a burst collapses to one send per interval, latest wins', () => {
  const h = harness();
  const s = createRateLimitedSender((v) => h.sent.push(v), { intervalMs: 60, ...h });
  s.push('a');
  h.advance(5); s.push('b');
  h.advance(5); s.push('c');
  h.advance(5); s.push('d');
  assert.deepEqual(h.sent, ['a'], 'nothing else may go out inside the interval');
  h.advance(60);
  assert.deepEqual(h.sent, ['a', 'd'], 'the newest value is the one that survives');
});

test('rate limiter: the last value of a burst is never dropped', () => {
  // The dangerous failure: that value is usually the stop.
  const h = harness();
  const s = createRateLimitedSender((v) => h.sent.push(v), { intervalMs: 60, ...h });
  s.push('go');
  h.advance(1);
  s.push('stop');
  h.advance(200);
  assert.deepEqual(h.sent, ['go', 'stop']);
  assert.equal(h.pendingTimers(), 0, 'no timer may be left armed');
});

test('rate limiter: spaced-out values are not delayed', () => {
  const h = harness();
  const s = createRateLimitedSender((v) => h.sent.push(v), { intervalMs: 60, ...h });
  s.push('a');
  h.advance(100); s.push('b');
  h.advance(100); s.push('c');
  assert.deepEqual(h.sent, ['a', 'b', 'c']);
});

test('rate limiter: flushNow bypasses the floor', () => {
  const h = harness();
  const s = createRateLimitedSender((v) => h.sent.push(v), { intervalMs: 60, ...h });
  s.push('a');
  h.advance(1); s.push('b');
  s.flushNow();
  assert.deepEqual(h.sent, ['a', 'b']);
});

function fakeProtocol() {
  const writes = [];
  return { writes, sendRaw: (bytes, key) => { writes.push({ bytes: [...bytes], key }); } };
}

test('controller: writes nothing until armed', () => {
  const h = harness();
  const p = fakeProtocol();
  const c = new PlayVmController(p, { intervalMs: 60, ...h });
  c.set(50, 20);
  assert.equal(p.writes.length, 0, 'an unarmed port discards frames anyway');
});

const armed = async (p, h) => {
  const c = new PlayVmController(p, { intervalMs: 60, init: async () => ({ ok: true }), ...h });
  await c.arm();
  p.writes.length = 0;
  return c;
};

test('controller: an unchanged frame is not re-sent', async () => {
  const h = harness();
  const p = fakeProtocol();
  const c = await armed(p, h);
  c.set(50, 20);
  h.advance(200);
  c.set(50, 20);
  h.advance(200);
  assert.equal(p.writes.length, 1, 'a repeat carries no information and costs a write');
});

test('controller: speed and steer reach the frame, clamped', async () => {
  const h = harness();
  const p = fakeProtocol();
  const c = await armed(p, h);
  c.set(250, -250);
  const b = p.writes[0].bytes;
  assert.equal(b[9], 100, 'speed clamped to +100');
  assert.equal(b[10], 156, 'steer clamped to -100');
});

test('controller: a stick burst cannot outrun the interval', async () => {
  // 7 ms bursts of writes are the load that has knocked this hub off the air.
  const h = harness();
  const p = fakeProtocol();
  const c = await armed(p, h);
  for (let i = 1; i <= 30; i++) { c.set(i, 0); h.advance(5); }
  assert.ok(p.writes.length <= 4, `expected at most 4 writes in 150ms, got ${p.writes.length}`);
});

test('controller: disarm stops the car and blocks further frames', async () => {
  const h = harness();
  const p = fakeProtocol();
  const c = await armed(p, h);
  c.set(60, 30);
  p.writes.length = 0;
  c.disarm();
  assert.equal(p.writes.length, 1, 'disarm must command a stop');
  assert.equal(p.writes[0].bytes[9], 0);
  c.set(80, 0);
  h.advance(500);
  assert.equal(p.writes.length, 1, 'nothing may be sent once disarmed');
});

test('controller: an unarmed stop writes nothing to the port', () => {
  // stop() is called from the shared stop path, which runs in every drive mode.
  // Writing a combined frame to a port nobody initialised broke the ordinary
  // per-motor steering.
  const h = harness();
  const p = fakeProtocol();
  const c = new PlayVmController(p, { intervalMs: 60, ...h });
  c.stop();
  assert.equal(p.writes.length, 0, 'an unarmed controller must stay off the port');
});

test('controller: stop sends immediately and cancels a pending frame', async () => {
  const h = harness();
  const p = fakeProtocol();
  const c = await armed(p, h);
  c.stop();
  assert.equal(p.writes.length, 1, 'stop must not be rate limited');
  const bytes = p.writes[0].bytes;
  assert.equal(bytes[9], 0, 'speed zero');
  assert.equal(bytes[10], 0, 'steer zero');
  assert.equal(p.writes[0].key, 'playvm', 'keyed so the queue coalesces it');
});

test('controller: a command is refreshed so the hub does not time out', async () => {
  // Confirmed on hardware: the traction motors behaved like the stock app but
  // died after about two seconds of a steadily held trigger. A steady command is
  // one frame followed by silence, and the hub stops when it is not refreshed.
  const h = harness();
  const p = fakeProtocol();
  const c = new PlayVmController(p, {
    intervalMs: 60, heartbeatMs: 500, commandTtlMs: 1000,
    init: async () => ({ ok: true }), ...h,
  });
  await c.arm();
  p.writes.length = 0;

  c.set(60, 0);
  // Inside the command's lifetime the frame is repeated without being asked.
  h.advanceSteadily(900);
  assert.ok(p.writes.length >= 2,
    `the frame must be refreshed while the command is live, got ${p.writes.length}`);
  assert.ok(p.writes.every((w) => w.bytes[9] === 60),
    'every refresh must carry the held speed, not a stale or zero one');
});

test('controller: a resting command is not refreshed', async () => {
  // At rest the hub is already stopped, so a heartbeat would be pure traffic.
  const h = harness();
  const p = fakeProtocol();
  const c = new PlayVmController(p, {
    intervalMs: 60, heartbeatMs: 500, init: async () => ({ ok: true }), ...h,
  });
  await c.arm();
  c.set(60, 0);
  h.advanceSteadily(1200);
  c.set(0, 0);
  h.advanceSteadily(200);   // let the rate limiter flush the stop
  p.writes.length = 0;
  h.advanceSteadily(5000);
  assert.equal(p.writes.length, 0, 'a stopped car must not be kept awake');
});

test('controller: a held frame is released when the input loop goes quiet', async () => {
  // The failure this exists for: a motor stuck at full throttle, driving with
  // nobody asking it to. The hub's own watchdog used to be the failsafe —
  // stop feeding it and the car stopped — and the heartbeat overrides that, so
  // it must not outlive the input that asked for it.
  const h = harness();
  const p = fakeProtocol();
  const c = new PlayVmController(p, {
    intervalMs: 60, heartbeatMs: 500, commandTtlMs: 1000,
    init: async () => ({ ok: true }), ...h,
  });
  await c.arm();
  c.set(100, 0);
  h.advanceSteadily(600);
  p.writes.length = 0;

  // Input stops here — nothing calls set() again.
  h.advanceSteadily(4000);
  const last = p.writes[p.writes.length - 1];
  assert.ok(last, 'the controller must send something when the input dies');
  assert.equal(last.bytes[9], 0, 'the car must end up commanded to zero');
  assert.ok(p.writes.length <= 4,
    `expected the refresh to stop, got ${p.writes.length} writes after input died`);
});

test('controller: continuous input keeps the frame alive indefinitely', async () => {
  const h = harness();
  const p = fakeProtocol();
  const c = new PlayVmController(p, {
    intervalMs: 60, heartbeatMs: 500, commandTtlMs: 1000,
    init: async () => ({ ok: true }), ...h,
  });
  await c.arm();
  p.writes.length = 0;
  // A driver holding the trigger: the loop keeps re-asserting the same value.
  for (let i = 0; i < 200; i++) { c.set(60, 0); h.advanceSteadily(25, 25); }
  assert.ok(p.writes.every((w) => w.bytes[9] === 60),
    'a continuously held throttle must never be released');
  assert.ok(p.writes.length >= 8, `expected sustained refreshes, got ${p.writes.length}`);
});

test('controller: a resting stick offset does not keep the link busy', async () => {
  // A steer value of -2 from a stick at rest counted as movement, so the
  // heartbeat refreshed it every 500ms forever and the link never went quiet.
  const h = harness();
  const p = fakeProtocol();
  const c = new PlayVmController(p, {
    intervalMs: 60, heartbeatMs: 500, commandTtlMs: 1000,
    init: async () => ({ ok: true }), ...h,
  });
  await c.arm();
  c.set(0, -2);
  h.advanceSteadily(300);
  p.writes.length = 0;
  h.advanceSteadily(4000);
  assert.equal(p.writes.length, 0, 'a car at rest must not be kept awake by stick noise');
});
