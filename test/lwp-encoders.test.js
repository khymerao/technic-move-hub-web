import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toSignedByte, encodeMotorSpeed, encodeLedColor,
  encodeVirtualPortConnect, encodeInputFormatSetup,
  encodePresetEncoder, encodePositionSubscribe,
  encodeGotoAbsolutePosition, encodeStartSpeedForDegrees, encodeWriteDirectMode,
  encodeMotorFloat, encodeMotorBrake, applyInvert,
  encodePortInformationRequest, encodePortModeInformationRequest, MODE_INFO,
  encodeInputFormatDisable,
  encodePlayVmFrame, PLAYVM_LIGHTS, PLAYVM_CMD,
  encodeStartSpeedForTime, END_STATE,
  encodePortValueRequest,
} from '../src/lwp-encoders.js';

test('toSignedByte: positive passes through', () => {
  assert.equal(toSignedByte(100), 100);
  assert.equal(toSignedByte(0), 0);
});
test('toSignedByte: negative uses two\'s complement', () => {
  assert.equal(toSignedByte(-1), 255);
  assert.equal(toSignedByte(-100), 156); // 256 - 100
});
test('toSignedByte: clamps out-of-range', () => {
  assert.equal(toSignedByte(250), 100);
  assert.equal(toSignedByte(-250), 156);
});
test('encodeMotorSpeed: layout and length', () => {
  const p = encodeMotorSpeed(0x32, 50);
  assert.deepEqual([...p], [0x09, 0x00, 0x81, 0x32, 0x11, 0x07, 50, 0x64, 0x03]);
});
test('encodeMotorSpeed: negative speed encoded', () => {
  const p = encodeMotorSpeed(0x33, -50);
  assert.equal(p[6], 206); // 256 - 50
});
test('encodeLedColor: layout + clamp to 0..10', () => {
  assert.deepEqual([...encodeLedColor(0x3f, 9)], [0x08, 0x00, 0x81, 0x3f, 0x11, 0x51, 0x00, 9]);
  assert.equal(encodeLedColor(0x3f, 99)[7], 10);
  assert.equal(encodeLedColor(0x3f, -5)[7], 0);
});
test('encodeVirtualPortConnect', () => {
  assert.deepEqual([...encodeVirtualPortConnect(0x32, 0x33)], [0x06, 0x00, 0x61, 0x01, 0x32, 0x33]);
});
test('encodeInputFormatSetup: 4-byte LE delta + notify enable', () => {
  const p = encodeInputFormatSetup(0x3a, 0, 5);
  assert.deepEqual([...p], [0x0a, 0x00, 0x41, 0x3a, 0x00, 5, 0, 0, 0, 0x01]);
});

test('encodePresetEncoder: zero POS matches hardware-confirmed bytes', () => {
  assert.deepEqual([...encodePresetEncoder(0x34, 0)],
    [0x0b, 0x00, 0x81, 0x34, 0x11, 0x51, 0x02, 0x00, 0x00, 0x00, 0x00]);
});
test('encodePresetEncoder: negative value is int32 LE two\'s complement', () => {
  assert.deepEqual([...encodePresetEncoder(0x34, -1).slice(7)], [0xff, 0xff, 0xff, 0xff]);
});
test('encodePositionSubscribe: POS mode 0x02 input-format setup', () => {
  assert.deepEqual([...encodePositionSubscribe(0x34, 2)],
    [0x0a, 0x00, 0x41, 0x34, 0x02, 2, 0, 0, 0, 0x01]);
});
test('encodeGotoAbsolutePosition: +45 speed40 pow50 hold', () => {
  assert.deepEqual([...encodeGotoAbsolutePosition(0x34, 45, 40, 50)],
    [0x0e, 0x00, 0x81, 0x34, 0x11, 0x0d, 45, 0, 0, 0, 40, 50, 0x7e, 0x00]);
});
test('encodeStartSpeedForDegrees: 5deg speed30 pow40 hold', () => {
  assert.deepEqual([...encodeStartSpeedForDegrees(0x34, 5, 30, 40)],
    [0x0e, 0x00, 0x81, 0x34, 0x11, 0x0b, 5, 0, 0, 0, 30, 40, 0x7e, 0x00]);
});

test('encodeWriteDirectMode: length byte counts whole message', () => {
  // 7-byte header + 2 values = 9 total
  const p = encodeWriteDirectMode(0x35, 0x00, [0x3f, 100]);
  assert.equal(p.length, 9);
  assert.equal(p[0], 0x09, 'length byte must equal byte count');
  assert.deepEqual([...p], [0x09, 0x00, 0x81, 0x35, 0x11, 0x51, 0x00, 0x3f, 100]);
});
test('encodeWriteDirectMode: single value matches LED framing', () => {
  const p = encodeWriteDirectMode(0x3f, 0x00, [9]);
  assert.deepEqual([...p], [0x08, 0x00, 0x81, 0x3f, 0x11, 0x51, 0x00, 9]);
});

test('encodeMotorFloat: WriteDirectModeData POWER=0 (coast, not servo-hold)', () => {
  assert.deepEqual([...encodeMotorFloat(0x34)],
    [0x08, 0x00, 0x81, 0x34, 0x11, 0x51, 0x00, 0x00]);
});
test('encodeMotorBrake: StartPower sub-command, 127 = BRAKE sentinel', () => {
  // 127 only means BRAKE for StartPower (sub 0x01). Written into the direct
  // POWER mode it is read as a power level, which creeps the motor instead.
  assert.deepEqual([...encodeMotorBrake(0x34)],
    [0x07, 0x00, 0x81, 0x34, 0x11, 0x01, 0x7f]);
});

test('applyInvert: flips only the marked port', () => {
  const inv = new Set([0x33]);
  assert.equal(applyInvert(0x32, 50, inv), 50);
  assert.equal(applyInvert(0x33, 50, inv), -50);
  assert.equal(applyInvert(0x33, -50, inv), 50);
  assert.equal(applyInvert(0x33, 0, inv), 0, 'zero stays zero so stop stays stop');
});


test('encodePortInformationRequest: MODE INFO query', () => {
  assert.deepEqual([...encodePortInformationRequest(0x36)], [0x05, 0x00, 0x21, 0x36, 0x01]);
});
test('encodePortModeInformationRequest: port + mode + info type', () => {
  assert.deepEqual([...encodePortModeInformationRequest(0x36, 2, MODE_INFO.NAME)],
    [0x06, 0x00, 0x22, 0x36, 0x02, 0x00]);
});
test('introspection requests are queries, never PortOutputCommand', () => {
  // 0x81 is the write opcode. If either of these ever carries it, a "read-only"
  // dump would be commanding hardware.
  assert.notEqual(encodePortInformationRequest(0x36)[2], 0x81);
  assert.notEqual(encodePortModeInformationRequest(0x36, 0, 0x00)[2], 0x81);
});

test('encodeInputFormatSetup: notification byte defaults to enabled', () => {
  assert.equal(encodeInputFormatSetup(0x36, 0, 1)[9], 0x01);
});
test('encodeInputFormatDisable: turns notifications OFF, not up to full rate', () => {
  // The trap: reaching for the subscribe encoder to unsubscribe leaves the
  // notify byte at 0x01 with delta 0, which means "report on every update" —
  // a firehose instead of silence.
  const p = encodeInputFormatDisable(0x36, 0x00);
  assert.deepEqual([...p], [0x0a, 0x00, 0x41, 0x36, 0x00, 0, 0, 0, 0, 0x00]);
  assert.equal(p[9], 0x00, 'notification byte must be 0 or this subscribes instead');
});

test('encodePlayVmFrame: matches the reference 13-byte frame', () => {
  assert.deepEqual([...encodePlayVmFrame(0x36, 0, 0, PLAYVM_LIGHTS.OFF)],
    [0x0d, 0x00, 0x81, 0x36, 0x11, 0x51, 0x00, 0x03, 0x00, 0, 0, 0x04, 0x00]);
});
test('encodePlayVmFrame: the init commands survive encoding', () => {
  // The whole point. Masking this field to & 0x05 made the hub's required
  // initialisation unsendable, so every drive frame after it was discarded.
  assert.equal(encodePlayVmFrame(0x36, 0, 0, PLAYVM_CMD.COMMAND)[11], 0x10);
  assert.equal(encodePlayVmFrame(0x36, 0, 0, PLAYVM_CMD.CALIBRATE_STEERING)[11], 0x08);
});
test('encodePlayVmFrame: init frames match the reference byte for byte', () => {
  assert.deepEqual([...encodePlayVmFrame(0x36, 0, 0, PLAYVM_CMD.COMMAND)],
    [0x0d, 0x00, 0x81, 0x36, 0x11, 0x51, 0x00, 0x03, 0x00, 0x00, 0x00, 0x10, 0x00]);
  assert.deepEqual([...encodePlayVmFrame(0x36, 0, 0, PLAYVM_CMD.CALIBRATE_STEERING)],
    [0x0d, 0x00, 0x81, 0x36, 0x11, 0x51, 0x00, 0x03, 0x00, 0x00, 0x00, 0x08, 0x00]);
});
test('encodePlayVmFrame: speed and steering are signed bytes', () => {
  const p = encodePlayVmFrame(0x36, -30, 40, 0);
  assert.equal(p[9], 226);
  assert.equal(p[10], 40);
});

test('a timed slice encodes exactly the frame the hub answered', () => {
  // Measured on hardware 2026-08-09: this frame ran driveA for 500 ms and the
  // hub reported completion itself.
  assert.deepEqual([...encodeStartSpeedForTime(0x32, 500, 15, 100, END_STATE.float)],
    [0x0c, 0x00, 0x81, 0x32, 0x11, 0x09, 0xf4, 0x01, 0x0f, 0x64, 0x00, 0x00]);
});

test('time is little-endian and bounded by the signed ceiling', () => {
  assert.deepEqual([...encodeStartSpeedForTime(0x32, 1000, 20, 100, END_STATE.brake)].slice(6, 8),
    [0xe8, 0x03]);
  assert.throws(() => encodeStartSpeedForTime(0x32, 32768, 20, 100, END_STATE.brake),
    /32767/, 'the field is Int16 — 65000 would encode as -535');
});

test('reverse is two.s complement, matching the command scale', () => {
  assert.equal([...encodeStartSpeedForTime(0x32, 400, -100, 100, END_STATE.float)][8], 156);
});

test('HOLD cannot be encoded at all', () => {
  assert.throws(() => encodeStartSpeedForTime(0x32, 400, 20, 100, 0x7e), /hold|0x7e/i,
    'HOLD engages the position controller, which crashes this firmware');
  assert.deepEqual(Object.values(END_STATE), [0x00, 0x7f]);
});

test('the profile byte is off, unlike the untimed encoder', () => {
  assert.equal([...encodeStartSpeedForTime(0x32, 400, 20, 100, END_STATE.float)][11], 0x00);
  assert.equal([...encodeMotorSpeed(0x32, 20)].at(-1), 0x03,
    'the untimed encoder ramps; the timed one steps, and that is a current difference');
});

test('the one-shot value request carries infoType 0 and no format setup', () => {
  assert.deepEqual([...encodePortValueRequest(0x38)], [0x05, 0x00, 0x21, 0x38, 0x00]);
});
