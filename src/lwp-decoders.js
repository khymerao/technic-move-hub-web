// Pure LWP 3.0 decoders + IOType role mapping. No BLE, no DOM.

export const IO_TYPE = {
  DRIVE_MOTOR: 0x0056, STEER_MOTOR: 0x0057, RGB_LED: 0x0017,
  LIGHTS_6: 0x0058, // Technic Move built-in 6-lamp array
  VOLTAGE: 0x0014,     // port 0x3c: modes VLT L (filtered) and VLT S (instant), mV
  TEMPERATURE: 0x003c, // port 0x37: mode TEMP, deci-degrees C
  ANALYTICS: 0x005c,   // port 0x3d: LEIOTypeTechnicAnalytics, play/charge counters
};
export const EXPECTED_PORTS = { imu: 0x3a, lights: 0x35 };
export const LIGHTS_PORT = 0x35;
export const ACCEL_PORT = 0x38; // 3x Int16 gravity vector in mG
export const ORINT_PORT = 0x3b; // fused orientation quaternion, 4x Int16
// Accepts the 13-byte combined frame; 0x08 in its lights field is CALIBRATE_STEERING.
// See docs/DESIGN-NOTES.md § The lights field of the combined frame is not only lights
export const PLAYVM_PORT = 0x36;
// VLT S, the instantaneous mode. VLT L is mode 0 and is averaged.
export const VOLTAGE_MODE_INSTANT = 0x01;
export const TEMP_MODE = 0x00;
// Mode 3 of the analytics device, 'Total': three Int32 lifetime accumulators.
export const ANALYTICS_TOTAL_MODE = 0x03;

const toSigned = (b) => (b > 127 ? b - 256 : b);

export function parseMessage(bytes) {
  if (!bytes || bytes.length < 3) return null;
  return { length: bytes[0], hubId: bytes[1], type: bytes[2], payload: bytes.slice(3) };
}

export function parseHubAttachedIO(bytes) {
  const m = parseMessage(bytes);
  if (!m || m.type !== 0x04 || m.payload.length < 2) return null;
  const port = m.payload[0];
  const event = m.payload[1];
  const ioType = event === 0x00 ? 0x0000 : (m.payload[2] | (m.payload[3] << 8));
  return { port, event, ioType };
}

export function parsePortValueSingle(bytes) {
  const m = parseMessage(bytes);
  if (!m || m.type !== 0x45 || m.payload.length < 1) return null;
  return { port: m.payload[0], values: [...m.payload.slice(1)].map(toSigned) };
}

// Hub Properties (type 0x01): [len, hubId, 0x01, property, operation, payload...]
// Battery percent = property 0x06, operation 0x06 (Update).
export function parseHubProperty(bytes) {
  const m = parseMessage(bytes);
  if (!m || m.type !== 0x01 || m.payload.length < 2) return null;
  return { property: m.payload[0], operation: m.payload[1], payload: [...m.payload.slice(2)] };
}

// Port Information (0x43), infoType 0x01: [port, 0x01, capabilities, modeCount,
// inputModes(uint16 LE), outputModes(uint16 LE)]. An OUTPUT mode is writable.
// See docs/DESIGN-NOTES.md § Output modes are what the port information message is actually for
export function parsePortInformation(bytes) {
  const m = parseMessage(bytes);
  if (!m || m.type !== 0x43 || m.payload.length < 8 || m.payload[1] !== 0x01) return null;
  const bits = (v) => Array.from({ length: 16 }, (_, i) => i).filter((i) => v & (1 << i));
  const inputMask = m.payload[4] | (m.payload[5] << 8);
  const outputMask = m.payload[6] | (m.payload[7] << 8);
  return {
    port: m.payload[0],
    capabilities: m.payload[2],
    modeCount: m.payload[3],
    inputModes: bits(inputMask),
    outputModes: bits(outputMask),
  };
}

const float32LE = (p, o) =>
  new DataView(Uint8Array.from(p.slice(o, o + 4)).buffer).getFloat32(0, true);
const ascii = (p) => String.fromCharCode(...[...p].filter((c) => c >= 0x20 && c < 0x7f)).trim();

// Port Mode Information (0x44): [port, mode, infoType, ...value]. The value
// shape depends on infoType, so each branch decodes its own.
export const DATA_TYPE = { 0: 'int8', 1: 'int16', 2: 'int32', 3: 'float' };
export function parsePortModeInformation(bytes) {
  const m = parseMessage(bytes);
  if (!m || m.type !== 0x44 || m.payload.length < 3) return null;
  const port = m.payload[0], mode = m.payload[1], infoType = m.payload[2];
  const v = m.payload.slice(3);
  const out = { port, mode, infoType };
  if (infoType === 0x00 || infoType === 0x04) out.text = ascii(v);
  else if (infoType <= 0x03 && v.length >= 8) out.range = [float32LE(v, 0), float32LE(v, 4)];
  else if (infoType === 0x05 && v.length >= 2) out.mapping = [v[0], v[1]];
  else if (infoType === 0x80 && v.length >= 4) {
    out.format = { values: v[0], dataType: DATA_TYPE[v[1]] ?? v[1], figures: v[2], decimals: v[3] };
  } else out.raw = [...v];
  return out;
}

export function parseInt32LE(bytes, offset = 0) {
  return (bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24));
}

export function buildRoleMap(events) {
  const map = {};
  const drives = [];
  for (const e of events) {
    if (e.event === 0x02) { map.combined = e.port; continue; } // virtual/combined port
    if (e.event !== 0x01) continue; // only "attached"
    if (e.ioType === IO_TYPE.DRIVE_MOTOR) drives.push(e.port);
    else if (e.ioType === IO_TYPE.STEER_MOTOR) map.steer = e.port;
    else if (e.ioType === IO_TYPE.RGB_LED) map.led = e.port;
    else if (e.ioType === IO_TYPE.LIGHTS_6) map.lights = e.port;
    else if (e.ioType === IO_TYPE.VOLTAGE) map.volt = e.port;
    else if (e.ioType === IO_TYPE.TEMPERATURE) map.temp = e.port;
    else if (e.ioType === IO_TYPE.ANALYTICS) map.analytics = e.port;
  }
  if (drives[0] !== undefined) map.driveA = drives[0];
  if (drives[1] !== undefined) map.driveB = drives[1];
  return map;
}

// Port Value (0x45) payloads that carry signed 16-bit words: the accelerometer
// and gyro (3), the tilt sensor (3), the orientation quaternion (4). Null
// rather than a partial reading when the payload is short.
// 'Total' is three Int32 accumulators, but a port read hands back Int16 words.
// Charge seconds, play seconds, and a third figure never seen to move.
export function analyticsTotalFromWords(words) {
  if (!words || words.length < 6) return null;
  const u32 = (lo, hi) => (((lo & 0xffff) | ((hi & 0xffff) << 16)) >>> 0);
  return {
    chargeSeconds: u32(words[0], words[1]),
    playSeconds: u32(words[2], words[3]),
    third: u32(words[4], words[5]),
  };
}

export function parseWords16(bytes, count = 3) {
  const m = parseMessage(bytes);
  if (!m || m.type !== 0x45 || m.payload.length < 1 + count * 2) return null;
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = m.payload[1 + i * 2] | (m.payload[2 + i * 2] << 8);
    out.push(v > 32767 ? v - 65536 : v);
  }
  return out;
}

export function parseVector16(bytes) {
  const w = parseWords16(bytes, 3);
  return w ? { x: w[0], y: w[1], z: w[2] } : null;
}

// Hub Alerts (0x03): [len, hubId, 0x03, alertType, operation, payload].
// Payload is 0x00 for OK and 0xff for alert. Operation 0x04 is the hub's
// downstream Update; anything else is one of our own outgoing messages.
export const HUB_ALERT = {
  LOW_VOLTAGE: 0x01, HIGH_CURRENT: 0x02, LOW_SIGNAL: 0x03, OVER_POWER: 0x04,
};
export const HUB_ALERT_NAME = {
  [HUB_ALERT.LOW_VOLTAGE]: 'low-voltage',
  [HUB_ALERT.HIGH_CURRENT]: 'high-current',
  [HUB_ALERT.LOW_SIGNAL]: 'low-signal',
  [HUB_ALERT.OVER_POWER]: 'over-power',
};

export function parseHubAlert(bytes) {
  const m = parseMessage(bytes);
  if (!m || m.type !== 0x03 || m.payload.length < 3) return null;
  if (m.payload[1] !== 0x04) return null;
  const alert = m.payload[0];
  return {
    alert,
    name: HUB_ALERT_NAME[alert],
    operation: m.payload[1],
    active: m.payload[2] !== 0x00,
  };
}
