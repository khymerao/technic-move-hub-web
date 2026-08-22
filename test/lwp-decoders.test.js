import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IO_TYPE, parseMessage, parseHubAttachedIO, parsePortValueSingle, buildRoleMap,
  parseInt32LE, parseHubProperty, parseVector16, parseWords16,
} from '../src/lwp-decoders.js';

test('parseMessage: splits framing', () => {
  const m = parseMessage(Uint8Array.of(0x05, 0x00, 0x45, 0x3a, 0x07));
  assert.equal(m.length, 5);
  assert.equal(m.hubId, 0x00);
  assert.equal(m.type, 0x45);
  assert.deepEqual([...m.payload], [0x3a, 0x07]);
});
test('parseMessage: rejects too-short', () => {
  assert.equal(parseMessage(Uint8Array.of(0x01)), null);
});
test('parseHubAttachedIO: attached device', () => {
  // [len,0x00,0x04,port,event=0x01,ioTypeLo,ioTypeHi,...]
  const io = parseHubAttachedIO(Uint8Array.of(0x0f, 0x00, 0x04, 0x32, 0x01, 0x56, 0x00));
  assert.deepEqual(io, { port: 0x32, event: 0x01, ioType: 0x0056 });
});
test('parseHubAttachedIO: wrong type returns null', () => {
  assert.equal(parseHubAttachedIO(Uint8Array.of(0x05, 0x00, 0x45, 0x3a, 0x07)), null);
});
test('parsePortValueSingle: signed values', () => {
  const v = parsePortValueSingle(Uint8Array.of(0x07, 0x00, 0x45, 0x3a, 0xff, 0x00, 0x64));
  assert.equal(v.port, 0x3a);
  assert.deepEqual(v.values, [-1, 0, 100]);
});
test('parsePortValueSingle: wrong type returns null', () => {
  assert.equal(parsePortValueSingle(Uint8Array.of(0x0f, 0x00, 0x04, 0x32, 0x01, 0x56, 0x00)), null);
});
test('buildRoleMap: maps by IOType and order', () => {
  const map = buildRoleMap([
    { port: 0x32, event: 0x01, ioType: IO_TYPE.DRIVE_MOTOR },
    { port: 0x33, event: 0x01, ioType: IO_TYPE.DRIVE_MOTOR },
    { port: 0x34, event: 0x01, ioType: IO_TYPE.STEER_MOTOR },
    { port: 0x3f, event: 0x01, ioType: IO_TYPE.RGB_LED },
    { port: 0x36, event: 0x02, ioType: 0x0000 },
  ]);
  assert.equal(map.driveA, 0x32);
  assert.equal(map.driveB, 0x33);
  assert.equal(map.steer, 0x34);
  assert.equal(map.led, 0x3f);
  assert.equal(map.combined, 0x36);
});

test('parseInt32LE: signed little-endian', () => {
  assert.equal(parseInt32LE(Uint8Array.of(0x2d, 0, 0, 0)), 45);
  assert.equal(parseInt32LE(Uint8Array.of(0xff, 0xff, 0xff, 0xff)), -1);
  assert.equal(parseInt32LE(Uint8Array.of(0, 0, 0, 0, 0x2d, 0, 0, 0), 4), 45);
});

test('parseHubProperty: battery percent update', () => {
  // [len,0x00,0x01,prop=0x06,op=0x06,value]
  const p = parseHubProperty(Uint8Array.of(0x06, 0x00, 0x01, 0x06, 0x06, 87));
  assert.deepEqual(p, { property: 0x06, operation: 0x06, payload: [87] });
});
test('parseHubProperty: wrong type returns null', () => {
  assert.equal(parseHubProperty(Uint8Array.of(0x05, 0x00, 0x45, 0x3a, 0x07)), null);
});

test('parseVector16: accelerometer values are three signed 16-bit words', () => {
  // [len,0x00,0x45,port, x lo hi, y lo hi, z lo hi]
  const v = parseVector16(Uint8Array.of(0x0a, 0x00, 0x45, 0x38, 0xe8, 0x03, 0x00, 0x00, 0x18, 0xfc));
  assert.deepEqual(v, { x: 1000, y: 0, z: -1000 });
});
test('parseVector16: rejects a payload that is too short', () => {
  assert.equal(parseVector16(Uint8Array.of(0x05, 0x00, 0x45, 0x38, 0x01)), null);
});

test('parseWords16 reads three signed 16-bit words', () => {
  // [len, hubId, 0x45, port, 1000, -2000, 3000] little-endian
  const bytes = [0x0a, 0x00, 0x45, 0x3a, 0xe8, 0x03, 0x30, 0xf8, 0xb8, 0x0b];
  assert.deepEqual(parseWords16(bytes, 3), [1000, -2000, 3000]);
});

test('parseWords16 reads four words for the orientation port', () => {
  const bytes = [0x0c, 0x00, 0x45, 0x3b, 0x00, 0x40, 0x00, 0x20, 0x00, 0x10, 0x00, 0x08];
  assert.deepEqual(parseWords16(bytes, 4), [0x4000, 0x2000, 0x1000, 0x0800]);
});

test('parseWords16 refuses a payload short of the requested word count', () => {
  const threeWords = [0x0a, 0x00, 0x45, 0x3a, 0xe8, 0x03, 0x30, 0xf8, 0xb8, 0x0b];
  assert.equal(parseWords16(threeWords, 4), null);
});

test('parseVector16 still returns a vector and still refuses a short payload', () => {
  const bytes = [0x0a, 0x00, 0x45, 0x38, 0xe8, 0x03, 0x30, 0xf8, 0xb8, 0x0b];
  assert.deepEqual(parseVector16(bytes), { x: 1000, y: -2000, z: 3000 });
  assert.equal(parseVector16([0x04, 0x00, 0x45, 0x38]), null);
});
