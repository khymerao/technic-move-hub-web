// The share row's one piece of behaviour: the copy button.
//
// It is hidden in the markup and revealed only when a clipboard exists, so the
// failure this guards against is a dead button on a browser that has none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initShare } from '../src/ui/share.js';

function stub({ clipboard } = {}) {
  const btn = {
    id: 'share-copy', hidden: true, textContent: 'Copy link', dataset: {},
    _click: null,
    addEventListener(type, fn) { if (type === 'click') this._click = fn; },
  };
  globalThis.document = {
    getElementById: (id) => (id === 'share-copy' ? btn : null),
    querySelector: () => ({ href: 'https://move-hub.site/' }),
  };
  // Node exposes navigator as a getter-only global, so it cannot be assigned.
  const set = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  set('navigator', clipboard === undefined ? {} : { clipboard });
  set('location', { href: 'https://move-hub.site/?utm_source=x' });
  return btn;
}

test('no clipboard leaves the button hidden and unwired', () => {
  const btn = stub();
  initShare();
  assert.equal(btn.hidden, true);
  assert.equal(btn._click, null);
});

test('a clipboard reveals the button', () => {
  const btn = stub({ clipboard: { writeText: async () => {} } });
  initShare();
  assert.equal(btn.hidden, false);
});

test('it copies the canonical URL, not the address bar', async () => {
  let written = null;
  const btn = stub({ clipboard: { writeText: async (t) => { written = t; } } });
  initShare();
  await btn._click();
  assert.equal(written, 'https://move-hub.site/');
});

test('a copy says so, and says so temporarily', async () => {
  const btn = stub({ clipboard: { writeText: async () => {} } });
  initShare();
  await btn._click();
  assert.equal(btn.textContent, 'copied');
  assert.equal('said' in btn.dataset, true);
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal(btn.textContent, 'Copy link');
  assert.equal('said' in btn.dataset, false);
});

test('a refused clipboard reports the refusal rather than claiming a copy', async () => {
  const btn = stub({ clipboard: { writeText: async () => { throw new Error('denied'); } } });
  initShare();
  await btn._click();
  assert.equal(btn.textContent, 'could not copy');
});
