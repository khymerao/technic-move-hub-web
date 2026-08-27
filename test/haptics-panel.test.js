import { test } from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor() {
    this.hidden = false;
    this.textContent = '';
    this.value = '0';
    this.checked = false;
    this._events = new Map();
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
  }
  addEventListener(type, fn) { this._events.set(type, fn); }
  fire(type, ev = {}) { this._events.get(type)?.({ preventDefault() {}, target: this, ...ev }); }
}

const IDS = ['hap-on', 'hap-strong', 'hap-strong-out', 'hap-weak', 'hap-weak-out', 'hap-test', 'hap-status'];

function stubDom() {
  const els = new Map(IDS.map((id) => [id, new El()]));
  els.get('hap-strong').value = '70';
  els.get('hap-weak').value = '50';
  globalThis.document = { getElementById: (id) => els.get(id) ?? null };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
  return els;
}

test('defaults are off with the stored intensities', async () => {
  stubDom();
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  const panel = initHapticsPanel({});
  const s = panel.settings();
  assert.equal(s.enabled, false);
  assert.equal(s.transient, 0.7);
  assert.equal(s.bed, 0.5);
});

test('toggling pushes settings to a controller that exists', async () => {
  const els = stubDom();
  const seen = [];
  const hub = { haptics: { setSettings: (s) => seen.push(s), test: () => Promise.resolve('idle') } };
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  initHapticsPanel(hub);
  els.get('hap-on').checked = true;
  els.get('hap-on').fire('change');
  assert.equal(seen.at(-1).enabled, true);
});

test('a slider moved before connect is not lost', async () => {
  const els = stubDom();
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  const panel = initHapticsPanel({});
  els.get('hap-weak').value = '20';
  els.get('hap-weak').fire('input');
  assert.equal(panel.settings().bed, 0.2);
});

test('settings survive a reload', async () => {
  const els = stubDom();
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  initHapticsPanel({});
  els.get('hap-on').checked = true;
  els.get('hap-on').fire('change');
  const { loadHapticsSettings } = await import('../src/ui/haptics.js');
  assert.equal(loadHapticsSettings().enabled, true);
});

test('an unsupported status is shown plainly', async () => {
  const els = stubDom();
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  const panel = initHapticsPanel({});
  panel.showStatus('unsupported');
  assert.match(els.get('hap-status').textContent, /unsupported/);
});

// ── Fix round 1 ───────────────────────────────────────────────────────────
// The five tests above came from the plan. These pin the behaviours the plan's
// set left open: the driver arrives after the panel is built, the probe has to
// tell "no controller" from "no actuator", and a stored blob is untrusted input.

// getGamepads is not a thing under node, and the probe path reads it.
function stubPads(pads) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => pads },
    configurable: true,
    writable: true,
  });
}

test('a driver that appears after init is given the settings set before it', async () => {
  const els = stubDom();
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  const hub = {};
  const panel = initHapticsPanel(hub);
  els.get('hap-weak').value = '20';
  els.get('hap-weak').fire('input');

  const seen = [];
  hub.haptics = { setSettings: (s) => seen.push(s), status: () => 'idle' };
  panel.attach();
  assert.equal(seen.length, 1, 'the late driver must be told, not left on its own defaults');
  assert.equal(seen[0].bed, 0.2);
  panel.attach();
  assert.equal(seen.length, 1, 'the same driver is not re-pushed on every call');
});

test('a status event after connect also catches up a late driver', async () => {
  const els = stubDom();
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  const hub = {};
  const panel = initHapticsPanel(hub);
  els.get('hap-strong').value = '30';
  els.get('hap-strong').fire('input');

  const seen = [];
  hub.haptics = { setSettings: (s) => seen.push(s), status: () => 'idle' };
  panel.showStatus('idle');
  assert.equal(seen.at(-1).transient, 0.3);
});

test('a pre-connect change reaches the driver even when the store refuses the write', async () => {
  const els = stubDom();
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  const hub = {};
  const panel = initHapticsPanel(hub);
  els.get('hap-on').checked = true;
  els.get('hap-on').fire('change');
  els.get('hap-weak').value = '15';
  els.get('hap-weak').fire('input');

  const seen = [];
  hub.haptics = { setSettings: (s) => seen.push(s), status: () => 'idle' };
  panel.attach();
  assert.equal(seen.at(-1).enabled, true, 'a failed save must not lose the setting');
  assert.equal(seen.at(-1).bed, 0.15);
});

test('the driver is handed a copy, not the panel\'s own settings object', async () => {
  const els = stubDom();
  const seen = [];
  const hub = { haptics: { setSettings: (s) => seen.push(s), status: () => 'idle' } };
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  initHapticsPanel(hub);
  els.get('hap-on').checked = true;
  els.get('hap-on').fire('change');
  const handed = seen.at(-1);
  els.get('hap-weak').value = '10';
  els.get('hap-weak').fire('input');
  assert.equal(handed.bed, 0.5, 'the earlier push must not mutate under the driver');
});

test('the probe says "not connected" before connect, not "unsupported"', async () => {
  const els = stubDom();
  stubPads([]);
  globalThis.localStorage.setItem('lego-haptics-v1', JSON.stringify({ enabled: true }));
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  initHapticsPanel({});
  els.get('hap-test').fire('click');
  const text = els.get('hap-status').textContent;
  assert.match(text, /not connected/);
  assert.doesNotMatch(text, /unsupported/, 'nothing is unsupported — there is no controller yet');
});

test('the probe still reports unsupported when a driver says so', async () => {
  const els = stubDom();
  stubPads([{ connected: true }]);
  const hub = { haptics: { setSettings: () => {}, test: () => Promise.resolve('unsupported'), status: () => 'unsupported' } };
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  initHapticsPanel(hub);
  els.get('hap-test').fire('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.match(els.get('hap-status').textContent, /unsupported/);
});

test('a rejecting test() is reported rather than left unhandled', async () => {
  const els = stubDom();
  stubPads([{ connected: true }]);
  const hub = {
    haptics: {
      setSettings: () => {},
      status: () => 'idle',
      test: () => Promise.reject(new Error('actuator gone')),
    },
  };
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  initHapticsPanel(hub);
  els.get('hap-test').fire('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.match(els.get('hap-status').textContent, /failed/);
  assert.match(els.get('hap-status').textContent, /actuator gone/);
});

test('a wrong-typed stored value is coerced, never handed to the mixer', async () => {
  stubDom();
  globalThis.localStorage.setItem('lego-haptics-v1', JSON.stringify({ enabled: 'yes', transient: 'loud', bed: 9 }));
  const { loadHapticsSettings } = await import('../src/ui/haptics.js');
  const s = loadHapticsSettings();
  assert.equal(s.transient, 0.7, 'a non-number falls back to the default');
  assert.equal(s.bed, 1, 'an out-of-range number is clamped');
  assert.equal(s.enabled, false, 'only a real boolean turns it on');
  assert.ok(Number.isFinite(s.transient) && Number.isFinite(s.bed));
});

test('a disconnect does not read as ready', async () => {
  const els = stubDom();
  globalThis.localStorage.setItem('lego-haptics-v1', JSON.stringify({ enabled: true }));
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  const panel = initHapticsPanel({});
  panel.reset();
  assert.match(els.get('hap-status').textContent, /not connected/);
  assert.doesNotMatch(els.get('hap-status').textContent, /ready/);
});

test('the status line announces itself', async () => {
  const els = stubDom();
  const attrs = new Map();
  els.get('hap-status').setAttribute = (k, v) => attrs.set(k, v);
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  initHapticsPanel({});
  assert.equal(attrs.get('role'), 'status');
});

test('missing markup does not take the rest of the panel down with it', async () => {
  const els = stubDom();
  els.delete('hap-strong');
  els.delete('hap-weak');
  const { initHapticsPanel } = await import('../src/ui/haptics.js');
  const panel = initHapticsPanel({});
  assert.ok(panel, 'init must still return its API');
  assert.equal(panel.settings().transient, 0.7);
  els.get('hap-test').fire('click');
});
