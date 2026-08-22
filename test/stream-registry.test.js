import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamRegistry } from '../src/stream-registry.js';

test('acquire: the first holder sets the stream up', () => {
  const r = createStreamRegistry();
  assert.deepEqual(r.acquire(0x32, 0x01, 5, 'telemetry'), { action: 'setup', delta: 5 });
});

test('acquire: a second holder at a coarser delta changes nothing on the wire', () => {
  const r = createStreamRegistry();
  r.acquire(0x32, 0x01, 5, 'telemetry');
  assert.deepEqual(r.acquire(0x32, 0x01, 20, 'macro'), { action: 'none', delta: 5 });
});

test('acquire: a second holder at a finer delta re-sets the stream up', () => {
  const r = createStreamRegistry();
  r.acquire(0x32, 0x01, 20, 'telemetry');
  assert.deepEqual(r.acquire(0x32, 0x01, 5, 'macro'), { action: 'setup', delta: 5 });
});

test('acquire: the same holder twice is not two holders', () => {
  const r = createStreamRegistry();
  r.acquire(0x32, 0x01, 5, 'telemetry');
  r.acquire(0x32, 0x01, 5, 'telemetry');
  assert.deepEqual(r.holders(0x32, 0x01), ['telemetry']);
  assert.deepEqual(r.release(0x32, 0x01, 'telemetry'), { action: 'disable' });
});

test('release: the last holder disables the stream', () => {
  const r = createStreamRegistry();
  r.acquire(0x32, 0x01, 5, 'telemetry');
  assert.deepEqual(r.release(0x32, 0x01, 'telemetry'), { action: 'disable' });
  assert.equal(r.modeOf(0x32), null);
});

test('release: dropping the finest holder restores the coarser delta', () => {
  const r = createStreamRegistry();
  r.acquire(0x38, 0x00, 900, 'collision');
  r.acquire(0x38, 0x00, 100, 'macro');
  assert.deepEqual(r.release(0x38, 0x00, 'macro'), { action: 'setup', delta: 900 });
  assert.deepEqual(r.holders(0x38, 0x00), ['collision']);
});

test('release: dropping a coarser holder leaves the wire alone', () => {
  const r = createStreamRegistry();
  r.acquire(0x38, 0x00, 100, 'macro');
  r.acquire(0x38, 0x00, 900, 'collision');
  assert.deepEqual(r.release(0x38, 0x00, 'collision'), { action: 'none' });
});

test('release: an unknown holder is a no-op, not a throw', () => {
  const r = createStreamRegistry();
  assert.deepEqual(r.release(0x32, 0x01, 'nobody'), { action: 'none' });
});

test('Rule 7: a second mode on the same port is refused', () => {
  const r = createStreamRegistry();
  r.acquire(0x34, 0x02, 2, 'steering');           // POS on the steer port
  assert.throws(
    () => r.acquire(0x34, 0x01, 2, 'macro'),       // SPEED on the same port
    /port 0x34 is already streaming mode 0x2/,
  );
});

test('Rule 7: the same mode on the same port is fine', () => {
  const r = createStreamRegistry();
  r.acquire(0x34, 0x02, 2, 'steering');
  assert.doesNotThrow(() => r.acquire(0x34, 0x02, 2, 'macro'));
});

test('Rule 7: the port is free again once every holder has released', () => {
  const r = createStreamRegistry();
  r.acquire(0x34, 0x02, 2, 'steering');
  r.release(0x34, 0x02, 'steering');
  assert.doesNotThrow(() => r.acquire(0x34, 0x01, 2, 'macro'));
});

test('releaseAll: drops every stream one holder was keeping', () => {
  const r = createStreamRegistry();
  r.acquire(0x32, 0x01, 5, 'macro');
  r.acquire(0x38, 0x00, 100, 'macro');
  r.acquire(0x38, 0x00, 900, 'collision');
  const out = r.releaseAll('macro');
  assert.deepEqual(out, [
    { port: 0x32, mode: 0x01, action: 'disable' },
    { port: 0x38, mode: 0x00, action: 'setup', delta: 900 },
  ]);
  assert.deepEqual(r.holders(0x38, 0x00), ['collision']);
});

test('modeOf: reports the live mode of a port', () => {
  const r = createStreamRegistry();
  assert.equal(r.modeOf(0x32), null);
  r.acquire(0x32, 0x01, 5, 'telemetry');
  assert.equal(r.modeOf(0x32), 0x01);
});
