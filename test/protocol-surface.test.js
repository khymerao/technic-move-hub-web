// The panels and the probe reach into LegoProtocol by name. A refactor that
// renames or drops a method leaves those calls parsing fine and failing only
// when a user taps the button — which is how `protocol.sendRaw is not a
// function` reached the hardware.
//
// This walks the source for `protocol.foo(` / `hub.protocol.foo(` and asserts
// each name exists on the class.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { LegoProtocol } from '../src/lego-protocol.js';
import { END_STATE } from '../src/lwp-encoders.js';

globalThis.document = globalThis.document ?? { getElementById: () => null };

const FILES = [
  ...readdirSync('src/ui').map((f) => `src/ui/${f}`),
  ...readdirSync('src/macro').map((f) => `src/macro/${f}`),
  'src/main.js', 'src/collision.js', 'src/playvm-drive.js', 'src/playvm-controller.js',
  'src/steering-controller.js', 'src/gamepad-controller.js',
];

// Names that are looked up on something else that happens to be called
// `protocol` in a local scope, or are properties rather than methods.
const NOT_METHODS = new Set(['roles', 'invertedPorts', 'drivePort', 'attachedPorts', 'imuPort']);

function calledNames() {
  const found = new Map(); // name -> first file that calls it
  const re = /(?:hub\.)?protocol[?.]*\.([a-zA-Z][a-zA-Z0-9]*)\s*\??\.?\s*\(/g;
  for (const file of FILES) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      if (!NOT_METHODS.has(m[1]) && !found.has(m[1])) found.set(m[1], file);
    }
  }
  return found;
}

test('every protocol method the app calls actually exists', () => {
  const proto = new LegoProtocol({ addEventListener() {}, sendPayload() {}, sendBurst() {} });
  const missing = [];
  for (const [name, file] of calledNames()) {
    if (typeof proto[name] !== 'function') missing.push(`${name}() called in ${file}`);
  }
  assert.deepEqual(missing, [], 'these calls would throw at runtime');
});

// The scan above asserts names only, so a changed return value passes it and
// breaks the app at runtime. These pin the shapes of the stop path.
// The writes answer with a sentinel, so a method that leaks its inner return
// value out to the app is visible here instead of resolving to undefined anyway.
const stubTransport = () => ({
  addEventListener() {},
  sendPayload: async () => 'sent',
  sendBurst: async () => 'burst',
});

test('the stop methods still return a promise resolving to undefined', async () => {
  const proto = new LegoProtocol(stubTransport());
  proto.roles = { driveA: 0x32, driveB: 0x33 };

  const motor = proto.brakeMotor(0x34);
  assert.ok(motor instanceof Promise, 'brakeMotor must stay awaitable');
  assert.equal(await motor, undefined, 'brakeMotor resolves to nothing');

  const drive = proto.brakeDrive();
  assert.ok(drive instanceof Promise, 'brakeDrive must stay awaitable');
  assert.equal(await drive, undefined, 'brakeDrive resolves to nothing');
});

test('stopSettled returns a promise and resolves when no stop is pending', async () => {
  const proto = new LegoProtocol(stubTransport());
  proto.roles = { driveA: 0x32, driveB: 0x33 };
  const settled = proto.stopSettled(0x32);
  assert.ok(settled instanceof Promise, 'stopSettled must be awaitable');
  assert.equal(await settled, undefined);
  assert.equal(await proto.stopSettled(), undefined, 'no argument means the drive pair');
});

// The brake frame is StartPower(0x7f) — the only write the staged stop makes
// after its coast, so a transport can fail exactly that one.
const isBrakeFrame = (bytes) => bytes[5] === 0x01 && bytes[6] === 0x7f;

test('stopSettled rejects when the staged brake write fails', async () => {
  const failure = new Error('the link dropped');
  const proto = new LegoProtocol({
    addEventListener() {},
    sendPayload: async (bytes) => { if (isBrakeFrame(bytes)) throw failure; return 'sent'; },
    sendBurst: async () => 'burst',
  });
  proto.roles = { driveA: 0x32, driveB: 0x33 };
  await proto.setMotorSpeedRaw(0x34, 80);
  await proto.brakeMotor(0x34);
  await assert.rejects(proto.stopSettled(0x34), (err) => err === failure);
});

test('stopSettled resolves once the staged brake write lands', async () => {
  const written = [];
  const proto = new LegoProtocol({
    addEventListener() {},
    sendPayload: async (bytes) => { if (isBrakeFrame(bytes)) written.push(bytes[3]); return 'sent'; },
    sendBurst: async () => 'burst',
  });
  proto.roles = { driveA: 0x32, driveB: 0x33 };
  await proto.setMotorSpeedRaw(0x34, 80);
  await proto.brakeMotor(0x34);
  assert.deepEqual(written, [], 'the brake is still staged behind the coast');
  assert.equal(await proto.stopSettled(0x34), undefined);
  assert.deepEqual(written, [0x34], 'the brake frame went out before stopSettled resolved');
});

test('the scan actually finds calls, so a passing result means something', () => {
  const names = calledNames();
  assert.ok(names.size >= 8, `expected to find real calls, found ${names.size}`);
  assert.ok(names.has('emergencyStop'), 'sanity: emergencyStop is called somewhere');
});

// Same mechanism as elsewhere in the suite: the transport is an EventTarget,
// and incoming bytes arrive as a 'data' CustomEvent on it.
function fakeProtocol() {
  const transport = new EventTarget();
  transport.sendPayload = async () => 'sent';
  transport.sendBurst = async () => 'burst';
  const protocol = new LegoProtocol(transport);
  return { protocol, transport };
}

test('a 0x82 carrying several pairs is dispatched as several events', () => {
  const { protocol, transport } = fakeProtocol();
  const seen = [];
  protocol.addEventListener('port-feedback', (e) => seen.push(e.detail));
  // Two ports answering in one message, which is what a tank burst produces.
  transport.dispatchEvent(new CustomEvent('data',
    { detail: Uint8Array.of(0x07, 0x00, 0x82, 0x32, 0x0a, 0x33, 0x0a) }));
  assert.deepEqual(seen, [{ port: 0x32, status: 0x0a }, { port: 0x33, status: 0x0a }],
    'reading one pair drops driveB and sends every tank call down the failure path');
});

test('startSpeedForTime is on the protocol, so mcp/ has a name guard too', () => {
  assert.equal(typeof LegoProtocol.prototype.startSpeedForTime, 'function');
});

test('two identical timed slices both reach the transport, each under its own queue key', async () => {
  const sent = [];
  const proto = new LegoProtocol({
    addEventListener() {},
    sendPayload: async (bytes, key) => { sent.push({ bytes: [...bytes], key }); return 'sent'; },
    sendBurst: async () => 'burst',
  });
  await proto.startSpeedForTime(0x32, 1000, 50, 100, END_STATE.brake);
  await proto.startSpeedForTime(0x32, 1000, 50, 100, END_STATE.brake);
  assert.equal(sent.length, 2,
    'both identical slices must reach the transport — the duplicate guard would have dropped the second');
  assert.deepEqual(sent[0].bytes, sent[1].bytes, 'the two frames are byte-for-byte identical');
  assert.notEqual(sent[0].key, sent[1].key,
    'distinct queue keys, or the write queue would coalesce the second slice away before it is sent');
});

// isBrakeFrame is declared above, alongside the other stopSettled tests.
test('startSpeedForTime records the commanded speed, so a brake right after it still stages a coast', async () => {
  const written = [];
  const proto = new LegoProtocol({
    addEventListener() {},
    sendPayload: async (bytes) => { written.push([...bytes]); return 'sent'; },
    sendBurst: async () => 'burst',
  });
  await proto.startSpeedForTime(0x34, 1000, 80, 100, END_STATE.brake);
  await proto.brakeMotor(0x34);
  assert.equal(written.some(isBrakeFrame), false,
    'the recorded speed (80) is high enough to stage: the coast goes out, the brake waits behind the timer');
});

test('startSpeedForTime clears the duplicate guard, so the next ordinary command ' +
  'is compared against nothing rather than against a timed frame it never matched', async () => {
  const sent = [];
  const proto = new LegoProtocol({
    addEventListener() {},
    sendPayload: async (bytes, key) => { sent.push({ bytes: [...bytes], key }); return 'sent'; },
    sendBurst: async () => 'burst',
  });
  await proto.setMotorSpeedRaw(0x32, 50);
  await proto.startSpeedForTime(0x32, 500, 50, 100, END_STATE.brake);
  sent.length = 0;
  // Same signature as the very first call above ('speed:50') — if the duplicate
  // guard's memory of that first call survived the timed slice in between, this
  // would be read as a repeat and dropped, even though the motor spent the last
  // 500ms doing something the guard never saw.
  await proto.setMotorSpeedRaw(0x32, 50);
  assert.equal(sent.length, 1,
    'an ordinary command identical to one sent before a timed slice must still reach the wire');
});

test('noteMotorStopped resets the brake policy, so a brake once the peak has ' +
  'decayed lands directly instead of staging a coast it no longer needs', async () => {
  const written = [];
  let t = 0;
  const timers = [];
  const setTimer = (fn, ms) => { const entry = { at: t + ms, fn, live: true }; timers.push(entry); return entry; };
  const clearTimer = (entry) => { if (entry) entry.live = false; };
  const proto = new LegoProtocol({
    addEventListener() {},
    sendPayload: async (bytes) => { written.push([...bytes]); return 'sent'; },
    sendBurst: async () => 'burst',
  }, { now: () => t, setTimer, clearTimer });

  await proto.startSpeedForTime(0x34, 1000, 80, 100, END_STATE.brake);
  proto.noteMotorStopped(0x34);
  t += 1600; // clear the 1500ms recent-peak window entirely on the injected clock
  await proto.brakeMotor(0x34);

  assert.ok(written.some(isBrakeFrame),
    'noteMotorStopped must zero the reference speed, or the stale peak stages a coast forever');
  assert.equal(timers.filter((e) => e.live).length, 0,
    'a direct brake stages nothing, so no timer should be left pending');
});
