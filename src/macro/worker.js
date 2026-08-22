// The macro worker. Holds the user's program and nothing else.
//
// navigator.bluetooth is not exposed to workers.
// This file contains no policy of any kind: the host refuses what should be
// refused, because user code can bypass these proxies with a bare
// self.postMessage.

import { METHOD_NAMES } from './api-spec.js';
import { createCaller, WAIT_UNTIL_POLL_MS } from './rpc.js';

const caller = createCaller((msg) => self.postMessage(msg));

// One proxy per name in the table. Dotted names become nested objects, so
// `unsafe.raw` in the table is `unsafe.raw(...)` in a macro.
const api = {};
for (const name of METHOD_NAMES) {
  const [head, tail] = name.split('.');
  const fn = (...args) => caller.call(name, args);
  if (tail === undefined) api[head] = fn;
  else (api[head] ??= {})[tail] = fn;
}

// waitUntil's predicate is a function, which cannot cross postMessage. The
// loop lives here; the calls it makes are still RPCs, so the host still paces
// and can still refuse them.
api.waitUntil = async (predicate, timeoutMs = 3000, pollMs = WAIT_UNTIL_POLL_MS) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    await caller.call('wait', [Math.max(pollMs, WAIT_UNTIL_POLL_MS)]);
  }
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const describe = (err) => ({
  // stack rides along for the host's line-number extraction. A call the host
  // itself refuses is constructed away from the eval'd source and carries no
  // such line.
  name: err?.name ?? 'Error',
  message: err?.message ?? String(err),
  stack: err?.stack,
});

// Every proxy returns a promise, so a refused call the author did not await
// rejects with nobody listening. Reporting only: the refusal already happened
// host-side, and user code can bypass this as easily as it bypasses a proxy.
// See docs/DESIGN-NOTES.md § An un-awaited call still has to be reported
self.addEventListener('unhandledrejection', (e) => {
  self.postMessage({ kind: 'failed', error: describe(e.reason) });
});

async function run(source) {
  const names = Object.keys(api);
  const body = new AsyncFunction(...names, source);
  await body(...names.map((n) => api[n]));
}

// A call the author did not await is still outstanding when the body returns,
// so posting 'done' straight away reports a refused call as a clean run and
// the rejection above never gets the chance to fire. A refusal comes back
// within a couple of milliseconds; the budget only ever runs down for a call
// that was accepted, where 'done' being 50ms late costs nothing.
const SETTLE_BUDGET_MS = 50;
const SETTLE_POLL_MS = 5;

async function drainOutstandingCalls() {
  for (let waited = 0; caller.pending && waited < SETTLE_BUDGET_MS; waited += SETTLE_POLL_MS) {
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.kind === 'reply') { caller.settle(msg); return; }
  if (msg.kind !== 'run') return;
  try {
    await run(msg.source);
    await drainOutstandingCalls();
    self.postMessage({ kind: 'done' });
  } catch (err) {
    self.postMessage({ kind: 'failed', error: describe(err) });
  }
};
