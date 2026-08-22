// Pure LWP 3.0 byte encoders. No BLE, no DOM.

export function toSignedByte(speed) {
  const clamped = Math.max(-100, Math.min(100, Math.trunc(speed)));
  return clamped < 0 ? clamped + 256 : clamped;
}

export function encodeMotorSpeed(port, speed) {
  return Uint8Array.of(0x09, 0x00, 0x81, port, 0x11, 0x07, toSignedByte(speed), 0x64, 0x03);
}

export function encodeLedColor(port, colorInt) {
  const c = Math.max(0, Math.min(10, Math.trunc(colorInt)));
  return Uint8Array.of(0x08, 0x00, 0x81, port, 0x11, 0x51, 0x00, c);
}

// Port Information Request (0x21). infoType 0x01 = MODE INFO,
// 0x02 = possible mode combinations.
export function encodePortInformationRequest(port, infoType = 0x01) {
  return Uint8Array.of(0x05, 0x00, 0x21, port, infoType);
}

// Port Information Request, infoType 0x00: the hub answers with a 0x45 value and
// no subscription is involved.
// See docs/DESIGN-NOTES.md § A snapshot polls, it does not subscribe
export function encodePortValueRequest(port) {
  return Uint8Array.of(0x05, 0x00, 0x21, port, 0x00);
}

// Port Mode Information Request (0x22). Asks about ONE mode of a port.
export const MODE_INFO = {
  NAME: 0x00, RAW: 0x01, PCT: 0x02, SI: 0x03, SYMBOL: 0x04,
  MAPPING: 0x05, VALUE_FORMAT: 0x80,
};
export function encodePortModeInformationRequest(port, mode, infoType) {
  return Uint8Array.of(0x06, 0x00, 0x22, port, mode, infoType);
}

export function encodeVirtualPortConnect(portA, portB) {
  return Uint8Array.of(0x06, 0x00, 0x61, 0x01, portA, portB);
}

// Last byte is the notification-enable flag.
// See docs/DESIGN-NOTES.md § The notify byte of InputFormatSetup must be settable
export function encodeInputFormatSetup(port, mode, delta, notify = true) {
  const d = delta >>> 0;
  return Uint8Array.of(0x0a, 0x00, 0x41, port, mode,
    d & 0xff, (d >>> 8) & 0xff, (d >>> 16) & 0xff, (d >>> 24) & 0xff, notify ? 0x01 : 0x00);
}

export function encodeInputFormatDisable(port, mode) {
  return encodeInputFormatSetup(port, mode, 0, false);
}

// Generic WriteDirectModeData. Header is 7 bytes
// [len, hubId, 0x81, port, 0x11, 0x51, mode] plus the value bytes; the length
// byte counts the whole message, itself included.
export function encodeWriteDirectMode(port, mode, values) {
  const v = (Array.isArray(values) ? values : [values]).map((n) => n & 0xff);
  return Uint8Array.of(7 + v.length, 0x00, 0x81, port, 0x11, 0x51, mode, ...v);
}

// Direct POWER mode 0 — floats the motor, unlike StartSpeed(0).
// See docs/DESIGN-NOTES.md § StartSpeed(0) is a regulated hold, not a stop
export function encodeMotorFloat(port) {
  return encodeWriteDirectMode(port, 0x00, [0x00]);
}
// 0x7f is the BRAKE sentinel of the StartPower sub-command (0x01).
// See docs/DESIGN-NOTES.md § The brake sentinel only means brake for StartPower
export function encodeMotorBrake(port) {
  return Uint8Array.of(0x07, 0x00, 0x81, port, 0x11, 0x01, 0x7f);
}

function int32LE(v) {
  const n = v | 0;
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

// Preset/zero the motor's POS (position mode 0x02). WriteDirectModeData, int32 LE.
// See docs/DESIGN-NOTES.md § `encodePresetEncoder` was confirmed against hardware
export function encodePresetEncoder(port, value) {
  return Uint8Array.of(0x0b, 0x00, 0x81, port, 0x11, 0x51, 0x02, ...int32LE(value));
}

// Subscribe to POS (accumulated position) mode 0x02.
export function encodePositionSubscribe(port, delta) {
  return encodeInputFormatSetup(port, 0x02, delta);
}

// EXPERIMENTAL — crashes this hub's firmware. Probe deliberately; never drive on it.
// See docs/DESIGN-NOTES.md § The position-command family crashes this hub's firmware
export function encodeGotoAbsolutePosition(port, angle, speed, maxPower, endState = 0x7e) {
  return Uint8Array.of(0x0e, 0x00, 0x81, port, 0x11, 0x0d,
    ...int32LE(angle), toSignedByte(speed), maxPower & 0xff, endState, 0x00);
}

// EXPERIMENTAL — position-command family; probe deliberately.
export function encodeStartSpeedForDegrees(port, degrees, speed, maxPower, endState = 0x7e) {
  return Uint8Array.of(0x0e, 0x00, 0x81, port, 0x11, 0x0b,
    ...int32LE(degrees), toSignedByte(speed), maxPower & 0xff, endState, 0x00);
}

export const END_STATE = { float: 0x00, brake: 0x7f };
export const MAX_TIMED_MS = 32767;

// Time is Int16 little-endian; 32768 encodes as a negative duration.
export function encodeStartSpeedForTime(port, timeMs, speed, maxPower, endState) {
  if (!Number.isInteger(timeMs) || timeMs < 1 || timeMs > MAX_TIMED_MS) {
    throw new Error(`timed slice must be 1..${MAX_TIMED_MS} ms, got ${timeMs}`);
  }
  if (endState !== END_STATE.float && endState !== END_STATE.brake) {
    throw new Error(`end state must be float (0x00) or brake (0x7f), not 0x${endState.toString(16)}`);
  }
  return Uint8Array.of(0x0c, 0x00, 0x81, port, 0x11, 0x09,
    timeMs & 0xff, (timeMs >> 8) & 0xff,
    toSignedByte(speed), maxPower & 0xff, endState, 0x00);
}

// Zero is deliberately left alone by the `!speed` guard.
// See docs/DESIGN-NOTES.md § Zero must survive inversion
export function applyInvert(port, speed, invertedPorts) {
  if (!speed || !invertedPorts?.has(port)) return speed;
  return -speed;
}

// The combined frame, from DanieleBenedettelli/TechnicMoveHub: thirteen bytes,
// a fixed `03 00` header then speed, steering, lights and a trailing zero.
// The lights field also carries the two init commands, and must NOT be masked.
// See docs/DESIGN-NOTES.md § The lights field of the combined frame is not only lights
export const PLAYVM_LIGHTS = {
  BOTH_ON: 0x00, FRONT_ON_BRAKE_REAR: 0x01, OFF: 0x04, FRONT_OFF_BRAKE_REAR: 0x05,
};
export const PLAYVM_CMD = { COMMAND: 0x10, CALIBRATE_STEERING: 0x08 };

export function encodePlayVmFrame(port, speed, steer, lights) {
  return Uint8Array.of(
    0x0d, 0x00, 0x81, port, 0x11, 0x51, 0x00,
    0x03, 0x00,
    toSignedByte(speed), toSignedByte(steer), lights & 0xff, 0x00,
  );
}

// Hub Alerts (0x03). Operation 0x01 is Enable Updates; the hub then sends an
// Update (0x04) whenever the alert's state changes.
// The alert types live in lwp-decoders.js as HUB_ALERT.
export function encodeHubAlertSubscribe(alertType) {
  return Uint8Array.of(0x05, 0x00, 0x03, alertType & 0xff, 0x01);
}
