import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCaller, SOURCE_LINE_OFFSET } from '../src/macro/rpc.js';

test('call sends a request and resolves on its reply', async () => {
  const sent = [];
  const c = createCaller((m) => sent.push(m));
  const p = c.call('drive', [40, 0]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'call');
  assert.equal(sent[0].method, 'drive');
  assert.deepEqual(sent[0].args, [40, 0]);
  c.settle({ kind: 'reply', id: sent[0].id, ok: true, value: 7 });
  assert.equal(await p, 7);
});

test('a failed reply rejects with a real Error', async () => {
  const sent = [];
  const c = createCaller((m) => sent.push(m));
  const p = c.call('unsafe.raw', [[1, 2]]);
  c.settle({
    kind: 'reply', id: sent[0].id, ok: false,
    error: { name: 'Error', message: 'unsafe is off for this macro' },
  });
  await assert.rejects(p, /unsafe is off for this macro/);
});

test('ids are unique, and replies are matched by id', async () => {
  const sent = [];
  const c = createCaller((m) => sent.push(m));
  const a = c.call('battery', []);
  const b = c.call('tilt', []);
  assert.notEqual(sent[0].id, sent[1].id);
  c.settle({ kind: 'reply', id: sent[1].id, ok: true, value: 'tilt' });
  c.settle({ kind: 'reply', id: sent[0].id, ok: true, value: 'battery' });
  assert.equal(await a, 'battery');
  assert.equal(await b, 'tilt');
});

test('a reply for an unknown id is ignored, not thrown', () => {
  const c = createCaller(() => {});
  assert.doesNotThrow(() => c.settle({ kind: 'reply', id: 999, ok: true }));
});

test('pending counts calls awaiting a reply', async () => {
  const sent = [];
  const c = createCaller((m) => sent.push(m));
  const p = c.call('wait', [10]);
  assert.equal(c.pending, 1);
  c.settle({ kind: 'reply', id: sent[0].id, ok: true });
  await p;
  assert.equal(c.pending, 0);
});

test('the source line offset is the two lines AsyncFunction adds', () => {
  assert.equal(SOURCE_LINE_OFFSET, 2);
});
