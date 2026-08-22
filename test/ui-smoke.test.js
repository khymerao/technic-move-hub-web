// Smoke test for the UI panels.
//
// `node --check` only parses; it cannot see an identifier that does not exist
// in scope at call time. That exact bug shipped: the motor panel referenced a
// `protocol` local from the wrong closure, which threw ReferenceError inside the
// ready handler and left the app with no motor controls at all.
//
// So this drives each panel through a minimal DOM stub: build it, render its
// rows, and click every button. Anything undefined at call time throws here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initTabs } from '../src/ui/tabs.js';
import { initMotionPanel } from '../src/ui/motion.js';

class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    // Panels write geometry as custom properties and SVG paths as attributes;
    // a bare object would throw on the first setProperty.
    this.attrs = new Map();
    this.style = {
      _p: new Map(),
      setProperty(name, value) { this._p.set(name, String(value)); },
      getPropertyValue(name) { return this._p.get(name) ?? ''; },
      removeProperty(name) { this._p.delete(name); },
    };
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
  append(...kids) { for (const k of kids) if (k instanceof El) this.children.push(k); }
  replaceChildren(...kids) { this.children = kids.filter((k) => k instanceof El); }
  addEventListener(type, fn) { this._events.set(type, fn); }
  removeEventListener(type) { this._events.delete(type); }
  dispatchEvent() { return true; }
  querySelector() { return new El(); }
  getBoundingClientRect() { return { left: 0, width: 100, top: 0, height: 100 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  removeAttribute(name) { this.attrs.delete(name); }
  // The real DOM method, for code that triggers a click on an element it
  // built itself (a download link, a hidden file input) rather than one a
  // user tapped.
  click() { this.fire('click'); }
  // Fire a handler the way the browser would.
  fire(type, ev = {}) {
    const fn = this._events.get(type);
    if (fn) fn({ preventDefault() {}, target: this, detail: {}, ...ev });
  }
  // Every button anywhere under this node.
  buttons() {
    const out = this.tagName === 'BUTTON' ? [this] : [];
    for (const k of this.children) out.push(...k.buttons());
    return out;
  }
  // Every element carrying a change handler — selects, checkboxes, sliders.
  // Clicking buttons alone missed a handler that referenced an unimported
  // symbol and only threw when a dropdown was used.
  changeables() {
    const out = this._events.has('change') ? [this] : [];
    for (const k of this.children) out.push(...k.changeables());
    return out;
  }
  querySelectorAll(sel) {
    const want = sel.replace(/^\./, '').toUpperCase();
    const out = this.tagName === want ? [this] : [];
    for (const k of this.children) out.push(...k.querySelectorAll(sel));
    return out;
  }
}

function installDom() {
  const byId = new Map();
  globalThis.document = {
    createElement: (tag) => new El(tag),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, new El(id.includes('btn') ? 'button' : 'div'));
      return byId.get(id);
    },
    // The drive panel hides and shows its cluster by walking every [data-mode]
    // node, so that one selector has to answer with the elements the test set up.
    querySelectorAll: (sel) => (sel === '[data-mode]'
      ? [...byId.values()].filter((el) => el.dataset.mode != null)
      : []),
    addEventListener() {},
  };
  globalThis.window = { addEventListener() {}, dispatchEvent() {} };
  globalThis.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  // Panels start polling timers; leaving them real keeps the test process alive.
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  return byId;
}

// A protocol stub that records calls instead of talking to a hub.
function stubProtocol() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    roles: { driveA: 0x32, driveB: 0x33, steer: 0x34, led: 0x3f, lights: 0x35 },
    drivePort: null,
    invertedPorts: new Set(),
    setMotorInverted: rec('setMotorInverted'),
    setMotorSpeedRaw: rec('setMotorSpeedRaw'),
    brakeMotor: rec('brakeMotor'),
    driveThrottle: rec('driveThrottle'),
    brakeDrive: rec('brakeDrive'),
    setLed: rec('setLed'),
    setLights: rec('setLights'),
    subscribeToIMU: rec('subscribeToIMU'),
    subscribeToSpeed: rec('subscribeToSpeed'),
    subscribeOrientation: rec('subscribeOrientation'),
    subscribeToPosition: rec('subscribeToPosition'),
    releaseStreams: rec('releaseStreams'),
    unsubscribeTelemetry: rec('unsubscribeTelemetry'),
    requestBattery: rec('requestBattery'),
    writeDirectMode: rec('writeDirectMode'),
    addEventListener() {},
    attachedPorts: [0x32, 0x33],
  };
}

test('every panel builds and survives clicking all of its buttons', async () => {
  installDom();
  const protocol = stubProtocol();
  const hub = { protocol, transport: { queueDepth: 0 }, steering: null, gamepad: null };

  const panels = [
    ['motors', (await import('../src/ui/motors.js')).initMotorPanel],
    ['lamps', (await import('../src/ui/lamps.js')).initLampPanel],
    ['led', (await import('../src/ui/led.js')).initLedPanel],
    ['probe', (await import('../src/ui/probe.js')).initProbePanel],
    ['telemetry', (await import('../src/ui/telemetry.js')).initTelemetryPanel],
  ];

  for (const [name, init] of panels) {
    const panel = init(hub);
    // Panels that render per-device rows expose a build/refresh entry point.
    for (const fn of ['build', 'rebuild', 'render', 'showMode']) {
      if (typeof panel?.[fn] === 'function') panel[fn](protocol.roles);
    }
    const root = document.getElementById(name === 'motors' ? 'motors' : name);
    for (const b of root.buttons()) b.fire('click');
    assert.ok(true, `${name} panel built and handled clicks`);
  }
});

test('motor rows wire the direction toggle without touching an undefined scope', async () => {
  installDom();
  const protocol = stubProtocol();
  const hub = { protocol, transport: { queueDepth: 0 } };
  const panel = (await import('../src/ui/motors.js')).initMotorPanel(hub);
  panel.build(protocol.roles);

  const host = document.getElementById('motors');
  const buttons = host.buttons();
  assert.ok(buttons.length > 0, 'motor rows must render buttons');

  // The regression: clicking the direction toggle threw ReferenceError.
  for (const b of buttons) b.fire('click');
  assert.ok(
    protocol.calls.some(([n]) => n === 'setMotorInverted'),
    'direction toggle must reach protocol.setMotorInverted',
  );
});

test('every select and slider handler survives being used', async () => {
  // Clicking buttons is not enough: a change handler that referenced an
  // unimported symbol threw only when a dropdown was touched, and the failure
  // was swallowed because the handler ran inside an event dispatch.
  const byId = installDom();
  const protocol = stubProtocol();
  // Run every handler twice: once against a healthy controller, once against
  // one that rejects. Error branches are where the swallowed bugs live — a
  // handler whose catch block referenced an unimported symbol passed a
  // happy-path smoke test and threw the moment anything went wrong.
  const healthy = { setDriveMode: async () => {}, params: {}, map: {}, addEventListener() {} };
  const failing = {
    setDriveMode: async () => { throw new Error('init refused'); },
    params: {}, map: {}, addEventListener() {},
  };
  const hub = {
    protocol,
    transport: { queueDepth: 0 },
    steering: null,
    gamepad: healthy,
    playvm: null,
  };

  const inits = [
    (await import('../src/ui/gamepad.js')).initGamepadPanel,
    (await import('../src/ui/motors.js')).initMotorPanel,
    (await import('../src/ui/steering.js')).initSteeringPanel,
    (await import('../src/ui/lamps.js')).initLampPanel,
    (await import('../src/ui/collision.js')).initCollisionPanel,
    (await import('../src/ui/drive-panel.js')).initDrivePanel,
  ];
  for (const init of inits) init(hub, {});

  let fired = 0;
  for (const [id, el] of byId) {
    if (!el._events.has('change') && !el._events.has('input')) continue;
    fired++;
    // A real select carries a value; the stub's default is undefined, which
    // would exercise a different path than the browser does.
    el.value = el.value ?? '0';
    el.fire('change', { target: el });
    el.fire('input', { target: el });
    assert.ok(true, `${id} handled its own event`);
  }
  assert.ok(fired > 0, 'no change/input handlers were found to exercise');

  // Second pass: the controller now rejects, so every catch block runs.
  hub.gamepad = failing;
  const failures = [];
  process.on('unhandledRejection', (e) => failures.push(e));
  for (const [id, el] of byId) {
    if (!el._events.has('change')) continue;
    el.fire('change', { target: el });
    assert.ok(true, `${id} handled a rejecting controller`);
  }
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(failures.map((e) => e.message), [],
    'a handler let a rejection escape instead of reporting it');
});

test('steering mode rejection leaves the select showing the real mode', async () => {
  const byId = installDom();
  const protocol = stubProtocol();
  // A steering controller that rejects on enterSteerMode because the port is busy
  const steering = {
    mode: 'raw',
    enterSteerMode: async () => { throw new Error('port busy'); },
    jogStop: () => {},
  };
  const hub = { protocol, transport: { queueDepth: 0 }, steering };
  const panel = (await import('../src/ui/steering.js')).initSteeringPanel(hub);

  // User tries to switch to steer mode by setting the select value and firing change
  const stMode = document.getElementById('st-mode');
  stMode.value = 'steer';
  stMode.fire('change', { target: stMode });

  // Wait for the async rejection to settle
  await new Promise((r) => setImmediate(r));

  // The select must show the real mode (raw) even though the user picked steer
  assert.equal(stMode.value, 'raw',
    'when enterSteerMode rejects, the select must reflect the real mode');
  // The controller must still be in raw mode
  assert.equal(steering.mode, 'raw',
    'steering mode must remain raw after rejection');
});

test('tabs notify on change, once per change', () => {
  const byId = installDom();
  const bar = document.getElementById('tabbar');
  for (const name of ['drive', 'motion']) {
    const b = new El('button');
    b.dataset.go = name;
    bar.append(b);
  }
  const tabs = initTabs();
  const seen = [];
  tabs.onChange((name) => seen.push(name));

  tabs.show('motion');
  tabs.show('motion');   // the status chip and a double tap both do this
  tabs.show('drive');

  assert.deepEqual(seen, ['motion', 'drive'], 'a repeated show must not re-fire');
  assert.equal(tabs.current(), 'drive');

  // Losing the hub hides the dashboard, so the landing tab must be announced
  // again on the next connect rather than swallowed by the repeat guard.
  tabs.setConnected(false);
  assert.equal(tabs.current(), null);
  tabs.setConnected(true);
  assert.deepEqual(seen, ['motion', 'drive', 'drive'],
    'reconnecting must re-announce the tab the app lands on');
});

test('motion panel arms, renders, re-centres and resets without a hub', async () => {
  installDom();
  const protocol = stubProtocol();
  const hub = { protocol, transport: null, steering: null };
  const panel = initMotionPanel(hub);

  // No orientation yet: centring must say so rather than throw.
  document.getElementById('m-centre').fire('click');

  panel.showOrientation({ values: [0, 0, 0, 16384] });
  assert.match(document.getElementById('m-readout').textContent, /roll 0°/);

  document.getElementById('m-centre').fire('click');
  panel.showOrientation({ values: [0, 0, 0, 16384] });
  assert.match(document.getElementById('m-readout').textContent, /roll 0°/);

  // showSteer is a no-op while the panel is inactive, so it is exercised only
  // once the tab is armed.
  await panel.setActive(true);

  panel.showSteer({ pos: 45, zeroed: true });
  assert.equal(document.getElementById('m-deg').textContent, '45°');
  panel.showSteer({ pos: 45, zeroed: false });
  assert.equal(document.getElementById('m-deg').textContent, '— (set zero in Setup)');

  await panel.setActive(false);
  assert.ok(
    protocol.calls.some(([n, holder]) => n === 'releaseStreams' && holder === 'motion'),
    'leaving the panel must release its streams',
  );
  panel.reset();
  assert.equal(document.getElementById('m-deg').textContent, '—');
});

test('a rejected orientation subscription does not stop the steer subscription', async () => {
  // Regression: arm() used to wrap both subscriptions in one try/catch, so a
  // subscribeOrientation throw (the Debug probe holding the port is the
  // realistic case) skipped subscribeToPosition entirely, leaving the dial
  // dark for a reason unrelated to steering.
  installDom();
  const calls = [];
  const protocol = {
    roles: { steer: 0x34 },
    subscribeOrientation: async () => { throw new Error('port busy'); },
    subscribeToPosition: async (...args) => { calls.push(['subscribeToPosition', ...args]); },
    releaseStreams: async (...args) => { calls.push(['releaseStreams', ...args]); },
  };
  const hub = { protocol, transport: null, steering: null };
  const panel = initMotionPanel(hub);

  await panel.setActive(true);

  assert.ok(
    calls.some(([n, port, delta, holder]) => n === 'subscribeToPosition'
      && port === 0x34 && delta === 15 && holder === 'motion'),
    'the steer-position subscription must still be attempted after an orientation failure',
  );

  await panel.setActive(false);
  assert.ok(
    calls.some(([n, holder]) => n === 'releaseStreams' && holder === 'motion'),
    'leaving the panel must release its streams',
  );
});

// Every element index.html scopes with `data-mode`, with the mode string the
// file actually carries and the element's own markup.
//
// The DOM stub mints an element for any id asked of it, so a test that sets
// `dataset.mode` itself builds the very markup it then asserts on: the cluster
// test used to pass against ids (`d-drive-row`, `d-throttleB-gauge`) that are
// in no HTML file, and deleting `data-mode="independent"` from the real markup
// left it green. Read the shipped attributes instead.
function modeScopedMarkup() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const open = /<(\w+)\s([^>]*\bdata-mode="([^"]*)"[^>]*)>/g;
  const out = [];
  let m;
  while ((m = open.exec(html))) {
    const [, tag, attrs, mode] = m;
    // Walk forward balancing this tag so `inner` is the element's own subtree —
    // without that a mode string matches whatever happens to follow it.
    const scan = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
    scan.lastIndex = open.lastIndex;
    let depth = 1, end = html.length, s;
    while (depth > 0 && (s = scan.exec(html))) {
      depth += s[0][1] === '/' ? -1 : 1;
      if (depth === 0) end = s.index;
    }
    out.push({
      tag, mode,
      id: /\bid="([^"]+)"/.exec(attrs)?.[1] ?? null,
      inner: html.slice(open.lastIndex, end),
    });
  }
  return out;
}

// Mirror those elements into the DOM stub, each carrying the mode string the
// file gave it, and hand back a lookup by any id the element owns. Nodes that
// have an id are the ones the panel itself holds, so they are the same object.
function mountModeScoped() {
  const scoped = modeScopedMarkup();
  assert.ok(scoped.length >= 4, 'index.html must still shape the cluster with data-mode');
  const nodes = new Map();
  for (const el of scoped) {
    const node = document.getElementById(el.id ?? `[data-mode="${el.mode}"] ${el.tag} ${el.inner.length}`);
    node.dataset.mode = el.mode;
    // The markup ships the mode-scoped nodes hidden, so unhiding is observable.
    node.hidden = true;
    nodes.set(el, node);
  }
  return {
    // The innermost scoped element that owns this id — `#d-throttleB` sits
    // inside the scoped drag row, and both answer to it.
    owning(id) {
      const hits = scoped
        .filter((el) => el.id === id || el.inner.includes(`id="${id}"`))
        .sort((a, b) => a.inner.length - b.inner.length);
      assert.ok(hits.length, `index.html no longer scopes #${id} by mode`);
      return nodes.get(hits[0]);
    },
    modeOf(id) {
      const hits = scoped
        .filter((el) => el.id === id || el.inner.includes(`id="${id}"`))
        .sort((a, b) => a.inner.length - b.inner.length);
      return hits[0]?.mode ?? null;
    },
  };
}

// The mode table the panel implements lives in src/ui/drive-panel.js SURFACES;
// the one the markup implements lives in these attributes. Neither is readable
// from the other, so the second is pinned here.
test('index.html scopes the cluster to the modes the panel drives', () => {
  installDom();
  const cluster = mountModeScoped();
  assert.equal(cluster.modeOf('d-throttle'), 'playvm linked independent',
    'the drag row is every mode but tracked');
  assert.equal(cluster.modeOf('d-steer'), 'playvm linked independent',
    'steering rides in the same row');
  assert.equal(cluster.modeOf('d-throttleB'), 'independent',
    'the second throttle control is independent-only');
  assert.equal(cluster.modeOf('d-throttleB-val'), 'independent',
    'and so is its readout — showing one without the other is the gap this pins');
  assert.equal(cluster.modeOf('d-pad'), 'tracked', 'the thumb pad is tracked-only');
  assert.equal(cluster.modeOf('d-trkL'), 'tracked', 'so are the track mirrors');
  assert.equal(cluster.modeOf('d-trkR'), 'tracked');
  assert.equal(cluster.modeOf('d-aux'), 'tracked');
});

// A controller stub that records the touch surface instead of driving motors.
function stubGamepad(driveMode = 'linked') {
  const touch = [];
  return {
    touch,
    controller: {
      params: { driveMode },
      touch: {
        set: (axis, value) => touch.push(['set', axis, value]),
        release: (axis) => touch.push(['release', axis]),
        releaseAll: () => touch.push(['releaseAll']),
      },
      start() {},
      addEventListener() {},
    },
  };
}

test('the drive panel mirrors what was sent and releases what a mode change hides', async () => {
  installDom();
  const protocol = stubProtocol();
  const { touch, controller } = stubGamepad('linked');
  const hub = { protocol, transport: { queueDepth: 0 }, steering: null, gamepad: controller };
  const { initDrivePanel } = await import('../src/ui/drive-panel.js');
  const panel = initDrivePanel(hub);
  await panel.setActive(true);

  // The mode-scoped nodes, read out of index.html rather than invented here.
  const cluster = mountModeScoped();
  const surfaceB = cluster.owning('d-throttleB');
  const gaugeB = cluster.owning('d-throttleB-val');
  const driveRow = cluster.owning('d-throttle');
  const pad = cluster.owning('d-pad');

  // Everything on screen comes from what the loop sent.
  panel.showState({ connected: true, driveMode: 'linked', sent: { driveA: 42, steer: -30 } });
  assert.equal(document.getElementById('d-throttle-val').textContent, '42');
  assert.equal(document.getElementById('d-throttle').style.getPropertyValue('--v'), '42');
  assert.equal(document.getElementById('d-steer').style.getPropertyValue('--v'), '-30');
  assert.ok(document.getElementById('d-dial-fill').getAttribute('d'),
    'the dial must have drawn its fill path');

  // A frame with no input source at all carries no `sent` — that is rest, not a throw.
  panel.showState({ connected: false });
  assert.equal(document.getElementById('d-throttle-val').textContent, '0');
  assert.equal(document.getElementById('d-throttle').style.getPropertyValue('--v'), '0');

  // A finger on the throttle, then a mode change under it: no pointer event is
  // emitted by that, so the panel has to let go by itself.
  document.getElementById('d-throttle').fire('pointerdown', { pointerId: 1, clientX: 50, clientY: 25 });
  assert.deepEqual(touch.at(-1), ['set', 'throttle', 0.5]);
  panel.showMode('independent');
  assert.ok(touch.some(([kind, axis]) => kind === 'release' && axis === 'throttle'),
    'a mode change under a held control must release its axis');

  // Both throttle surfaces belong to independent; showing only one is the gap.
  assert.equal(surfaceB.hidden, false, 'independent must show the second throttle control');
  assert.equal(gaugeB.hidden, false, 'independent must show the second throttle readout');
  assert.equal(driveRow.hidden, false, 'independent still uses the drag row');
  assert.equal(pad.hidden, true, 'the tank pad is tracked-only');

  panel.showMode('linked');
  assert.equal(surfaceB.hidden, true, 'linked has no second throttle');
  assert.equal(gaugeB.hidden, true, 'linked has no second throttle readout either');

  panel.showMode('tracked');
  assert.equal(pad.hidden, false, 'tracked is the mode the thumb pad belongs to');
  assert.equal(cluster.owning('d-trkL').hidden, false, 'tracked shows the track mirrors');
  assert.equal(driveRow.hidden, true, 'tracked replaces the drag row with the pad');
});

// C1: on a phone `navigator.getGamepads()` is empty forever, so the on-screen
// controls are the only thing that ever arms the loop. When the arm switch kept
// its own `running` flag, a touch-armed loop was invisible to it: `disable()`
// returned early, the rAF loop survived STOP ALL and a collision, and the next
// frame re-issued the throttle. The loop owns the flag now and everything else
// mirrors it.
test('a touch-armed loop is armed for the arm switch too, and disable() still ends it', async () => {
  installDom();
  let pending = null;
  globalThis.requestAnimationFrame = (fn) => { pending = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { pending = null; };
  // The phone case: a pad array that never contains a pad. Restored at the end:
  // Node's own `navigator` is getter-only, and leaving the stub in place hands
  // every later test in this file a machine with no gamepads.
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => [] }, configurable: true, writable: true,
  });
  try {
    const protocol = stubProtocol();
    const hub = { protocol, transport: { queueDepth: 0 }, steering: null, gamepad: null };
    const { GamepadController } = await import('../src/gamepad-controller.js');
    const { initGamepadPanel } = await import('../src/ui/gamepad.js');
    const { initDrivePanel } = await import('../src/ui/drive-panel.js');

    // What the wake lock hangs off in src/main.js.
    const runs = [];
    const gp = initGamepadPanel(hub, { onRunChange: (on) => runs.push(on) });
    const panel = initDrivePanel(hub);
    hub.gamepad = new GamepadController(protocol, protocol.roles, null, () => true, null);
    gp.attach(hub.gamepad);
    await panel.setActive(true);

    assert.equal(gp.running, false, 'nothing is armed before a finger lands');

    document.getElementById('d-throttle')
      .fire('pointerdown', { pointerId: 1, clientX: 50, clientY: 25 });
    assert.ok(pending, 'a drag must arm the control loop');
    assert.equal(hub.gamepad.running, true);
    assert.equal(gp.running, true,
      'the arm switch must report a loop armed by a finger, not only one it armed itself');
    assert.deepEqual(runs, [true],
      'arming must be announced whatever armed it — the wake lock hangs off this');

    // STOP ALL, the collision guard, a hidden tab and pad loss all land here.
    gp.disable();
    assert.equal(pending, null, 'disable() must tear down a loop it did not arm');
    assert.equal(hub.gamepad.running, false);
    assert.equal(gp.running, false);
    assert.deepEqual(runs, [true, false], 'disarming must be announced too');

    // And the pad toggle still works, through the same one path.
    document.getElementById('gp-enable').fire('click');
    assert.equal(gp.running, true, 'the pad toggle still arms');
    assert.deepEqual(runs, [true, false, true]);
    document.getElementById('gp-enable').fire('click');
    assert.equal(gp.running, false, 'the pad toggle still disarms');
  } finally {
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
    else delete globalThis.navigator;
  }
});

test('the drive panel arms measured streams on demand and lets everything go on reset', async () => {
  installDom();
  const protocol = stubProtocol();
  const { touch, controller } = stubGamepad('tracked');
  const hub = { protocol, transport: { queueDepth: 0 }, steering: null, gamepad: controller };
  const { initDrivePanel } = await import('../src/ui/drive-panel.js');
  const panel = initDrivePanel(hub);
  await panel.setActive(true);

  const measure = document.getElementById('d-measure');
  measure.fire('click');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(
    protocol.calls.some(([n, , , holder]) => n === 'subscribeOrientation' && holder === 'drive'),
    'the measured toggle must arm orientation under its own holder',
  );
  assert.ok(
    protocol.calls.some(([n, port, delta, holder]) => n === 'subscribeToPosition'
      && port === protocol.roles.steer && delta === 15 && holder === 'drive'),
    'steer position rides at delta 15 under the drive holder',
  );

  panel.showOrientation({ values: [0, 0, 0, 16384] });
  panel.showSteerPos({ pos: 20 });
  assert.match(document.getElementById('d-att').textContent, /roll 0°/);

  // Two axes under one finger on the tank pad, then a stop routed through reset.
  document.getElementById('d-pad').fire('pointerdown', { pointerId: 7, clientX: 100, clientY: 0 });
  assert.ok(touch.some(([kind, axis]) => kind === 'set' && axis === 'tankThrottle'));
  assert.ok(touch.some(([kind, axis]) => kind === 'set' && axis === 'tankTurn'));

  panel.reset();
  assert.ok(touch.some(([kind, axis]) => kind === 'release' && axis === 'tankTurn'),
    'reset must release the axes a finger was holding');
  assert.deepEqual(touch.at(-1), ['releaseAll'], 'reset must clear the whole touch surface');
  // Measuring is still on, so the steer line is still there — with no reading
  // behind it, which is the honest state after a stop.
  assert.match(document.getElementById('d-att').textContent, /^roll — · pitch — · yaw —/);
  assert.match(document.getElementById('d-att').textContent, /steer — \(set zero in Setup\)/);

  // I2: a stop is about writes. It must not switch measuring off behind the
  // user's back — every stop path calls reset(), and nothing re-armed the flag,
  // so five seconds in another app left the panel dark for the session.
  assert.equal(document.getElementById('d-measure').textContent, 'measured: ON',
    'a stop must not silently forget the measured preference');
  assert.ok(
    !protocol.calls.some(([n, holder]) => n === 'releaseStreams' && holder === 'drive'),
    'a stop must not drop a read-only stream it has no way of re-arming',
  );

  // reset() deliberately leaves the panel active: it is still the current tab.
  panel.showState({ connected: true, driveMode: 'tracked', sent: { tankL: 60, tankR: 60 } });
  assert.equal(document.getElementById('d-throttle-val').textContent, '60',
    'a stop must not leave the panel inert');

  // Losing the link is the one case where the subscriptions are meaningless:
  // the protocol and its registry are replaced wholesale. Standing the panel
  // down there is what lets the next link arm it again — the landing tab is
  // re-announced on connect, which re-runs setActive(true).
  panel.reset({ linkLost: true });
  assert.ok(
    protocol.calls.some(([n, holder]) => n === 'releaseStreams' && holder === 'drive'),
    'losing the link must drop the measured streams',
  );
  assert.equal(document.getElementById('d-measure').textContent, 'measured: ON',
    'the preference survives the link, it is the subscriptions that do not');
  protocol.calls.length = 0;
  await panel.setActive(true);
  assert.ok(
    protocol.calls.some(([n, , , holder]) => n === 'subscribeOrientation' && holder === 'drive'),
    'the next link must re-arm the streams the preference still asks for',
  );
});

// I3: the dial and the button have to say the same thing. `pos` is wired to the
// panel unconditionally in src/main.js, so with measuring OFF the fill drew the
// real shaft angle under a button reading OFF — and `lastPos` being 0 rather
// than null from the first frame left the fill greyed as `unzeroed` forever.
test('the dial shows nothing measured while the measured toggle is off', async () => {
  installDom();
  const protocol = stubProtocol();
  const { controller } = stubGamepad('linked');
  const steering = { params: { maxAngle: 90 }, mode: 'steer', isZeroed: true };
  const hub = { protocol, transport: { queueDepth: 0 }, steering, gamepad: controller };
  const { initDrivePanel } = await import('../src/ui/drive-panel.js');
  const { arcPath } = await import('../src/ui/dial.js');
  const panel = initDrivePanel(hub);
  await panel.setActive(true);
  panel.showMode('linked');

  const fill = document.getElementById('d-dial-fill');
  panel.showSteerPos({ pos: 45 });
  assert.equal(fill.getAttribute('d'), arcPath(0, 0),
    'measured OFF must draw no measured arc, whatever the stream says');
  assert.equal(fill.classList.contains('unzeroed'), false,
    'a reading nobody asked for must not grey the dial either');

  document.getElementById('d-measure').fire('click');
  await new Promise((r) => setImmediate(r));
  panel.showSteerPos({ pos: 45 });
  assert.equal(fill.getAttribute('d'), arcPath(0, 50),
    'measured ON must draw the shaft angle it just armed the stream for');
});

// The minor behind I3: independent routes the steer motor through the steering
// controller exactly like linked (src/gamepad-controller.js #poll()), so the
// measurement is real there and the dial used to throw it away.
test('the dial keeps its measured fill in independent, which has feedback like linked', async () => {
  installDom();
  const protocol = stubProtocol();
  const { controller } = stubGamepad('independent');
  const steering = { params: { maxAngle: 90 }, mode: 'steer', isZeroed: true };
  const hub = { protocol, transport: { queueDepth: 0 }, steering, gamepad: controller };
  const { initDrivePanel } = await import('../src/ui/drive-panel.js');
  const { arcPath } = await import('../src/ui/dial.js');
  const panel = initDrivePanel(hub);
  await panel.setActive(true);
  document.getElementById('d-measure').fire('click');
  await new Promise((r) => setImmediate(r));

  panel.showMode('independent');
  panel.showSteerPos({ pos: 45 });
  assert.equal(document.getElementById('d-dial-fill').getAttribute('d'), arcPath(0, 50),
    'independent measures the rack too — the dial must show it');

  // tracked is the one mode where the steer motor is a free axis: raw power off
  // its own stick, and the dial's command is power rather than an angle.
  panel.showMode('tracked');
  panel.showSteerPos({ pos: 45 });
  assert.equal(document.getElementById('d-dial-fill').getAttribute('d'), arcPath(0, 0),
    'tracked jogs the steer motor raw — there is no angle to fill with');
});

test('a lost feedback stream greys the dial with no stale number', async () => {
  // The controller now resets #zeroed on feedback-lost as well as on runaway
  // (src/steering-controller.js), but the panel-side listener still passes
  // zeroed explicitly rather than trusting a cached isZeroed — this pins the
  // panel's own behaviour regardless of where the flag comes from.
  installDom();
  const protocol = stubProtocol();
  const hub = { protocol, transport: null, steering: null };
  const panel = initMotionPanel(hub);
  await panel.setActive(true);

  panel.showSteer({ pos: 30, zeroed: true });
  assert.equal(document.getElementById('m-deg').textContent, '30°');

  // What src/main.js's feedback-lost listener now does: tell the dial the
  // stream is no longer trustworthy, reusing showSteer rather than a new API.
  panel.showSteer({ pos: 30, zeroed: false });
  assert.equal(document.getElementById('m-deg').textContent, '— (set zero in Setup)');
});

// The Macros tab is entirely static markup ($()-driven, nothing appended
// dynamically), so it is exercised by id rather than by the buttons()/
// changeables() tree walk the other panels use.
function fakeMacroHost() {
  const calls = [];
  return {
    calls,
    state: 'idle',
    async run(source, options) { calls.push(['run', source, options]); },
    abort(reason) { calls.push(['abort', reason]); },
  };
}

test('macros panel: every control survives, and Run is gated on hub.macro', async () => {
  const byId = installDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');

  const hub = {};
  const panel = initMacroPanel(hub);

  const el = (id) => byId.get(id);
  const click = (id) => el(id).fire('click');
  const change = (id) => el(id).fire('change', { target: el(id) });
  const input = (id) => el(id).fire('input', { target: el(id) });

  // No hub.macro yet: Run must be a silent no-op, not a crash.
  click('macro-run');
  click('macro-stop');

  click('macro-new');
  el('macro-source').value = 'drive(40, 0);';
  input('macro-source');
  change('macro-unsafe');
  change('macro-select');
  click('macro-export');
  click('macro-import');

  // Every state the host can report, plus the elapsed/print readouts, driven
  // directly the way main.js's onState/onPrint wiring drives them.
  panel.showState('arming');
  panel.showElapsed(1234);
  panel.showState('running');
  panel.showPrint(['hi', 1]);
  panel.showState('stopping');
  // The host's onNotice, driven the way main.js drives it: the arming switch
  // reports on the same status line, without leaving the running state.
  panel.showNotice('arming combined frame — the steering rack will sweep…');
  assert.equal(el('macro-status').textContent,
    'arming combined frame — the steering rack will sweep…',
    'the arming notice must reach the status line');
  panel.showState('failed', {
    name: 'ReferenceError', message: 'nope is not defined',
    stack: 'ReferenceError: nope is not defined\n    at eval (<anonymous>:4:1)',
  });
  panel.showState('idle');
  assert.equal(el('macro-status').textContent, 'error at line 2: nope is not defined',
    'the AsyncFunction preamble (2 lines) must be subtracted from the reported line');

  // Now with hub.macro present, Run and Stop must actually reach it.
  hub.macro = fakeMacroHost();
  panel.showState('idle'); // repaints Run now that hub.macro exists
  click('macro-run');
  assert.ok(hub.macro.calls.some(([kind]) => kind === 'run'), 'Run must call hub.macro.run');
  click('macro-stop');
  assert.ok(hub.macro.calls.some(([kind]) => kind === 'abort'), 'Stop must call hub.macro.abort');

  // An import declaring allowUnsafe:true must still land unchecked.
  el('macro-import-file').files = [{
    text: async () => JSON.stringify({
      version: 1,
      macros: [{ id: 'imported', name: 'evil', source: '', allowUnsafe: true, updatedAt: 1 }],
    }),
  }];
  change('macro-import-file');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(el('macro-unsafe').checked, false,
    'an import claiming allowUnsafe:true must land with the checkbox off');

  click('macro-delete');

  // Flush the autosave debounce so no timer is left pending past the test.
  await new Promise((r) => setTimeout(r, 450));
});

test('macros panel: switching slot inside the autosave debounce does not lose the edit', async () => {
  const byId = installDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  const { createMacroStore } = await import('../src/macro/store.js');
  const store = createMacroStore(localStorage);
  const el = (id) => byId.get(id);

  initMacroPanel({});
  el('macro-new').fire('click');
  el('macro-new').fire('click');
  const ids = store.list().map((m) => m.id);
  assert.equal(ids.length, 2);
  const editing = el('macro-select').value;
  const other = ids.find((id) => id !== editing);

  el('macro-source').value = 'await drive(40, 0);';
  el('macro-source').fire('input', { target: el('macro-source') });

  // The slot changes before the 400ms debounce comes due.
  el('macro-select').value = other;
  el('macro-select').fire('change', { target: el('macro-select') });

  assert.equal(store.list().find((m) => m.id === editing).source, 'await drive(40, 0);',
    'macro text is the user\'s only artefact and there is no undo');

  await new Promise((r) => setTimeout(r, 450)); // no timer left pending
});

test('macros panel: a run that never starts says why instead of sticking on starting…', async () => {
  const byId = installDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  const hub = {
    macro: {
      state: 'idle',
      run: async () => { throw new Error('a macro is already running'); },
      abort() {},
    },
  };
  initMacroPanel(hub);
  byId.get('macro-run').fire('click');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.match(byId.get('macro-status').textContent, /already running/,
    'a rejected run must paint its message, not leave the panel lying');
});

test('macros panel: the reason a run stopped is shown, not just idle', async () => {
  const byId = installDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  const panel = initMacroPanel({});

  const runThrough = (reason) => {
    panel.showState('arming');
    panel.showState('running');
    panel.showState('stopping');
    panel.showState('idle', reason);
  };

  runThrough('low signal');
  assert.equal(byId.get('macro-status').textContent, 'stopped: low signal',
    'after a car stops itself the operator needs to know whether the link is dying');

  runThrough('finished');
  assert.equal(byId.get('macro-status').textContent, 'idle', 'a clean finish still reads idle');

  // A script error still wins: its line number is the more useful message.
  panel.showState('arming');
  panel.showState('running');
  panel.showState('stopping');
  panel.showState('failed', {
    name: 'Error', message: 'nope', stack: 'Error: nope\n    at eval (<anonymous>:4:1)',
  });
  panel.showState('idle', 'error: nope');
  assert.equal(byId.get('macro-status').textContent, 'error at line 2: nope');

  // A macro that changed the drive mode ends with the mode named. A clean run
  // must not read as a fault just because the note is there.
  runThrough('finished — drive mode left as raw');
  assert.equal(byId.get('macro-status').textContent, 'idle — drive mode left as raw',
    'a clean finish that changed the mode is not a stop');

  runThrough('low signal — drive mode left as playvm');
  assert.equal(byId.get('macro-status').textContent,
    'stopped: low signal — drive mode left as playvm',
    'a stop still reads as a stop, and still says which mode the car was left in');
});

// The host composes the run-end reason as one string and the panel decodes it
// by matching the 'finished —' prefix. One test has to see both halves: two
// tests each pinning their own half would still let the two drift apart.
test('macros panel: the host\'s own run-end reason renders as a finish, not a stop', async () => {
  const byId = installDom();
  const { initMacroPanel } = await import('../src/ui/macros.js');
  const { createMacroHost } = await import('../src/macro/host.js');

  const worker = {
    postMessage() {},
    terminate() {},
    onmessage: null,
    emit(msg) { this.onmessage?.({ data: msg }); },
  };
  const hub = {
    playvm: { armed: true, set() {}, stop() {} },
    steering: { stop() {} },
    gamepad: { async setDriveMode(name) { hub.playvm.armed = name === 'playvm'; } },
    protocol: {
      roles: { driveA: 0x32, driveB: 0x33, steer: 0x34 },
      setMotorSpeedRaw: async () => {},
      brakeDrive: async () => {},
      releaseStreams: async () => {},
    },
  };

  const panel = initMacroPanel(hub);
  let endReason = null;
  hub.macro = createMacroHost(hub, {
    spawnWorker: () => worker,
    // main.js's wiring: whatever the host composes is what the panel is handed.
    onState: (state, detail) => {
      if (state === 'idle') endReason = detail;
      panel.showState(state, detail);
    },
    onPrint: (args) => panel.showPrint(args),
  });

  await hub.macro.run('', { allowUnsafe: false });
  worker.emit({ kind: 'call', id: 1, method: 'mode', args: ['raw'] });
  await new Promise((r) => setTimeout(r, 200));
  worker.emit({ kind: 'done' });
  await new Promise((r) => setImmediate(r));

  assert.equal(endReason, 'finished — drive mode left as raw',
    'the separator the panel matches on is half of a contract; rewording it here must fail here');
  const status = byId.get('macro-status').textContent;
  assert.ok(!status.startsWith('stopped:'),
    `a clean finish must not read as a stop; the panel got ${JSON.stringify(endReason)}`);
  assert.equal(status, 'idle — drive mode left as raw',
    'the string the host actually composed has to render as an idle finish in the real panel');
});

test('macro help panel: search, insert at caret, examples, unsafe gating', async () => {
  installDom();
  const { initMacroHelp } = await import('../src/ui/macro-help.js');
  const { METHOD_NAMES } = await import('../src/macro/api-spec.js');

  const el = (id) => document.getElementById(id);
  const source = el('macro-source');
  const unsafeBox = el('macro-unsafe');
  const search = el('macro-search');
  const list = el('macro-method-list');

  source.value = 'AB';
  source.selectionStart = 1;
  source.selectionEnd = 1;
  unsafeBox.checked = false;
  // The stub has no focus(); the panel's call is optional for that reason.
  let focused = 0;
  source.focus = () => { focused++; };
  // The stub's El defaults `value` to '0' (test/ui-smoke.test.js:22) and
  // getElementById auto-creates, so the search box must be emptied explicitly
  // or the first render filters on the query "0".
  search.value = '';

  const made = [];
  let inserts = 0;
  const help = initMacroHelp({
    source, unsafeBox,
    onInsert: () => { inserts++; },
    onExample: (name, src) => made.push([name, src]),
  });
  help.render();

  const rows = () => list.children.filter((n) => n.dataset?.method);
  const safeCount = METHOD_NAMES.filter((n) => !n.startsWith('unsafe.')).length;

  // unsafe is off: no unsafe row is offered
  assert.equal(rows().some((r) => r.dataset.method.startsWith('unsafe.')), false,
    'unsafe methods must not be listed while the checkbox is off');
  assert.equal(rows().length, safeCount);

  // rendering twice must not duplicate rows
  help.render();
  assert.equal(rows().length, safeCount, 'render() replaces the list, it does not append');

  // unsafe on: all eight appear
  unsafeBox.checked = true;
  unsafeBox.fire('change', { target: unsafeBox });
  assert.equal(rows().filter((r) => r.dataset.method.startsWith('unsafe.')).length, 8);

  // search filters, matching the name or the hint
  search.value = 'brake';
  search.fire('input', { target: search });
  assert.ok(rows().length > 0 && rows().length < METHOD_NAMES.length);
  assert.ok(rows().some((r) => r.dataset.method === 'brakeAll'));

  // clicking inserts at the caret, not at the end, and reports the edit
  search.value = '';
  search.fire('input', { target: search });
  rows().find((r) => r.dataset.method === 'drive').fire('click');
  assert.equal(source.value, 'Aawait drive(40, 0);B', 'the snippet lands at the caret');
  assert.equal(inserts, 1, 'insertion must tell the editor so autosave runs');
  // Focus left on the row means typing goes nowhere near the caret just set,
  // and Space — the next keystroke — inserts the snippet a second time.
  assert.equal(focused, 1, 'insertion must hand focus back to the editor');

  // an example creates a slot rather than overwriting the editor
  el('macro-examples').children[0].fire('click');
  assert.equal(made.length, 1);
  assert.ok(made[0][1].startsWith('//'), 'examples open with a comment explaining them');

  // render() reflects the checkbox even when nothing fired a change event —
  // loadCurrent() unticks it programmatically when a slot is loaded
  unsafeBox.checked = false;
  help.render();
  assert.equal(rows().some((r) => r.dataset.method.startsWith('unsafe.')), false,
    'a programmatic untick must not leave unsafe rows listed');

  // the hidden-count line explains the gap rather than leaving a dead end
  assert.ok(el('macro-hidden').textContent.includes('8'),
    'hiding eight methods must be stated, not silent');
  unsafeBox.checked = true;
  help.render();
  assert.equal(el('macro-hidden').textContent, '');
});

// A help panel built the way the app builds it: through initMacroPanel, with
// no hand-called render() anywhere. Calling render() by hand proves only that
// render() reads the checkbox, which was never the thing at risk.
function seedMacroPanelDom(byId, macros, storeKey) {
  if (macros) localStorage.setItem(storeKey, JSON.stringify(macros));
  // El.value defaults to '0' (:22) and getElementById auto-creates, so an
  // untouched search box filters the first render on the query "0".
  document.getElementById('macro-search').value = '';
  const el = (id) => byId.get(id);
  const rows = () => el('macro-method-list').children.filter((n) => n.dataset?.method);
  return { el, rows };
}

test('macros panel: loading a slot re-renders the method list, not just the checkbox', async () => {
  const byId = installDom();
  const { MACRO_STORE_KEY } = await import('../src/macro/store.js');
  const { initMacroPanel } = await import('../src/ui/macros.js');

  // Two slots; the names sort so that the safe one is the one that opens.
  const { el, rows } = seedMacroPanelDom(byId, [
    { id: 'safe', name: 'a careful one', source: '', allowUnsafe: false, updatedAt: 1 },
    { id: 'risky', name: 'b reckless one', source: '', allowUnsafe: true, updatedAt: 2 },
  ], MACRO_STORE_KEY);

  initMacroPanel({});

  const unsafeRows = () => rows().filter((r) => r.dataset.method.startsWith('unsafe.'));
  assert.ok(rows().length > 0, 'the panel must render the method list as it is built');
  assert.equal(unsafeRows().length, 0, 'the slot that opens does not allow unsafe');

  // Switching slots is the only thing that moves the checkbox without firing a
  // change event, so it is the only thing that can leave the list stale.
  el('macro-select').value = 'risky';
  el('macro-select').fire('change', { target: el('macro-select') });

  assert.equal(el('macro-unsafe').checked, true, 'the slot allows unsafe');
  assert.equal(unsafeRows().length, 8,
    'a slot saved with unsafe on must list the methods that slot is allowed to call');

  await new Promise((r) => setTimeout(r, 450)); // no timer left pending
});

test('macros panel: an example that cannot be saved says so instead of throwing', async () => {
  const byId = installDom();
  const { MACRO_STORE_KEY } = await import('../src/macro/store.js');
  const { initMacroPanel } = await import('../src/ui/macros.js');

  const { el } = seedMacroPanelDom(byId, [
    { id: 'only', name: 'only', source: 'await wait(1);', allowUnsafe: false, updatedAt: 1 },
  ], MACRO_STORE_KEY);
  initMacroPanel({});

  // An edit still inside the debounce, so the example click has one to flush …
  el('macro-source').value = 'await wait(2);';
  el('macro-source').fire('input', { target: el('macro-source') });
  // … into a quota that has since filled up.
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };

  el('macro-examples').children[0].fire('click');

  assert.match(el('macro-status').textContent, /^could not save:/,
    'a full quota must reach the status line, not escape the click handler');
});

test('macros panel: an example lands in a new slot and leaves the open one alone', async () => {
  const byId = installDom();
  const { createMacroStore } = await import('../src/macro/store.js');
  const { initMacroPanel } = await import('../src/ui/macros.js');
  const store = createMacroStore(localStorage);

  const { el } = seedMacroPanelDom(byId, null, null);
  initMacroPanel({});
  el('macro-new').fire('click');
  const mine = el('macro-select').value;
  el('macro-source').value = 'await led(3);';
  el('macro-source').fire('input', { target: el('macro-source') });

  el('macro-examples').children[0].fire('click');

  assert.equal(store.list().length, 2, 'an example adds a slot, it does not overwrite one');
  assert.equal(store.list().find((m) => m.id === mine).source, 'await led(3);',
    'the edit in the open slot must survive the switch');
  assert.notEqual(el('macro-select').value, mine, 'the example is the slot now on screen');
  assert.ok(el('macro-source').value.startsWith('//'), 'the editor shows the example');

  await new Promise((r) => setTimeout(r, 450)); // no timer left pending
});

test('macro help panel: the hidden-unsafe line counts only what the search would show', async () => {
  installDom();
  const { initMacroHelp } = await import('../src/ui/macro-help.js');

  const el = (id) => document.getElementById(id);
  const source = el('macro-source');
  const unsafeBox = el('macro-unsafe');
  const search = el('macro-search');
  const hidden = el('macro-hidden');
  source.value = '';
  unsafeBox.checked = false;
  search.value = '';

  const help = initMacroHelp({ source, unsafeBox, onInsert() {}, onExample() {} });
  help.render();
  assert.match(hidden.textContent, /^8 unsafe methods hidden/,
    'with no query all eight are hidden');

  // No unsafe method matches 'brake' by name or by hint, so ticking the box
  // would add nothing to this list.
  search.value = 'brake';
  search.fire('input', { target: search });
  assert.equal(hidden.textContent, '',
    'the line must not promise rows that ticking unsafe would not produce');

  // Exactly one match, so the noun has to agree with the count.
  search.value = 'gotoPosition';
  search.fire('input', { target: search });
  assert.equal(hidden.textContent, '1 unsafe method hidden — tick unsafe to show them');
});

test('macro help panel: search reads the hint too, folds case, and rows carry their badge', async () => {
  installDom();
  const { initMacroHelp } = await import('../src/ui/macro-help.js');

  const el = (id) => document.getElementById(id);
  const source = el('macro-source');
  const unsafeBox = el('macro-unsafe');
  const search = el('macro-search');
  const list = el('macro-method-list');
  source.value = '';
  unsafeBox.checked = true;
  search.value = '';

  const help = initMacroHelp({ source, unsafeBox, onInsert() {}, onExample() {} });
  help.render();

  const rows = () => list.children.filter((n) => n.dataset?.method);
  const names = () => rows().map((r) => r.dataset.method);
  const row = (name) => rows().find((r) => r.dataset.method === name);
  const badge = (name) => row(name).children.find((k) => (k.className ?? '').includes('macro-path'));

  // 'percentage' is in no method name at all — only in battery()'s hint.
  search.value = 'percentage';
  search.fire('input', { target: search });
  assert.deepEqual(names(), ['battery'],
    'a search on what a method does must find it, not only a search on its name');

  search.value = 'BRAKE';
  search.fire('input', { target: search });
  assert.ok(names().includes('brakeAll'), 'a typed capital must not empty the list');

  search.value = '';
  search.fire('input', { target: search });
  assert.equal(badge('drive').textContent, 'playvm', 'the combined frame is named on the row');
  assert.equal(badge('motorFor').textContent, 'raw', 'the raw path is named on the row');
  assert.equal(badge('unsafe.raw').textContent, 'unsafe');
  assert.ok(badge('unsafe.raw').className.includes('macro-danger'),
    'an unsafe row must be marked as dangerous, not merely labelled');
  assert.equal(badge('drive').className.includes('macro-danger'), false,
    'a safe row must not be dressed as a dangerous one');
  assert.equal(row('wait').children.some((k) => (k.className ?? '').includes('macro-path')), false,
    'a method belonging to no drive path carries no badge');
});
