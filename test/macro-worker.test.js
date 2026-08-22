// The worker's error channel. It reports; it enforces nothing — user code can
// bypass every proxy in it with a bare self.postMessage.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const posted = [];
const listeners = new Map();

globalThis.self = {
  postMessage: (m) => posted.push(m),
  addEventListener: (type, fn) => listeners.set(type, fn),
  onmessage: null,
};

const worker = import('../src/macro/worker.js');

test('an un-awaited call the host refuses is reported, not swallowed', async () => {
  await worker;
  posted.length = 0;
  const onRejection = listeners.get('unhandledrejection');
  assert.ok(onRejection, 'a refused call on its own line has no other way to be seen');

  onRejection({
    reason: new Error('motorFor is an unsafe call and this macro has unsafe turned off'),
    preventDefault() {},
  });

  assert.deepEqual(posted.map((m) => m.kind), ['failed']);
  assert.match(posted[0].error.message, /unsafe/);
});

test('done waits for a call the author did not await, so a refusal can be reported first', async () => {
  await worker;
  posted.length = 0;

  // A body that fires a call and returns without awaiting it — the style the
  // shipped placeholder used to model.
  const finished = self.onmessage({ data: { kind: 'run', source: 'ports();' } });
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(posted.map((m) => m.kind), ['call'],
    'a clean run must not be reported while a call is still outstanding');

  const call = posted[0];
  self.onmessage({ data: { kind: 'reply', id: call.id, ok: true, value: {} } });
  await finished;
  assert.deepEqual(posted.map((m) => m.kind), ['call', 'done']);
});

test('a rejection with a non-Error reason still produces a readable failure', async () => {
  await worker;
  posted.length = 0;
  listeners.get('unhandledrejection')({ reason: 'nope', preventDefault() {} });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].kind, 'failed');
  assert.equal(posted[0].error.message, 'nope');
});
