import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortInformation, parsePortModeInformation } from '../src/lwp-decoders.js';

// [len, hubId, 0x43, port, infoType, capabilities, modeCount, inMask LE, outMask LE]
const portInfo = (modeCount, inMask, outMask) => Uint8Array.of(
  0x0b, 0x00, 0x43, 0x36, 0x01, 0x03, modeCount,
  inMask & 0xff, inMask >> 8, outMask & 0xff, outMask >> 8,
);

test('parsePortInformation: mode masks expand to mode numbers', () => {
  const p = parsePortInformation(portInfo(4, 0b0011, 0b1100));
  assert.equal(p.port, 0x36);
  assert.equal(p.modeCount, 4);
  assert.deepEqual(p.inputModes, [0, 1]);
  assert.deepEqual(p.outputModes, [2, 3]);
});
test('parsePortInformation: a port with no writable mode reports none', () => {
  // This is the case that would explain an acknowledged write that does nothing.
  assert.deepEqual(parsePortInformation(portInfo(2, 0b11, 0)).outputModes, []);
});
test('parsePortInformation: ignores other message types', () => {
  assert.equal(parsePortInformation(Uint8Array.of(0x05, 0x00, 0x82, 0x36, 0x0a)), null);
});

test('parsePortModeInformation: NAME is trimmed ASCII, null padding dropped', () => {
  const bytes = Uint8Array.of(0x0a, 0x00, 0x44, 0x36, 0x00, 0x00, 0x50, 0x4f, 0x57, 0x00, 0x00);
  const m = parsePortModeInformation(bytes);
  assert.equal(m.text, 'POW');
  assert.equal(m.mode, 0);
});
test('parsePortModeInformation: RAW range decodes as two LE float32', () => {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat32(0, -100, true);
  new DataView(buf).setFloat32(4, 100, true);
  const bytes = Uint8Array.of(0x0e, 0x00, 0x44, 0x36, 0x01, 0x01, ...new Uint8Array(buf));
  assert.deepEqual(parsePortModeInformation(bytes).range, [-100, 100]);
});
test('parsePortModeInformation: VALUE FORMAT names the data type', () => {
  const bytes = Uint8Array.of(0x0a, 0x00, 0x44, 0x36, 0x00, 0x80, 0x04, 0x00, 0x04, 0x00);
  assert.deepEqual(parsePortModeInformation(bytes).format,
    { values: 4, dataType: 'int8', figures: 4, decimals: 0 });
});
test('parsePortModeInformation: unknown info type is kept as raw bytes', () => {
  const bytes = Uint8Array.of(0x07, 0x00, 0x44, 0x36, 0x00, 0x7f, 0xab);
  assert.deepEqual(parsePortModeInformation(bytes).raw, [0xab]);
});
