import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollisionGuard } from '../src/collision.js';
import { addLogSink } from '../src/debug-log.js';

globalThis.document = globalThis.document ?? { getElementById: () => null };

function fakeProtocol() {
  const calls = [];
  const target = new EventTarget();
  target.lightWrites = 0;
  target.accelDelta = null;
  target.setLights = async (...a) => {
    target.lightWrites++;
    calls.push(['setLights', ...a]);
  };
  target.emergencyStop = async () => { calls.push(['emergencyStop']); };
  target.subscribeToAccel = async (d) => {
    target.accelDelta = d;
    calls.push(['subscribeToAccel', d]);
  };
  target.unsubscribeAccel = async () => { calls.push(['unsubscribeAccel']); };
  target.calls = calls;
  target.feed = (x, y, z) => target.dispatchEvent(new CustomEvent('accel', { detail: { x, y, z } }));
  target.emitAccel = (vector) => target.dispatchEvent(new CustomEvent('accel', { detail: vector }));
  return target;
}
const settle = () => new Promise((r) => setTimeout(r, 5));

test('a disarmed guard ignores even a violent reading', async () => {
  const p = fakeProtocol();
  createCollisionGuard(p);
  p.feed(0, 0, 1000);
  p.feed(9000, 0, 1000);
  await settle();
  assert.equal(p.calls.filter(([n]) => n === 'emergencyStop').length, 0);
});

test('ordinary driving does not trip the guard', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  await g.arm();
  p.feed(0, 0, 1000);
  p.feed(300, 150, 950); // hard cornering
  await settle();
  assert.equal(p.calls.filter(([n]) => n === 'emergencyStop').length, 0);
});

test('the impact is announced before the lamps flash', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  await g.arm();

  let callCountAtImpact = -1;
  g.addEventListener('impact', (e) => {
    callCountAtImpact = p.calls.filter(([n]) => n === 'setLights').length;
  });

  p.feed(0, 0, 1000);
  p.feed(3000, 0, 1000);
  await settle();
  const names = p.calls.map(([n]) => n);
  assert.equal(callCountAtImpact, 0, 'no lamps have flashed when impact is announced');
  assert.ok(names.includes('setLights'), 'the lights must be driven after the event');
});

test('a hit flashes every lamp', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  g.params.flashMs = 1;
  await g.arm();
  p.feed(0, 0, 1000);
  p.feed(3000, 0, 1000);
  await new Promise((r) => setTimeout(r, 60));
  const lights = p.calls.filter(([n]) => n === 'setLights');
  assert.ok(lights.length >= 2, 'lamps must actually flash');
  assert.ok(lights.every(([, mask]) => mask === 0x3f), 'all six lamps, every time');
  assert.ok(lights.some(([, , b]) => b === 100) && lights.some(([, , b]) => b === 0),
    'a flash is on then off');
});

test('the rebound of one crash does not count as a second crash', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  await g.arm();

  const events = [];
  g.addEventListener('impact', (e) => events.push(e.detail));

  p.feed(0, 0, 1000);
  p.feed(3000, 0, 1000);   // hit
  p.feed(-3000, 0, 1000);  // bounce back, immediately after
  await settle();
  assert.equal(events.length, 1, 'only one impact event for the crash and its rebound');
});

test('arming subscribes with a threshold the hub can filter on', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  await g.arm();
  const [, delta] = p.calls.find(([n]) => n === 'subscribeToAccel');
  assert.ok(delta > 0 && delta < g.params.thresholdMg,
    'the hub-side delta must be below the trigger, or real hits are filtered out');
});

test('disarming stops the stream', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  await g.arm();
  await g.disarm();
  assert.ok(p.calls.some(([n]) => n === 'unsubscribeAccel'));
  assert.equal(g.armed, false);
});

test('an impact dispatches the impact event with its magnitude', async () => {
  const protocol = new EventTarget();
  protocol.setLights = async () => {};
  protocol.subscribeToAccel = async () => {};
  protocol.unsubscribeAccel = async () => {};
  const guard = createCollisionGuard(protocol);
  await guard.arm();

  const seen = [];
  guard.addEventListener('impact', (e) => seen.push(e.detail));

  const accel = (x, y, z) => protocol.dispatchEvent(
    new CustomEvent('accel', { detail: { x, y, z } }));
  accel(0, 0, 0);
  accel(3000, 0, 0);

  assert.equal(seen.length, 1);
  assert.ok(seen[0].magnitude >= guard.params.thresholdMg);
});

test('a \'stop\'-mode hit asks for a motion-only cut, not a full abort', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  await g.arm();
  g.setMode('stop');

  const cuts = [];
  const impacts = [];
  g.addEventListener('cut', (e) => cuts.push(e.detail?.mode));
  g.addEventListener('impact', (e) => impacts.push(e.detail.mode));

  p.feed(0, 0, 1000);
  p.feed(3000, 0, 1000);
  await settle();

  assert.deepEqual(cuts, ['stop'],
    'the app cannot spare the run unless the cut says which mode fired');
  assert.deepEqual(impacts, ['stop'],
    'the impact still has to reach a macro waiting on it');
});

test('an \'abort\'-mode hit asks for the full stop', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  await g.arm();      // 'abort' is the default

  const cuts = [];
  g.addEventListener('cut', (e) => cuts.push(e.detail?.mode));
  p.feed(0, 0, 1000);
  p.feed(3000, 0, 1000);
  await settle();

  assert.deepEqual(cuts, ['abort'], 'an impact with no macro running still cuts the motors');
});

test('\'notify\' announces the hit and cuts nothing', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  await g.arm();
  g.setMode('notify');

  const cuts = [];
  const impacts = [];
  g.addEventListener('cut', () => cuts.push('cut'));
  g.addEventListener('impact', (e) => impacts.push(e.detail.mode));
  p.feed(0, 0, 1000);
  p.feed(3000, 0, 1000);
  await settle();

  assert.deepEqual(cuts, [], 'notify is the mode that leaves the car driving');
  assert.deepEqual(impacts, ['notify']);
});

test('lowering the threshold re-subscribes the hub at a delta that can still see the hit', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  await g.arm();
  p.calls.length = 0;

  await g.setThreshold(300);

  assert.equal(g.params.thresholdMg, 300);
  const sub = p.calls.find(([n]) => n === 'subscribeToAccel');
  assert.ok(sub, 'a software-only change is invisible: the hub filters below its own delta');
  assert.ok(sub[1] > 0 && sub[1] < 300,
    'the new hub-side delta must sit below the new trigger, or the hit never arrives');
});

test('a threshold change on a disarmed guard never touches the link', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  await g.setThreshold(300);
  assert.equal(g.params.thresholdMg, 300);
  assert.equal(p.calls.some(([n]) => n === 'subscribeToAccel'), false,
    'nothing is streaming yet, so there is nothing to re-subscribe');
});

test('the guard does not stop the motors itself', async () => {
  const protocol = new EventTarget();
  protocol.setLights = async () => {};
  protocol.subscribeToAccel = async () => {};
  protocol.unsubscribeAccel = async () => {};
  let stops = 0;
  protocol.emergencyStop = async () => { stops++; };
  const guard = createCollisionGuard(protocol);
  await guard.arm();

  protocol.dispatchEvent(new CustomEvent('accel', { detail: { x: 0, y: 0, z: 0 } }));
  protocol.dispatchEvent(new CustomEvent('accel', { detail: { x: 3000, y: 0, z: 0 } }));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(stops, 0, 'stopping is the app\'s decision, not the guard\'s');
});

test('the options in the signature are honoured, not ignored', async () => {
  const protocol = fakeProtocol();
  const guard = createCollisionGuard(protocol, { thresholdMg: 400, cooldownMs: 10 });
  await guard.arm();
  assert.equal(guard.params.thresholdMg, 400);
  assert.equal(protocol.accelDelta, 200, 'the subscription delta follows the threshold');
});

test('flashes: 0 writes nothing to the lamps', async () => {
  const protocol = fakeProtocol();
  const guard = createCollisionGuard(protocol, { flashes: 0 });
  await guard.arm();
  const hits = [];
  guard.addEventListener('impact', (e) => hits.push(e.detail.magnitude));
  protocol.emitAccel({ x: 0, y: 0, z: 0 });
  protocol.emitAccel({ x: 4000, y: 0, z: 0 });
  assert.equal(hits.length, 1, 'the impact is still announced');
  assert.equal(protocol.lightWrites, 0, 'but no lamp write goes out with the stop');
});

// The delta floor is not a duplicate of the session's threshold floor: the macro
// API reaches setThreshold unvalidated (src/macro/host.js:438-450), and a delta
// of 0 drops the GATT link.
// See docs/DESIGN-NOTES.md § The filtering happens in the hub, not here
test('a threshold of zero still subscribes at a delta of one, never zero', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  await g.arm();
  await g.setThreshold(0);
  assert.equal(p.accelDelta, 1,
    'delta 0 is the one value that must never reach the wire — it drops the link');
});

test('an odd threshold rounds its delta rather than flooring it away', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p);
  await g.arm();
  await g.setThreshold(3);
  assert.equal(p.accelDelta, 2, 'half of 3 is 1.5, and the delta tracks the threshold');
});

// The cooldown exists so one crash does not retrigger on its own rebound. A hit
// the guard was told to ignore is not that crash.
test('a hit taken while off does not start a cooldown against the next real one', async () => {
  const p = fakeProtocol();
  const g = createCollisionGuard(p, { flashes: 0 });
  await g.arm();
  const seen = [];
  g.addEventListener('impact', (e) => seen.push(e.detail.magnitude));

  g.setMode('off');
  p.feed(0, 0, 0);
  p.feed(3000, 0, 0);
  await settle();
  assert.deepEqual(seen, [], 'off records nothing, which is the point of off');

  g.setMode('notify');
  p.feed(0, 0, 0);
  await settle();
  assert.deepEqual(seen, [3000],
    'switching back must not be deaf for 1500 ms because of a hit nobody was told about');
});

// off records nothing and acts on nothing, so the log line is the only evidence
// the mode leaves behind. An operator running a gate with the guard off would
// otherwise have no trace of a hit at all.
test('a hit taken while off is still written to the log, because nothing else records it', async () => {
  const lines = [];
  const removeSink = addLogSink((line) => lines.push(line));
  try {
    const p = fakeProtocol();
    const g = createCollisionGuard(p, { flashes: 0 });
    await g.arm();
    g.setMode('off');
    p.feed(0, 0, 0);
    p.feed(3000, 0, 0);
    await settle();
    const hits = lines.filter((l) => l.includes('COLLISION'));
    assert.equal(hits.length, 1, 'the one trace off leaves behind');
    assert.match(hits[0], /3000mG/, 'and it carries the magnitude, like every other impact line');
    assert.match(hits[0], /off/, 'labelled, so it is not read as an impact that was acted on');
  } finally {
    removeSink();
  }
});
