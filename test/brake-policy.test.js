import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrakePolicy } from '../src/brake-policy.js';

// Deterministic clock: timers fire only when advance() reaches their deadline,
// and now() reports the deadline while a timer runs.
function fakeClock() {
  let t = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { timers.set(++seq, { fn, at: t + ms }); return seq; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, x]) => x.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = target;
    },
  };
}

// Drains the whole microtask queue, so a resolution one tick away is still
// visible as "already settled" and only a real pending write reads as pending.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options = {}) {
  const clock = fakeClock();
  const calls = [];
  const policy = createBrakePolicy({ ...clock, ...options });
  const actions = {
    coast: () => calls.push('coast'),
    brake: () => calls.push('brake'),
  };
  return { clock, calls, policy, stop: (keys) => policy.requestBrake(keys, actions) };
}

test('above the threshold the brake is staged: coast now, brake after the window', () => {
  const { clock, calls, policy, stop } = setup();
  policy.noteSpeed('A', 80);
  stop('A');
  assert.deepEqual(calls, ['coast']);
  clock.advance(399);
  assert.deepEqual(calls, ['coast'], 'the brake must not land early');
  clock.advance(1);
  assert.deepEqual(calls, ['coast', 'brake']);
});

test('below the threshold the brake lands directly, with no coast', () => {
  const { calls, policy, stop } = setup();
  policy.noteSpeed('A', 5);
  stop('A');
  assert.deepEqual(calls, ['brake']);
});

test('a duplicate stop does not collapse the coast window', () => {
  const { clock, calls, policy, stop } = setup();
  policy.noteSpeed('A', 80);
  stop('A');
  clock.advance(300);
  stop('A');
  assert.deepEqual(calls, ['coast'], 'the second stop must be dropped, not re-staged');
  clock.advance(100);
  assert.deepEqual(calls, ['coast', 'brake'], 'the brake lands 400ms after the FIRST stop');
});

test('a new drive command cancels a pending stage', () => {
  const { clock, calls, policy, stop } = setup();
  policy.noteSpeed('A', 80);
  stop('A');
  clock.advance(100);
  policy.noteSpeed('A', 60);
  clock.advance(5000);
  assert.deepEqual(calls, ['coast'], 'driving again must not be interrupted by a stale brake');
});

test('a zero command leaves the pending brake armed (zero is itself a coast)', () => {
  const { clock, calls, policy, stop } = setup();
  policy.noteSpeed('A', 80);
  stop('A');
  policy.noteSpeed('A', 0);
  clock.advance(400);
  assert.deepEqual(calls, ['coast', 'brake']);
});

test('the peak expires: an old high speed no longer forces staging', () => {
  const { clock, calls, policy, stop } = setup();
  policy.noteSpeed('A', 100);
  clock.advance(100);
  policy.noteSpeed('A', 5);   // eased off, but still spinning fast
  stop('A');
  assert.deepEqual(calls, ['coast'], 'the recent peak still counts');

  const b = setup();
  b.policy.noteSpeed('A', 100);
  b.clock.advance(100);
  b.policy.noteSpeed('A', 5);
  b.clock.advance(1500);      // peak window gone, only the crawl remains
  b.stop('A');
  assert.deepEqual(b.calls, ['brake']);
});

test('a long steady throttle still stages: last speed backs the expired peak', () => {
  const { clock, calls, policy, stop } = setup();
  policy.noteSpeed('A', 100);
  clock.advance(9000);        // no new command, so the peak has aged out
  stop('A');
  assert.deepEqual(calls, ['coast'], 'direct-braking from full speed browns out the hub');
});

test('the pair and a single motor share one stage', () => {
  const { clock, calls, policy, stop } = setup();
  policy.noteSpeed(['A', 'B'], 80);
  stop(['A', 'B']);
  stop('A');
  assert.deepEqual(calls, ['coast'], 'the single-port path must see the pair stage');
  clock.advance(400);
  assert.deepEqual(calls, ['coast', 'brake']);
  policy.noteSpeed('B', 80);
  stop(['A', 'B']);
  clock.advance(100);
  policy.noteSpeed('A', 40);  // one member driving again clears the shared stage
  clock.advance(5000);
  assert.deepEqual(calls, ['coast', 'brake', 'coast']);
});

test('the pair stages when either motor is spinning fast', () => {
  const { calls, policy, stop } = setup();
  policy.noteSpeed('A', 5);
  policy.noteSpeed('B', 80);
  stop(['A', 'B']);
  assert.deepEqual(calls, ['coast']);
});

test('a staged brake can be awaited to completion', async () => {
  const { clock, calls, policy, stop } = setup();
  policy.noteSpeed('A', 80);
  stop('A');
  assert.deepEqual(calls, ['coast'], 'the staged brake coasts first');
  let done = false;
  const settled = policy.settled('A').then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false, 'the coast alone must not settle the stop');
  clock.advance(400);
  await settled;
  assert.deepEqual(calls, ['coast', 'brake'], 'awaiting it means the brake actually went out');
});

test('settled resolves immediately when nothing is staged', async () => {
  const { policy } = setup();
  await policy.settled('A');
});

test('settled waits for the brake write, not just for the callback to be invoked', async () => {
  const clock = fakeClock();
  const policy = createBrakePolicy(clock);
  let release;
  const write = new Promise((resolve) => { release = resolve; });
  policy.noteSpeed('A', 80);
  policy.requestBrake('A', { coast: () => {}, brake: () => write });
  let done = false;
  const settled = policy.settled('A').then(() => { done = true; });
  clock.advance(400);
  await flush();
  assert.equal(done, false, 'the brake frame is still in flight');
  release();
  await settled;
  assert.equal(done, true, 'the stop is settled once the frame is out');
});

test('settled rejects when the brake write rejects, so a failed stop cannot read as a landed one', async () => {
  const clock = fakeClock();
  const policy = createBrakePolicy(clock);
  const failure = new Error('the link went away');
  policy.noteSpeed('A', 80);
  policy.requestBrake('A', { coast: () => {}, brake: () => Promise.reject(failure) });
  const settled = policy.settled('A');
  clock.advance(400);
  await assert.rejects(settled, (err) => err === failure);
});

test('settled rejects when the brake action throws instead of writing', async () => {
  const clock = fakeClock();
  const policy = createBrakePolicy(clock);
  const failure = new Error('no transport');
  policy.noteSpeed('A', 80);
  policy.requestBrake('A', { coast: () => {}, brake: () => { throw failure; } });
  const settled = policy.settled('A');
  assert.throws(() => clock.advance(400), (err) => err === failure);
  await assert.rejects(settled, (err) => err === failure);
});

test('both members of a pair see the failed brake', async () => {
  const clock = fakeClock();
  const policy = createBrakePolicy(clock);
  const failure = new Error('the link went away');
  policy.noteSpeed(['A', 'B'], 80);
  policy.requestBrake(['A', 'B'], { coast: () => {}, brake: () => Promise.reject(failure) });
  const a = policy.settled('A');
  const b = policy.settled(['A', 'B']);
  clock.advance(400);
  await assert.rejects(a, (err) => err === failure);
  await assert.rejects(b, (err) => err === failure);
});

test('a brake write that fails with nobody awaiting is not left as an unhandled rejection', async () => {
  const clock = fakeClock();
  const policy = createBrakePolicy(clock);
  let braked = false;
  policy.noteSpeed('A', 80);
  policy.requestBrake('A', {
    coast: () => {},
    brake: () => { braked = true; return Promise.reject(new Error('the link went away')); },
  });
  clock.advance(400);
  await flush();
  assert.equal(braked, true, 'the brake was still attempted');
});

test('a cancelled stage does not settle the stop that replaced it', async () => {
  const { clock, calls, policy, stop } = setup();
  policy.noteSpeed('Z', 80);
  stop('Z');
  const other = policy.settled('Z');  // an unrelated key, awaited for the whole test
  policy.noteSpeed('A', 80);
  stop('A');
  policy.noteSpeed('A', 60);  // cancels A's stage, waking whoever waited on it
  stop('A');                  // a second stop, with a brake of its own still to land
  let done = false;
  const settled = policy.settled('A').then(() => { done = true; });
  await flush();
  assert.equal(done, false, 'the cancelled stage must not settle the one that replaced it');
  assert.deepEqual(calls, ['coast', 'coast', 'coast'], 'no brake has landed yet');
  clock.advance(400);
  await settled;
  await other;
  assert.deepEqual(calls, ['coast', 'coast', 'coast', 'brake', 'brake']);
});

test('settled resolves when a drive command cancels the stage, so no caller hangs', async () => {
  const { policy, stop } = setup();
  policy.noteSpeed('A', 80);
  stop('A');
  const settled = policy.settled('A').then(() => 'settled');
  policy.noteSpeed('A', 60);
  const outcome = await Promise.race([
    settled,
    new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
  ]);
  assert.equal(outcome, 'settled', 'a cancelled stage leaves nothing pending');
});

test('either member of a pair stage can be awaited', async () => {
  const { clock, calls, policy, stop } = setup();
  policy.noteSpeed(['A', 'B'], 80);
  stop(['A', 'B']);
  const settled = policy.settled('B');
  clock.advance(400);
  await settled;
  assert.deepEqual(calls, ['coast', 'brake']);
});

test('settled changes nothing about what the stage does', () => {
  const { clock, calls, policy, stop } = setup();
  policy.noteSpeed('A', 80);
  stop('A');
  policy.settled('A');
  clock.advance(399);
  assert.deepEqual(calls, ['coast'], 'awaiting must not pull the brake forward');
  clock.advance(1);
  assert.deepEqual(calls, ['coast', 'brake']);
});

test('requestBrake returns what the action returned, so callers can await it', async () => {
  const clock = fakeClock();
  const policy = createBrakePolicy(clock);
  policy.noteSpeed('A', 5);
  assert.equal(await policy.requestBrake('A', { coast: () => 'c', brake: () => 'b' }), 'b');
  policy.noteSpeed('A', 80);
  assert.equal(await policy.requestBrake('A', { coast: () => 'c', brake: () => 'b' }), 'c');
  assert.equal(await policy.requestBrake('A', { coast: () => 'c', brake: () => 'b' }), undefined);
});
