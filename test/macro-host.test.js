import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createMacroHost, QUEUE_DEPTH_LIMIT, QUEUE_DEPTH_STRIKES, PRINT_PER_SECOND,
} from '../src/macro/host.js';
import { addLogSink } from '../src/debug-log.js';

// The panel says one thing when the dropdown arms the frame and the host must
// say the same thing when a macro does; src/ui/gamepad.js owns the wording.
// Read rather than imported: that module reaches for the DOM at import time.
const SWEEP_NOTICE = (() => {
  const src = readFileSync(new URL('../src/ui/gamepad.js', import.meta.url), 'utf8');
  const match = src.match(/'(arming combined frame[^']*)'/);
  assert.ok(match, 'src/ui/gamepad.js no longer carries the arming notice');
  return match[1];
})();

// A worker that never runs code: the test plays the part of the program by
// posting calls itself. That is also how a forged message is simulated.
function fakeWorker() {
  const w = {
    posted: [],
    terminated: false,
    postMessage(msg) { w.posted.push(msg); },
    terminate() { w.terminated = true; },
    onmessage: null,
    // the program speaking to the host
    emit(msg) { w.onmessage?.({ data: msg }); },
  };
  return w;
}

function fakeHub() {
  const calls = [];
  const hub = {
    calls,
    playvm: {
      armed: true,
      set: (s, st) => calls.push(['playvm.set', s, st]),
      stop: () => calls.push(['playvm.stop']),
    },
    steering: { stop: () => calls.push(['steering.stop']) },
    gamepad: {
      calls: [],
      // Resolves normally even when arming failed — that is what the real
      // setDriveMode does. Tests set `armAs` to choose the outcome.
      armAs: true,
      async setDriveMode(name) {
        this.calls.push(name);
        if (name === 'playvm') hub.playvm.armed = this.armAs;
        else hub.playvm.armed = false;
      },
    },
    protocol: {
      roles: { driveA: 0x32, driveB: 0x33, steer: 0x34 },
      streams: { modeOf: () => null },
      releaseStreams: async (holder) => calls.push(['releaseStreams', holder]),
      setMotorSpeedRaw: async (p, s) => calls.push(['motorRaw', p, s]),
      brakeDrive: async () => calls.push(['brakeDrive']),
      brakeMotor: async (p) => calls.push(['brakeMotor', p]),
    },
  };
  return hub;
}

// A promise the test resolves by hand, for asserting what a continuation does
// when it resumes after the run it belonged to has already ended.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function makeHost(hub = fakeHub(), { schedule, cancel, onPrint, onState } = {}) {
  const worker = fakeWorker();
  const host = createMacroHost(hub, {
    spawnWorker: () => worker,
    onState: onState ?? (() => {}),
    onPrint: onPrint ?? (() => {}),
    ...(schedule && { schedule }),
    ...(cancel && { cancel }),
  });
  return { host, worker, hub };
}

const replyTo = (worker, id) => worker.posted.find((m) => m.kind === 'reply' && m.id === id);

// A scheduler a test can drive by hand: fn(ms) callbacks are captured, not
// timed, and fireAll() runs whatever is currently outstanding.
function fakeScheduler() {
  let id = 0;
  const timers = new Map();
  return {
    schedule: (fn) => { const t = ++id; timers.set(t, fn); return t; },
    cancel: (t) => { timers.delete(t); },
    fireAll() {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
    },
  };
}

test('a plain call is dispatched and replied to', async () => {
  const { host, worker, hub } = makeHost();
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).ok, true);
  assert.deepEqual(hub.calls[0], ['playvm.set', 40, 0]);
  host.abort('test'); // release the hold `drive` armed, so nothing keeps ticking
});

test('an unsafe call is refused when the macro has not opted in', async () => {
  const { host, worker } = makeHost();
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'unsafe.linkDriveMotors', args: [] });
  await new Promise((r) => setTimeout(r, 0));
  const reply = replyTo(worker, 1);
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /unsafe/i);
});

test('the unsafe check survives a forged message that skips the proxies', async () => {
  const { host, worker } = makeHost();
  host.run('', { allowUnsafe: false });
  // Exactly what user code can do with a bare self.postMessage.
  worker.emit({ kind: 'call', id: 9, method: 'unsafe.raw', args: [[0x05, 0x00]] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 9).ok, false);
});

test('an unknown method is refused', async () => {
  const { host, worker } = makeHost();
  host.run('', { allowUnsafe: true });
  worker.emit({ kind: 'call', id: 1, method: 'selfDestruct', args: [] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).ok, false);
});

test('an inherited Object.prototype name is not a method', async () => {
  const { host, worker } = makeHost();
  host.run('', { allowUnsafe: true });
  for (const [i, method] of ['constructor', 'toString', 'hasOwnProperty'].entries()) {
    worker.emit({ kind: 'call', id: i, method, args: [] });
  }
  await new Promise((r) => setTimeout(r, 0));
  for (const i of [0, 1, 2]) {
    const reply = replyTo(worker, i);
    assert.equal(reply.ok, false);
    assert.match(reply.error.message, /no such macro method/,
      'dying later on "entry.run is not a function" tells the author nothing');
  }
});

test('mixing the two drive families in one run is refused', async () => {
  const { host, worker } = makeHost();
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 0));
  worker.emit({ kind: 'call', id: 2, method: 'motorFor', args: [0x32, 50, 500] });
  await new Promise((r) => setTimeout(r, 0));
  const reply = replyTo(worker, 2);
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /one drive path/i);
  host.abort('test'); // release the hold the first, successful `drive` call armed
});

test('a raw motor call is refused while the combined frame is armed', async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'motorFor', args: [0x32, 50, 500] });
  await new Promise((r) => setTimeout(r, 0));
  const reply = replyTo(worker, 1);
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /combined frame|drive mode/i);
});

test('a playvm call is refused when the port was never armed', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 0));
  const reply = replyTo(worker, 1);
  assert.equal(reply.ok, false, 'a silent no-op is worse than an error');
});

test('an unknown lights mode is refused, not passed through', async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  hub.playvm.setLights = (v) => hub.calls.push(['setLights', v]);
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'lights', args: ['disco'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).ok, false);
  assert.equal(hub.calls.some((c) => c[0] === 'setLights'), false);
});

test('a known lights mode reaches the controller as its numeric code', async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  hub.playvm.setLights = (v) => hub.calls.push(['setLights', v]);
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'lights', args: ['off'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).ok, true);
  assert.deepEqual(hub.calls.find((c) => c[0] === 'setLights'), ['setLights', 0x04]);
});

test('a duration above the ceiling is an error, not a clamp', async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'driveFor', args: [40, 0, 30000] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).ok, false);
});

test('a call refused by its own argument validation does not commit the drive path', async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });

  // Over the ceiling: refused inside driveFor's own validation, before it
  // ever touches the combined frame.
  worker.emit({ kind: 'call', id: 1, method: 'driveFor', args: [40, 0, 30000] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).ok, false);

  // The combined frame is released and the raw path is now legitimate. If
  // the failed driveFor above had claimed the playvm path anyway, this call
  // would be wrongly refused as "already used the playvm drive path".
  hub.playvm.armed = false;
  worker.emit({ kind: 'call', id: 2, method: 'motorFor', args: [0x32, 50, 500] });
  await new Promise((r) => setTimeout(r, 0));
  const reply = replyTo(worker, 2);
  assert.equal(reply.ok, true, 'the failed driveFor must not have claimed the playvm path');

  host.abort('test'); // release the raw deadline motorFor armed
});

test('abort terminates the worker and runs the stop sequence in order', async () => {
  const hub = fakeHub();
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 0));
  hub.calls.length = 0;

  host.abort('test');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(worker.terminated, true);
  const order = hub.calls.map((c) => c[0]);
  assert.ok(order.indexOf('playvm.stop') < order.indexOf('brakeDrive'),
    'the combined frame stops before anything brakes');
  assert.ok(order.indexOf('steering.stop') < order.indexOf('brakeDrive'),
    'steering is released before the drive pair is braked');
  assert.ok(order.includes('motorRaw'), 'the steer port is floated, never braked');
  assert.equal(order.includes('brakeMotor'), false,
    'brakeMotor on the steer port would fight the hub');
  assert.ok(order.includes('releaseStreams'));
  assert.equal(host.state, 'idle');
});

test('a late reply from an aborted run is ignored', async () => {
  const { host, worker } = makeHost();
  host.run('', { allowUnsafe: false });
  host.abort('test');
  await new Promise((r) => setTimeout(r, 0));
  worker.posted.length = 0;
  worker.emit({ kind: 'call', id: 5, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(worker.posted, [], 'nothing is answered after the run ended');
});

test('a second run is refused while the first is still stopping', async () => {
  const { host } = makeHost();
  host.run('', { allowUnsafe: false });
  await assert.rejects(() => host.run('', { allowUnsafe: false }), /already/i);
});

test('a sensor read that never produces a sample rejects instead of hanging', async () => {
  const hub = fakeHub();
  const bus = new EventTarget();
  hub.protocol.subscribeToAccel = async () => {};   // subscribes, never emits
  hub.protocol.addEventListener = (...a) => bus.addEventListener(...a);
  hub.protocol.removeEventListener = (...a) => bus.removeEventListener(...a);
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  // An explicit 20ms timeout, not the 3s default: the read has to have
  // actually settled by the time the assertions below run, and the test must
  // not leave a live timer behind either.
  worker.emit({ kind: 'call', id: 1, method: 'accel', args: [20] });
  await new Promise((r) => setTimeout(r, 60));
  const reply = replyTo(worker, 1);
  assert.equal(reply?.ok, false, 'a timed-out read fails, it does not fabricate a zero');
  assert.match(reply.error.message, /never changes/,
    'the message has to say why nothing arrived, or the timeout looks like a bug');
  host.abort('test');
  await new Promise((r) => setTimeout(r, 0));
  // Nothing may be left listening once the run is over.
  bus.dispatchEvent(new CustomEvent('accel', { detail: { x: 1, y: 2, z: 3 } }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(worker.posted.filter((m) => m.kind === 'reply' && m.id === 1).length, 1,
    'a late sample must not produce a second answer');
});

test('a second sensor read in the same run sees the newer sample, not the first one', async () => {
  const hub = fakeHub();
  const bus = new EventTarget();
  hub.protocol.subscribeToSpeed = async () => {};
  hub.protocol.addEventListener = (...a) => bus.addEventListener(...a);
  hub.protocol.removeEventListener = (...a) => bus.removeEventListener(...a);
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });

  worker.emit({ kind: 'call', id: 1, method: 'motorSpeed', args: [0x32] });
  await new Promise((r) => setTimeout(r, 0));
  bus.dispatchEvent(new CustomEvent('speed', { detail: { port: 0x32, speed: 11 } }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).value, 11);

  // The stream keeps reporting while the macro gets on with something else.
  bus.dispatchEvent(new CustomEvent('speed', { detail: { port: 0x32, speed: 77 } }));
  await new Promise((r) => setTimeout(r, 0));

  worker.emit({ kind: 'call', id: 2, method: 'motorSpeed', args: [0x32] });
  await new Promise((r) => setTimeout(r, 80)); // the second read waits out the link floor
  assert.equal(replyTo(worker, 2).value, 77,
    'a read must see the latest sample; a frozen one makes waitUntil spin forever');

  host.abort('test');
  await new Promise((r) => setTimeout(r, 0));
  // The run's listener is gone, so a sample arriving after it must not be
  // cached into the next run.
  bus.dispatchEvent(new CustomEvent('speed', { detail: { port: 0x32, speed: 5 } }));
  await new Promise((r) => setTimeout(r, 0));
  await host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 3, method: 'motorSpeed', args: [0x32] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(replyTo(worker, 3), undefined,
    'a new run starts with an empty cache and no listener from the last one');
  host.abort('test');
});

test('waitFor collision is refused while the mode would end the run', async () => {
  const hub = fakeHub();
  hub.collision = { mode: 'abort', setMode() {}, addEventListener() {}, removeEventListener() {} };
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'waitFor', args: ['collision', 1000] });
  await new Promise((r) => setTimeout(r, 0));
  const reply = worker.posted.find((m) => m.kind === 'reply' && m.id === 1);
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /collision\('stop'\)|collision\('notify'\)/);
});

test('collision mode is restored when the run ends', async () => {
  const hub = fakeHub();
  let mode = 'off';
  hub.collision = {
    get mode() { return mode; },
    setMode(m) { mode = m; },
    addEventListener() {}, removeEventListener() {},
  };
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'collision', args: ['notify'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(mode, 'notify');
  host.abort('test');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(mode, 'off', 'the user\'s setting comes back');
});

test('the collision threshold is restored to its true value, never undefined, across a run where hub.collision starts absent', async () => {
  const hub = fakeHub(); // no hub.collision yet — e.g. before the first connect

  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'collisionThreshold', args: [1900] });
  await new Promise((r) => setTimeout(r, 0));
  host.abort('test');
  await new Promise((r) => setTimeout(r, 0));

  // The hub gains a real collision guard between runs (a reconnect, in the app).
  hub.collision = {
    params: { thresholdMg: 1800 },
    async setThreshold(mg) { this.params.thresholdMg = mg; },
    setMode() {}, addEventListener() {}, removeEventListener() {},
  };

  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 2, method: 'collisionThreshold', args: [2200] });
  // This is the second write this link pacer has ever seen, so it queues
  // behind the 60ms floor — wait it out before checking the effect landed.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(hub.collision.params.thresholdMg, 2200);

  host.abort('test');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.collision.params.thresholdMg, 1800,
    'the real prior threshold comes back, never undefined');
});

test('motorSpeed for one port is not resolved, or later served from cache, by a sample from another port', async () => {
  const hub = fakeHub();
  const bus = new EventTarget();
  hub.protocol.subscribeToSpeed = async () => {};
  hub.protocol.addEventListener = (...a) => bus.addEventListener(...a);
  hub.protocol.removeEventListener = (...a) => bus.removeEventListener(...a);
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });

  worker.emit({ kind: 'call', id: 1, method: 'motorSpeed', args: [0x33] }); // driveB
  await new Promise((r) => setTimeout(r, 0));

  // A same-named event for a different port must not settle driveB's read.
  bus.dispatchEvent(new CustomEvent('speed', { detail: { port: 0x32, speed: 999 } }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1), undefined,
    'a sample for another port must not resolve this read');

  // The real sample for driveB does resolve it, with the right value.
  bus.dispatchEvent(new CustomEvent('speed', { detail: { port: 0x33, speed: 42 } }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).value, 42);

  // A read for the OTHER port must not be answered from driveB's cache.
  worker.emit({ kind: 'call', id: 2, method: 'motorSpeed', args: [0x32] });
  // The second link write queues behind the 60ms floor; wait it out so the
  // subscribe below has actually happened before the matching event fires.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(replyTo(worker, 2), undefined,
    'a different port is not already cached just because driveB was read');
  bus.dispatchEvent(new CustomEvent('speed', { detail: { port: 0x32, speed: 7 } }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 2).value, 7);

  host.abort('test');
});

test('a second radio-reaching call in one run waits for the link floor, then goes through', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false; // raw-path calls are refused while the combined frame is armed
  const sched = fakeScheduler();
  const { host, worker } = makeHost(hub, sched);
  host.run('', { allowUnsafe: false });

  worker.emit({ kind: 'call', id: 1, method: 'brakeAll', args: [] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1)?.ok, true, 'the first write on the link goes straight through');

  worker.emit({ kind: 'call', id: 2, method: 'coast', args: [0x32] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 2), undefined, 'the second write waits out the link floor');

  sched.fireAll();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 2)?.ok, true, 'released once the floor elapses');

  host.abort('test');
});

test('stopping the run drops a write still queued behind the link floor', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const sched = fakeScheduler();
  const { host, worker } = makeHost(hub, sched);
  host.run('', { allowUnsafe: false });

  worker.emit({ kind: 'call', id: 1, method: 'brakeAll', args: [] });
  await new Promise((r) => setTimeout(r, 0));
  hub.calls.length = 0;

  worker.emit({ kind: 'call', id: 2, method: 'coast', args: [0x32] });
  await new Promise((r) => setTimeout(r, 0));

  host.abort('test');
  sched.fireAll(); // whatever the pacer had scheduled is already cancelled
  await new Promise((r) => setTimeout(r, 0));

  // abort() floats the steer port (0x34) itself; port 0x32 is the queued
  // coast() write, and that one must never reach the hub.
  assert.equal(hub.calls.some((c) => c[0] === 'motorRaw' && c[1] === 0x32), false,
    'a write still queued when the run ended must never reach the hub');
});

test('wait and print are not delayed by a write still queued on the link floor', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const sched = fakeScheduler();
  const printed = [];
  const { host, worker } = makeHost(hub, { ...sched, onPrint: (a) => printed.push(a) });
  host.run('', { allowUnsafe: false });

  worker.emit({ kind: 'call', id: 1, method: 'brakeAll', args: [] });
  await new Promise((r) => setTimeout(r, 0));

  worker.emit({ kind: 'call', id: 2, method: 'coast', args: [0x32] }); // queues behind the floor
  worker.emit({ kind: 'call', id: 3, method: 'print', args: ['hi'] });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(replyTo(worker, 2), undefined, 'the motor write is still waiting on the floor');
  assert.equal(replyTo(worker, 3)?.ok, true, 'print does not queue behind it');
  assert.deepEqual(printed, [['hi']]);

  host.abort('test');
});

test('every method in the API table has a handler', async () => {
  const hub = fakeHub();
  Object.assign(hub.protocol, {
    addEventListener: () => {}, removeEventListener: () => {},
    subscribeToPosition: async () => {}, subscribeToSpeed: async () => {},
    subscribeToIMU: async () => {}, subscribeToAccel: async () => {},
    requestBattery: async () => {}, setLights: async () => {}, setLed: async () => {},
    sendRaw: async () => {}, writeDirectMode: async () => {},
    subscribePort: async () => {}, unsubscribePort: async () => {},
    linkDriveMotorsUNSAFE: async () => null, unlinkDriveMotors: async () => {},
  });
  hub.collision = {
    mode: 'off', params: { thresholdMg: 1800 },
    async setThreshold(mg) { this.params.thresholdMg = mg; },
    setMode() {}, addEventListener() {}, removeEventListener() {},
  };
  hub.steering = { ...hub.steering, setInput() {}, setZero() {}, pos: 0 };

  const sched = fakeScheduler();
  const { host, worker } = makeHost(hub, sched);
  const { METHOD_NAMES } = await import('../src/macro/api-spec.js');
  host.run('', { allowUnsafe: true });
  for (const [i, method] of METHOD_NAMES.entries()) {
    worker.emit({ kind: 'call', id: 1000 + i, method, args: [] });
  }
  await new Promise((r) => setTimeout(r, 0));
  // Every write after the first queues behind the link floor; release them
  // all so a handler that would otherwise fail late still gets to run.
  for (let i = 0; i < METHOD_NAMES.length; i++) {
    sched.fireAll();
    await new Promise((r) => setTimeout(r, 0));
  }
  const missing = worker.posted
    .filter((m) => m.kind === 'reply' && /has no handler/.test(m.error?.message ?? ''))
    .map((m) => m.id);
  assert.deepEqual(missing, [], 'a name in the table with no handler behind it');
  host.abort('test');
});

test('the link-health monitor stops the run after five consecutive high-queue samples', async () => {
  const hub = fakeHub();
  let depth = 0;
  hub.transport = { get queueDepth() { return depth; } };
  const sched = fakeScheduler();
  const { host } = makeHost(hub, sched);
  host.run('', { allowUnsafe: false });

  depth = QUEUE_DEPTH_LIMIT + 1;
  for (let i = 0; i < QUEUE_DEPTH_STRIKES - 1; i++) {
    sched.fireAll();
    assert.equal(host.state, 'running', `still running after ${i + 1} high sample(s)`);
  }
  sched.fireAll();
  assert.equal(host.state, 'idle', 'stopped after five consecutive samples above the limit');
});

test('a sample at or below the limit resets the strike count', async () => {
  const hub = fakeHub();
  let depth = 0;
  hub.transport = { get queueDepth() { return depth; } };
  const sched = fakeScheduler();
  const { host } = makeHost(hub, sched);
  host.run('', { allowUnsafe: false });

  depth = QUEUE_DEPTH_LIMIT + 1;
  sched.fireAll(); sched.fireAll(); sched.fireAll(); // three strikes, short of stopping
  depth = 0;
  sched.fireAll(); // a normal sample resets the streak

  depth = QUEUE_DEPTH_LIMIT + 1;
  for (let i = 0; i < QUEUE_DEPTH_STRIKES - 1; i++) sched.fireAll();
  assert.equal(host.state, 'running', 'a spike before the reset does not carry over');
  sched.fireAll();
  assert.equal(host.state, 'idle', 'five in a row after the reset still stops the run');
});

test('a queue depth at or below the limit never stops the run', async () => {
  const hub = fakeHub();
  let depth = QUEUE_DEPTH_LIMIT;
  hub.transport = { get queueDepth() { return depth; } };
  const sched = fakeScheduler();
  const { host } = makeHost(hub, sched);
  host.run('', { allowUnsafe: false });

  for (let i = 0; i < 20; i++) sched.fireAll();
  assert.equal(host.state, 'running', 'a queue depth sitting at the limit is not a strike');
  host.abort('test');
});

test('print past the per-second limit is dropped with one suppression notice, then resumes', async () => {
  const hub = fakeHub();
  const sched = fakeScheduler();
  const printed = [];
  const logs = [];
  const removeSink = addLogSink((line) => logs.push(line));
  try {
    const { host, worker } = makeHost(hub, { ...sched, onPrint: (a) => printed.push(a) });
    host.run('', { allowUnsafe: false });

    for (let i = 0; i < PRINT_PER_SECOND + 5; i++) {
      worker.emit({ kind: 'call', id: i, method: 'print', args: [i] });
    }
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(printed.length, PRINT_PER_SECOND, 'only the first 20 lines in the window reach the log');
    assert.equal(logs.filter((l) => l.includes('print suppressed')).length, 1,
      'one suppression notice, not one per dropped line');

    sched.fireAll(); // the print window resets
    worker.emit({ kind: 'call', id: 'after', method: 'print', args: ['after'] });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(printed.length, PRINT_PER_SECOND + 1, 'counting resumes in the next window');
    assert.equal(logs.filter((l) => l.includes('print suppressed')).length, 1, 'still just the one notice');

    host.abort('test');
  } finally {
    removeSink();
  }
});

test('a worker script failure reaches onState as \'failed\' carrying the error, then settles idle', async () => {
  const hub = fakeHub();
  const sched = fakeScheduler();
  const seen = [];
  const { host, worker } = makeHost(hub, { ...sched, onState: (s, detail) => seen.push([s, detail]) });
  host.run('', { allowUnsafe: false });
  seen.length = 0; // drop the arming/running transitions from run()

  worker.emit({
    kind: 'failed',
    error: { name: 'ReferenceError', message: 'nope is not defined', stack: 'ReferenceError: nope is not defined\n    at eval (<anonymous>:4:1)' },
  });
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(seen.map((s) => s[0]), ['stopping', 'failed', 'idle']);
  assert.equal(seen[1][1]?.message, 'nope is not defined', 'the error detail rides on the failed transition');
  assert.equal(seen[2][1], 'error: nope is not defined',
    'idle carries the run\'s end reason as a string, not the error object again');
  assert.notStrictEqual(seen[2][1], seen[1][1],
    'the error detail delivered on failed is not re-delivered on idle');
  assert.equal(host.state, 'idle');
});

test('the reason a run ended rides along to onState with the idle transition', async () => {
  const seen = [];
  const { host } = makeHost(fakeHub(), { onState: (s, d) => seen.push([s, d]) });
  host.run('', { allowUnsafe: false });
  seen.length = 0; // drop arming/running

  host.abort('low signal');
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(seen.map((s) => s[0]), ['stopping', 'idle']);
  assert.equal(seen[1][1], 'low signal',
    'a car that stopped itself must say why, not read the same as a clean finish');
});

test('a clean finish reports itself as finished, distinguishably from a stop', async () => {
  const seen = [];
  const { host, worker } = makeHost(fakeHub(), { onState: (s, d) => seen.push([s, d]) });
  host.run('', { allowUnsafe: false });
  seen.length = 0;

  worker.emit({ kind: 'done' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen.at(-1)[1], 'finished');
});

test('a throwing onState listener cannot strand the run in stopping', async () => {
  const hub = fakeHub();
  const { host, worker } = makeHost(hub, {
    onState: (s) => { if (s === 'stopping') throw new Error('the panel blew up'); },
  });
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 0));
  hub.calls.length = 0;

  host.abort('stopped by user');
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(worker.terminated, true, 'the worker is still torn down');
  assert.ok(hub.calls.some((c) => c[0] === 'playvm.stop'), 'the combined frame is still stopped');
  assert.ok(hub.calls.some((c) => c[0] === 'brakeDrive'), 'the drive pair is still braked');
  assert.equal(host.state, 'idle', 'a latched stopping is a dead Stop button on a moving car');
  // And the next stop still works, rather than being a silent no-op forever.
  await host.run('', { allowUnsafe: false });
  host.abort('again');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(host.state, 'idle');
});

test('a tankFor whose second write fails still leaves the first motor on a deadline', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  let writes = 0;
  hub.protocol.setMotorSpeedRaw = async (p, s) => {
    hub.calls.push(['motorRaw', p, s]);
    if (++writes === 2) throw new Error('the write failed');
  };
  const sched = fakeScheduler();
  const { host, worker } = makeHost(hub, sched);
  host.run('', { allowUnsafe: false });

  worker.emit({ kind: 'call', id: 1, method: 'tankFor', args: [60, 60, 500] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).ok, false, 'the failed write is reported');

  hub.calls.length = 0;
  sched.fireAll();  // driveA's own deadline comes due
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(hub.calls.some((c) => c[0] === 'motorRaw' && c[1] === 0x32 && c[2] === 0),
    'the motor that did start must still be floated by its own deadline');

  host.abort('test');
});

test('tankFor before role discovery writes to no port at all', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  hub.protocol.roles = {};              // nothing discovered yet
  const sched = fakeScheduler();
  const { host, worker } = makeHost(hub, sched);
  host.run('', { allowUnsafe: false });

  worker.emit({ kind: 'call', id: 1, method: 'tankFor', args: [60, 60, 500] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.calls.some((c) => c[0] === 'motorRaw'), false,
    'an undiscovered role must not be written to as port 0');

  host.abort('test');
});

test('a driveFor timer from an aborted run does not release the next run\'s hold', async () => {
  const hub = fakeHub();
  const sched = fakeScheduler();
  const { host, worker } = makeHost(hub, sched);

  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'driveFor', args: [40, 0, 120] });
  await new Promise((r) => setTimeout(r, 0));
  host.abort('stopped by user');
  // Wait out the link floor so run 2's first write is not itself queued.
  await new Promise((r) => setTimeout(r, 80));

  await host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 2, method: 'drive', args: [70, 0] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 2)?.ok, true, 'run 2 took its own command');

  hub.calls.length = 0;
  sched.fireAll();  // run 1's stale driveFor timer would come due here
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.calls.some((c) => c[0] === 'playvm.stop'), false,
    'a stale timer must not stop the run that came after it');

  host.abort('test');
});

test('coast floats a port, brake brakes it, brakeAll brakes the drive pair', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;   // the raw path
  const sched = fakeScheduler();
  const { host, worker } = makeHost(hub, sched);
  host.run('', { allowUnsafe: false });

  worker.emit({ kind: 'call', id: 1, method: 'coast', args: [0x32] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1)?.ok, true);
  assert.deepEqual(hub.calls.at(-1), ['motorRaw', 0x32, 0], 'coast floats, it does not brake');

  worker.emit({ kind: 'call', id: 2, method: 'brake', args: [0x33] });
  await new Promise((r) => setTimeout(r, 0));
  sched.fireAll();  // release it from the link floor
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 2)?.ok, true);
  assert.deepEqual(hub.calls.at(-1), ['brakeMotor', 0x33]);

  worker.emit({ kind: 'call', id: 3, method: 'brakeAll', args: [] });
  await new Promise((r) => setTimeout(r, 0));
  sched.fireAll();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 3)?.ok, true);
  assert.deepEqual(hub.calls.at(-1), ['brakeDrive']);

  host.abort('test');
});

// A collision guard the test drives by hand: same event surface as the real
// one, so waitFor('collision') has something real to hear.
function fakeGuard(mode = 'notify') {
  const bus = new EventTarget();
  return {
    params: { thresholdMg: 1800 },
    get mode() { return mode; },
    setMode(m) { mode = m; },
    async setThreshold(mg) { this.params.thresholdMg = mg; },
    hit(magnitude = 3000) {
      bus.dispatchEvent(new CustomEvent('impact', { detail: { magnitude, mode } }));
    },
    addEventListener: (...a) => bus.addEventListener(...a),
    removeEventListener: (...a) => bus.removeEventListener(...a),
  };
}

test('waitFor(\'collision\') resolves with the impact while the run carries on', async () => {
  const hub = fakeHub();
  hub.collision = fakeGuard('stop');
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });

  worker.emit({ kind: 'call', id: 1, method: 'waitFor', args: ['collision', 1000] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1), undefined, 'nothing to report until the bump');

  hub.collision.hit(2500);
  await new Promise((r) => setTimeout(r, 0));
  const reply = replyTo(worker, 1);
  assert.equal(reply.ok, true);
  assert.equal(reply.value.magnitude, 2500);
  assert.equal(host.state, 'running', 'in \'stop\' mode the bump is an input, not the end');

  host.abort('test');
});

test('waitFor(\'collision\') is answered in \'notify\' mode too', async () => {
  const hub = fakeHub();
  hub.collision = fakeGuard('notify');
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });

  worker.emit({ kind: 'call', id: 1, method: 'waitFor', args: ['collision', 1000] });
  await new Promise((r) => setTimeout(r, 0));
  hub.collision.hit();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1)?.ok, true);
  assert.equal(host.state, 'running');
  host.abort('test');
});

test('waitFor rejects when no hit arrives before its timeout, leaving nothing behind', async () => {
  const hub = fakeHub();
  hub.collision = fakeGuard('notify');
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });

  worker.emit({ kind: 'call', id: 1, method: 'waitFor', args: ['collision', 20] });
  await new Promise((r) => setTimeout(r, 60));
  const reply = replyTo(worker, 1);
  assert.equal(reply?.ok, false);
  assert.match(reply.error.message, /timed out/);

  hub.collision.hit();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(worker.posted.filter((m) => m.kind === 'reply' && m.id === 1).length, 1,
    'a hit after the timeout must not answer the same call twice');
  host.abort('test');
});

test('a waitFor still pending when the run ends is torn down with it', async () => {
  const hub = fakeHub();
  hub.collision = fakeGuard('notify');
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'waitFor', args: ['collision', 5000] });
  await new Promise((r) => setTimeout(r, 0));
  host.abort('test');
  await new Promise((r) => setTimeout(r, 0));
  hub.collision.hit();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1), undefined, 'nothing is answered after the run ended');
});

test('collisionThreshold re-subscribes the hub, and the run end puts the old delta back', async () => {
  const hub = fakeHub();
  const subs = [];
  hub.protocol.subscribeToAccel = async (delta) => { subs.push(delta); };
  hub.collision = {
    params: { thresholdMg: 1800 },
    armed: true,
    mode: 'off',
    async setThreshold(mg) {
      this.params.thresholdMg = mg;
      await hub.protocol.subscribeToAccel(Math.round(mg / 2), undefined, 'collision');
    },
    setMode() {}, addEventListener() {}, removeEventListener() {},
  };
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });

  worker.emit({ kind: 'call', id: 1, method: 'collisionThreshold', args: [300] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(subs, [150],
    'a software-only change is invisible: the hub filters everything below its own delta');

  host.abort('test');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hub.collision.params.thresholdMg, 1800);
  assert.deepEqual(subs, [150, 900], 'the original hub-side delta is restored too');
});

test("mode('raw') hands the motors over and clears the run's path", async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 0));
  worker.emit({ kind: 'call', id: 2, method: 'mode', args: ['raw'] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(replyTo(worker, 2).ok, true);
  assert.deepEqual(hub.gamepad.calls, ['linked']);
  assert.equal(hub.playvm.armed, false);
  // The proof that usedPath was cleared: without it the run is still committed
  // to playvm from the drive above and this raw call would be refused.
  worker.emit({ kind: 'call', id: 3, method: 'motorFor', args: [0x32, 40, 200] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(replyTo(worker, 3).ok, true);
  host.abort('test');
});

test("mode('raw') is a no-op when the frame is already disarmed", async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['raw'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).ok, true);
  assert.deepEqual(hub.gamepad.calls, [],
    'independent and tracked already pass checkPath — do not stomp them');
  host.abort('test');
});

test("mode('playvm') is refused once the run has moved", async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'motorFor', args: [0x32, 40, 200] });
  await new Promise((r) => setTimeout(r, 0));
  worker.emit({ kind: 'call', id: 2, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 80));
  const reply = replyTo(worker, 2);
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /before the first|already moved|sweeps/i);
  host.abort('test');
});

// The one that catches motionSeen being reset alongside usedPath. Every other
// test here passes either way, because none of them drives first.
test("a mode('raw') in between does not re-open arming after the run has moved", async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 0));
  worker.emit({ kind: 'call', id: 2, method: 'mode', args: ['raw'] });
  await new Promise((r) => setTimeout(r, 80));
  worker.emit({ kind: 'call', id: 3, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(replyTo(worker, 3).ok, false,
    'motionSeen is per-run; only stop() clears it');
  host.abort('test');
});

test("mode('playvm') throws when arming fails, though setDriveMode resolves", async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  hub.gamepad.armAs = false;          // the real failure shape
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 80));
  const reply = replyTo(worker, 1);
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /could not be armed|arming failed/i);
  host.abort('test');
});

test("mode('playvm') is a no-op when the frame is already armed", async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).ok, true);
  assert.deepEqual(hub.gamepad.calls, [], 'no second rack sweep');
  host.abort('test');
});

test('a call during a switch is refused, naming the switch', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const gate = deferred();
  hub.gamepad.setDriveMode = async () => { await gate.promise; hub.playvm.armed = true; };
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 0));
  worker.emit({ kind: 'call', id: 2, method: 'motorFor', args: [0x32, 40, 200] });
  await new Promise((r) => setTimeout(r, 0));
  const reply = replyTo(worker, 2);
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /switch/i);
  gate.resolve();
  await new Promise((r) => setTimeout(r, 80));
  host.abort('test');
});

test('a mode continuation resuming after the run ended leaves the next run alone', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const gate = deferred();
  hub.gamepad.setDriveMode = async () => { await gate.promise; hub.playvm.armed = true; };
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 0));
  host.abort('test');
  await new Promise((r) => setTimeout(r, 0));
  await host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 2, method: 'motorFor', args: [0x32, 40, 200] });
  await new Promise((r) => setTimeout(r, 80));
  gate.resolve();                       // run 1's switch lands now
  await new Promise((r) => setTimeout(r, 80));
  worker.emit({ kind: 'call', id: 3, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(replyTo(worker, 3).ok, false,
    "run 2 committed raw; a stale continuation must not clear its usedPath");
  host.abort('test');
});

test('an unknown mode name and a missing gamepad both give clean errors', async () => {
  const hub = fakeHub();
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['sideways'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.match(replyTo(worker, 1).error.message, /playvm|raw/);
  hub.gamepad = null;
  hub.playvm.armed = true;
  worker.emit({ kind: 'call', id: 2, method: 'mode', args: ['raw'] });
  await new Promise((r) => setTimeout(r, 0));
  const reply = replyTo(worker, 2);
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /not connected/i);
  host.abort('test');
});

test('a stop during a switch does not write into the calibration', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const gate = deferred();
  hub.gamepad.setDriveMode = async () => { await gate.promise; hub.playvm.armed = true; };
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 0));
  hub.calls.length = 0;
  host.abort('test');
  await new Promise((r) => setTimeout(r, 0));
  const kinds = hub.calls.map((c) => c[0]);
  assert.equal(kinds.includes('motorRaw'), false,
    'floating the steer port mid-sweep fights the calibration');
  assert.equal(kinds.includes('brakeDrive'), false);
  gate.resolve();
  await new Promise((r) => setTimeout(r, 20));
});

// `switching` is one host-level flag shared by every run, so the run that
// raised it has to be the one that lowers it. Two switches overlap easily:
// a sweep takes about 2.8s and Stop can land in the middle of one.
test("an ended run's switch does not lower the latch of the switch in flight now", async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const gates = [deferred(), deferred()];
  let entered = 0;
  hub.gamepad.setDriveMode = async () => {
    const gate = gates[entered++];
    await gate.promise;
    hub.playvm.armed = true;
  };
  const { host, worker } = makeHost(hub);

  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 0));
  host.abort('run 1 stopped mid-sweep');
  await new Promise((r) => setTimeout(r, 0));

  await host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 2, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 80));   // run 2's call waits out the link floor
  assert.equal(entered, 2, 'both runs are inside setDriveMode; the sweeps overlap');

  gates[0].resolve();                   // run 1's switch lands, mid run 2's sweep
  await new Promise((r) => setTimeout(r, 0));

  hub.calls.length = 0;
  host.abort('run 2 stopped mid-sweep');
  await new Promise((r) => setTimeout(r, 0));
  const kinds = hub.calls.map((c) => c[0]);
  assert.equal(kinds.includes('motorRaw'), false,
    'floating the steer port mid-sweep fights run 2\'s live calibration');
  assert.equal(kinds.includes('brakeDrive'), false);

  gates[1].resolve();
  await new Promise((r) => setTimeout(r, 20));
});

test("steer() after mode('raw') is refused rather than silently ignored", async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  hub.steering = { setInput() { throw new Error('must not be reached'); }, stop() {} };
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'steer', args: [50] });
  await new Promise((r) => setTimeout(r, 80));
  const reply = replyTo(worker, 1);
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /steer mode|steering/i);
  host.abort('test');
});

test('a refused steer() does not spend the run\'s arming budget', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  hub.steering = { setInput() { throw new Error('must not be reached'); }, stop() {} };
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'steer', args: [50] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(replyTo(worker, 1).ok, false, 'steer outside steer mode is refused');

  // The refused call moved nothing, so mode('playvm') must still be able to arm.
  worker.emit({ kind: 'call', id: 2, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 80));
  const reply = replyTo(worker, 2);
  assert.equal(reply.ok, true,
    `a call that moved nothing must not cost the run its one arming opportunity (got: ${reply.error?.message})`);
  assert.ok(hub.gamepad.calls.includes('playvm'), 'the arming switch actually reached the hub');
  host.abort('test');
});

test("checkPath's messages name mode(), not a dropdown", async () => {
  const disarmed = fakeHub();
  disarmed.playvm.armed = false;
  const playvmSide = makeHost(disarmed);
  playvmSide.host.run('', { allowUnsafe: false });
  playvmSide.worker.emit({ kind: 'call', id: 1, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 0));
  assert.match(replyTo(playvmSide.worker, 1).error.message, /mode\('playvm'\)/);
  playvmSide.host.abort('test');

  const armed = fakeHub();
  armed.playvm.armed = true;
  const rawSide = makeHost(armed);
  rawSide.host.run('', { allowUnsafe: false });
  rawSide.worker.emit({ kind: 'call', id: 1, method: 'motorFor', args: [0x32, 40, 200] });
  await new Promise((r) => setTimeout(r, 0));
  const refusal = replyTo(rawSide.worker, 1);
  assert.equal(refusal.ok, false, 'the frame owns the motors; a raw write is refused');
  assert.match(refusal.error.message, /mode\('raw'\)/);
  rawSide.host.abort('test');
});

test('the run-end reason names the mode a macro left the hub in', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const seen = [];
  const { host, worker } = makeHost(hub, { onState: (s, d) => seen.push([s, d]) });
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(replyTo(worker, 1).ok, true);
  seen.length = 0;

  host.abort('stopped by user');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen.at(-1)[0], 'idle');
  assert.match(seen.at(-1)[1], /^stopped by user\b.*playvm/,
    'a run that left the hub in another mode has to say so, or the next run is a surprise');
});

test('a no-op mode call leaves the run-end reason plain', async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  const seen = [];
  const { host, worker } = makeHost(hub, { onState: (s, d) => seen.push([s, d]) });
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).ok, true);
  seen.length = 0;

  host.abort('stopped by user');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen.at(-1)[1], 'stopped by user',
    'nothing changed, so there is nothing to report');
});

test('arming announces the sweep before it starts', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const notices = [];
  const worker = fakeWorker();
  const host = createMacroHost(hub, {
    spawnWorker: () => worker, onState: () => {}, onPrint: () => {},
    onNotice: (text) => notices.push(text),
  });
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(notices.length, 1);
  assert.equal(notices[0], SWEEP_NOTICE,
    'byte-identical to src/ui/gamepad.js, U+2014 and U+2026 included');
  host.abort('test');
});

test('a no-op mode call announces nothing', async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  const notices = [];
  const worker = fakeWorker();
  const host = createMacroHost(hub, {
    spawnWorker: () => worker, onState: () => {}, onPrint: () => {},
    onNotice: (text) => notices.push(text),
  });
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(notices, [], 'nothing sweeps, so nothing is announced');
  host.abort('test');
});

// mode() is itself path:'any', so a latch check below checkPath's early return
// would let a second switch start while the first is still in flight.
test('a second mode() during a switch is refused by the latch too', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const gate = deferred();
  hub.gamepad.setDriveMode = async () => { await gate.promise; hub.playvm.armed = true; };
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 0));
  worker.emit({ kind: 'call', id: 2, method: 'mode', args: ['raw'] });
  await new Promise((r) => setTimeout(r, 80));
  const reply = replyTo(worker, 2);
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /switch/i);
  gate.resolve();
  await new Promise((r) => setTimeout(r, 80));
  host.abort('test');
});

test('a motion in the previous run does not forbid this one from arming', async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 0));
  host.abort('test');
  await new Promise((r) => setTimeout(r, 80));

  hub.playvm.armed = false;
  await host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 2, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(replyTo(worker, 2).ok, true, 'motionSeen is per-run; stop() clears it');
  host.abort('test');
});

test('an abort mid-switch does not leave the latch raised for the next run', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const gate = deferred();
  hub.gamepad.setDriveMode = async () => { await gate.promise; hub.playvm.armed = true; };
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 0));
  host.abort('test');
  await new Promise((r) => setTimeout(r, 0));
  await host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 2, method: 'motorFor', args: [0x32, 40, 200] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(replyTo(worker, 2).ok, true,
    'the latch is dropped by stop(), not only by the handler that raised it');
  gate.resolve();
  await new Promise((r) => setTimeout(r, 80));
  host.abort('test');
});

test('the mode one run changed is not reported again by the next', async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const seen = [];
  const { host, worker } = makeHost(hub, { onState: (s, d) => seen.push([s, d]) });
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['playvm'] });
  await new Promise((r) => setTimeout(r, 80));
  host.abort('first');
  await new Promise((r) => setTimeout(r, 80));

  await host.run('', { allowUnsafe: false });
  seen.length = 0;
  host.abort('second');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen.at(-1)[1], 'second', 'a run that changed nothing reports nothing');
});

test("mode('raw') releases the hold before it hands the motors over", async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 0));
  hub.calls.length = 0;
  worker.emit({ kind: 'call', id: 2, method: 'mode', args: ['raw'] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(replyTo(worker, 2).ok, true);
  assert.ok(hub.calls.some((c) => c[0] === 'playvm.stop'),
    'a hold left ticking would push a stale command after a later re-arm');
  host.abort('test');
});

// The other half of that: the hold has to be off the clock, not merely stopped
// once. A tick surviving the switch pushes its pre-switch command the moment
// the frame is armed again, driving the car off with no macro call behind it.
test("a hold released by mode('raw') pushes nothing after a later re-arm", async () => {
  const hub = fakeHub();
  hub.playvm.armed = true;
  const sched = fakeScheduler();
  const { host, worker } = makeHost(hub, sched);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'drive', args: [40, 0] });
  await new Promise((r) => setTimeout(r, 0));
  worker.emit({ kind: 'call', id: 2, method: 'mode', args: ['raw'] });
  await new Promise((r) => setTimeout(r, 0));
  sched.fireAll();                      // the tick, and the switch waiting on the link floor
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 2).ok, true);
  assert.equal(hub.playvm.armed, false);

  hub.playvm.armed = true;              // Setup, the pad, or a later run arms it again
  hub.calls.length = 0;
  sched.fireAll();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(hub.calls.filter((c) => c[0] === 'playvm.set'), [],
    'nothing is still on the clock to push the pre-switch command');
  host.abort('test');
});

// A deadline armed on the raw path outlives the switch that hands the motors
// to the frame, and would then float a port the frame owns.
test("mode('raw') clears a raw deadline armed before the frame took the motors", async () => {
  const hub = fakeHub();
  hub.playvm.armed = false;
  const { host, worker } = makeHost(hub);
  host.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'motorFor', args: [0x32, 40, 200] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(replyTo(worker, 1).ok, true);

  hub.playvm.armed = true;              // armed from outside the macro, deadline still live
  hub.calls.length = 0;
  worker.emit({ kind: 'call', id: 2, method: 'mode', args: ['raw'] });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(replyTo(worker, 2).ok, true);
  assert.deepEqual(hub.calls.filter((c) => c[0] === 'motorRaw'), [['motorRaw', 0x32, 0]],
    'the deadline is settled by the switch, not left to come due later');

  hub.calls.length = 0;
  await new Promise((r) => setTimeout(r, 250));   // past the 200ms it was armed for
  assert.deepEqual(hub.calls.filter((c) => c[0] === 'motorRaw'), [],
    'and it is off the clock, not merely floated once');
  host.abort('test');
});
