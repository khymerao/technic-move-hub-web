// The Macros panel drives the recorder: arm it, stop it, and re-emit the ride
// at a new tolerance without recording again.
//
// See docs/superpowers/specs/2026-08-28-ride-recorder-design.md

import { test } from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor() {
    this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false;
    this.checked = false;
    this.children = []; this.dataset = {}; this.options = []; this._events = new Map();
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c),
    };
  }
  // One type, several listeners: macros.js and macro-help.js both listen for
  // the unsafe checkbox's `change`, and a single-slot map loses one of them.
  addEventListener(type, fn) {
    if (!this._events.has(type)) this._events.set(type, []);
    this._events.get(type).push(fn);
  }
  fire(type, ev = {}) {
    for (const fn of this._events.get(type) ?? []) fn({ preventDefault() {}, target: this, ...ev });
  }
  append(...kids) { for (const k of kids) if (k instanceof El) this.children.push(k); }
  appendChild(k) { this.append(k); }
  replaceChildren(...kids) { this.children = kids.filter((k) => k instanceof El); }
  click() { this.fire('click'); }
  focus() {}
  set innerHTML(_v) {}
}

function stubDom() {
  const els = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, new El());
      return els.get(id);
    },
    createElement: () => new El(),
  };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  // The panel starts a polling timer; leaving it real keeps the process alive.
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  return els;
}

function fakeHub(ride) {
  let live = false;
  return {
    connected: true,
    macro: { get state() { return 'idle'; }, run() {}, abort() {} },
    recorder: {
      get recording() { return live; },
      start() { live = true; },
      stop() { live = false; return ride; },
    },
  };
}

const RIDE = {
  path: 'playvm', sourceMode: 'playvm',
  startedAtWall: Date.UTC(2026, 7, 28, 11, 2),
  durationMs: 1000, stopReason: 'user',
  settings: { steerGain: 100, trim: 0, maxSpeed: 100 },
  channels: [], telemetry: [],
  frames: [{ t: 0, speed: 40, steer: 0 }, { t: 900, speed: 0, steer: 0 }],
};

const EMPTY_RIDE = { ...RIDE, frames: [], durationMs: 0 };

test('Record is disabled until the hub is connected', async () => {
  const els = stubDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  initMacroPanel({ ...fakeHub(RIDE), connected: false });
  assert.equal(els.get('macro-record').disabled, true);
});

test('recording disables Run, and stopping re-enables it', async () => {
  const els = stubDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  const hub = fakeHub(RIDE);
  initMacroPanel(hub);
  els.get('macro-record').fire('click');
  assert.equal(hub.recorder.recording, true);
  assert.equal(els.get('macro-run').disabled, true);
  els.get('macro-record').fire('click');
  assert.equal(hub.recorder.recording, false);
  assert.equal(els.get('macro-run').disabled, false);
});

test('a recording with no frames leaves the open macro alone and says why', async () => {
  const els = stubDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  const hub = fakeHub(EMPTY_RIDE);
  initMacroPanel(hub);
  els.get('macro-source').value = 'await drive(10, 0);';
  els.get('macro-record').fire('click');
  els.get('macro-record').fire('click');
  assert.equal(els.get('macro-source').value, 'await drive(10, 0);');
  assert.equal(els.get('macro-record-note').hidden, false);
  assert.match(els.get('macro-record-note').textContent, /nothing/i);
});

test('a finished recording never overwrites the macro that was open', async () => {
  const els = stubDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  const hub = fakeHub(RIDE);
  const panel = initMacroPanel(hub);
  els.get('macro-source').value = 'await drive(10, 0);';
  const before = JSON.parse(globalThis.localStorage.getItem('lego.macros.v1') ?? '[]');
  els.get('macro-record').fire('click');
  els.get('macro-record').fire('click');
  assert.match(els.get('macro-source').value, /driveFor/);
  const after = JSON.parse(globalThis.localStorage.getItem('lego.macros.v1') ?? '[]');
  const overwritten = after.some((m) =>
    before.some((b) => b.id === m.id && b.source !== m.source));
  assert.equal(overwritten, false, 'a stored macro was rewritten by the recording');
  assert.ok(panel);
});

test('the recorded slot does not reach storage until it is saved once', async () => {
  const els = stubDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  initMacroPanel(fakeHub(RIDE));
  els.get('macro-record').fire('click');
  els.get('macro-record').fire('click');
  els.get('macro-source').fire('input');
  const stored = JSON.parse(globalThis.localStorage.getItem('lego.macros.v1') ?? '[]');
  assert.equal(stored.some((m) => /driveFor/.test(m.source ?? '')), false);
});

test('moving the tolerance re-emits from the ride without recording again', async () => {
  const els = stubDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  const hub = fakeHub(RIDE);
  initMacroPanel(hub);
  els.get('macro-record').fire('click');
  els.get('macro-record').fire('click');
  const first = els.get('macro-source').value;
  els.get('macro-epsilon').value = '20';
  els.get('macro-epsilon').fire('input');
  assert.equal(hub.recorder.recording, false);
  assert.equal(els.get('macro-epsilon-out').textContent, '20');
  assert.notEqual(els.get('macro-source').value, first);
});

test('the tolerance does nothing when there is no ride to re-emit', async () => {
  const els = stubDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  initMacroPanel(fakeHub(RIDE));
  els.get('macro-source').value = 'await drive(10, 0);';
  els.get('macro-epsilon').value = '20';
  els.get('macro-epsilon').fire('input');
  assert.equal(els.get('macro-source').value, 'await drive(10, 0);');
});

test('a recording cannot start while a run is live', async () => {
  const els = stubDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  const hub = fakeHub(RIDE);
  hub.macro = { get state() { return 'running'; }, run() {}, abort() {} };
  const panel = initMacroPanel(hub);
  panel.showState('running');
  assert.equal(els.get('macro-record').disabled, true);
});

test('stopRecording is on the panel object, and a reason from outside stops it', async () => {
  const els = stubDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  const hub = fakeHub(RIDE);
  const panel = initMacroPanel(hub);
  els.get('macro-record').fire('click');
  panel.stopRecording('collision');
  assert.equal(hub.recorder.recording, false);
  assert.equal(els.get('macro-record').disabled, false);
  assert.match(els.get('macro-source').value, /driveFor/);
});

test('a saved recording is kept, and the next recording opens a slot of its own', async () => {
  const els = stubDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  initMacroPanel(fakeHub(RIDE));
  els.get('macro-record').fire('click');
  els.get('macro-record').fire('click');
  // The unsafe checkbox is a deliberate save, not a keystroke.
  els.get('macro-unsafe').fire('change');
  const saved = JSON.parse(globalThis.localStorage.getItem('lego.macros.v1'));
  assert.equal(saved.length, 1);
  assert.match(saved[0].source, /driveFor/);

  els.get('macro-record').fire('click');
  els.get('macro-record').fire('click');
  const stored = JSON.parse(globalThis.localStorage.getItem('lego.macros.v1'));
  assert.equal(stored.length, 1, 'the second recording is a draft until it is saved too');
});

test('a second recording made while the first is still unsaved cannot land on another macro', async () => {
  const els = stubDom();
  globalThis.localStorage.setItem('lego.macros.v1', JSON.stringify([
    { id: 'm1', name: 'kept', source: 'await drive(10, 0);', allowUnsafe: false, updatedAt: 0 },
  ]));
  const { initMacroPanel } = await import('../src/ui/macros.js');
  initMacroPanel(fakeHub(RIDE));

  els.get('macro-record').fire('click');
  els.get('macro-record').fire('click');

  els.get('macro-select').value = 'm1';
  els.get('macro-select').fire('change');
  assert.equal(els.get('macro-source').value, 'await drive(10, 0);');

  els.get('macro-record').fire('click');
  els.get('macro-record').fire('click');
  els.get('macro-unsafe').fire('change');

  const stored = JSON.parse(globalThis.localStorage.getItem('lego.macros.v1'));
  const kept = stored.find((m) => m.id === 'm1');
  assert.equal(kept.source, 'await drive(10, 0);', 'the recording overwrote a saved macro');
});
