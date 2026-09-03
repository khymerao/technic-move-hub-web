// The Drive instrument panel: on-screen controls that feed the loop's touch
// surface, mirrors of the values the loop actually sent, and measured data
// behind an explicit toggle.
//
// See docs/superpowers/specs/2026-07-31-drive-instrument-panel-design.md

import { $, setToggle } from './dom.js';
import { createDial } from './dial.js';
import { loadDriveMode } from '../gamepad-controller.js';
import {
  quatFromOrint, quatHubToScene, eulerSceneFromQuat, alignSign,
} from '../orientation.js';

const HOLDER = 'drive';
const MEASURE_KEY = 'drive.measure';
const ORINT_MODE = 0x00;
const ORINT_DELTA = 40;
// Must equal the P-loop's delta or sharing the stream rewrites it.
// See src/steering-controller.js enterSteerMode()
const STEER_DELTA = 15;

const ATT_REST = 'roll — · pitch — · yaw —';

// Which drag surfaces command something in each mode.
// See docs/superpowers/specs/2026-07-31-drive-instrument-panel-design.md § Mode adaptation
const SURFACES = {
  playvm: ['throttle', 'steer'],
  linked: ['throttle', 'steer'],
  independent: ['throttle', 'throttleB', 'steer'],
  tracked: ['pad'],
};

const clamp = (v, lo = -100, hi = 100) => Math.max(lo, Math.min(hi, v));
const finite = (v) => (Number.isFinite(v) ? v : 0);

// The stylesheet owns the geometry; the panel writes one number per control.
// See styles.css § Drive instrument panel
const setVar = (el, name, v) => el.style.setProperty(name, String(Math.round(clamp(v))));

// The stick position behind a tank mix, recovered from the two track values.
// See src/gamepad-map.js tankMix()
function unmix(left, right) {
  const ts = (left + right) / 2, ss = (left - right) / 2;
  const greater = Math.max(Math.abs(ts), Math.abs(ss));
  const lesser = Math.min(Math.abs(ts), Math.abs(ss));
  const saturated = greater > 0 ? (lesser / greater) + 1 : 1;
  return { throttle: clamp(ts * saturated), turn: clamp(ss * saturated) };
}

export function initDrivePanel(hub) {
  const warn = $('d-warn');
  const throttleEl = $('d-throttle'), throttleBEl = $('d-throttleB'), steerEl = $('d-steer');
  const padEl = $('d-pad');
  const throttleVal = $('d-throttle-val'), throttleBVal = $('d-throttleB-val');
  const steerVal = $('d-steer-val');
  const fill = $('d-dial-fill'), bug = $('d-dial-bug');
  const trkL = $('d-trkL'), trkR = $('d-trkR'), aux = $('d-aux');
  const measureBtn = $('d-measure'), note = $('d-measure-note'), att = $('d-att');
  const dial = createDial({ fill, bug });

  let active = false;
  let mode = null;
  let measured = loadMeasure();
  let lastSent = {};
  let lastPos = null;
  let lastQ = null;

  function loadMeasure() {
    try { return localStorage.getItem(MEASURE_KEY) === '1'; }
    catch { return false; }
  }

  // Reversing the combined frame. Stored, because it describes how the model is
  // built and not how this drive is going, and pushed onto every controller as
  // it is built — the controller is replaced on each reconnect and knows nothing
  // the panel has not told it.
  // See docs/DESIGN-NOTES.md § The combined frame carries its own inversion
  const invert = { speed: false, steer: false };
  const invertToggle = (id, key, label) => {
    const btn = $(id);
    if (!btn) return;
    const storeKey = `drive.invert.${key}`;
    try { invert[key] = localStorage.getItem(storeKey) === '1'; } catch { /* ignore */ }
    const paint = () => {
      btn.textContent = `${label}: ${invert[key] ? 'REVERSED' : 'NORMAL'}`;
      setToggle(btn, invert[key]);
    };
    btn.addEventListener('click', () => {
      invert[key] = !invert[key];
      try { localStorage.setItem(storeKey, invert[key] ? '1' : '0'); } catch { /* ignore */ }
      paint();
      applyInvert();
    });
    paint();
  };
  invertToggle('gp-inv-speed', 'speed', 'throttle');
  invertToggle('gp-inv-steer', 'steer', 'steering');

  function applyInvert() {
    if (hub.playvm) hub.playvm.invert = { ...invert };
  }

  const set = (axis, value) => hub.gamepad?.touch.set(axis, value);
  const rel = (axis) => hub.gamepad?.touch.release(axis);
  // Both are null before connect and replaced wholesale on reconnect.
  // See docs/DESIGN-NOTES.md § Panels read the hub at event time
  const zeroedNow = () => hub.steering?.isZeroed ?? false;

  // Pointer position on a control, −1…1 with y up, clamped to its range: a
  // finger dragged past the end keeps commanding the end.
  // See docs/superpowers/specs/2026-07-31-drive-instrument-panel-design.md § Release — the failsafe, corrected
  function at(e, el) {
    const r = el.getBoundingClientRect();
    const x = r.width ? ((finite(e.clientX) - r.left) / r.width) * 2 - 1 : 0;
    const y = r.height ? 1 - ((finite(e.clientY) - r.top) / r.height) * 2 : 0;
    return { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
  }

  // One drag surface. There is no `pointerleave` listener and no hold timer.
  function surface(el, onMove, onRelease) {
    let pointer = null;
    let enabled = false;
    const release = () => {
      if (pointer === null) return;
      pointer = null;
      onRelease();
    };
    el.addEventListener('pointerdown', (e) => {
      if (!enabled) return;
      e.preventDefault?.();
      // Touch captures implicitly; a mouse does not, and an uncaptured mouse
      // drag off the control would strand the axis at its last value.
      try { el.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }
      pointer = e.pointerId ?? 0;
      hub.gamepad?.start?.();
      onMove(at(e, el));
    });
    el.addEventListener('pointermove', (e) => {
      if (pointer === null || pointer !== (e.pointerId ?? 0)) return;
      onMove(at(e, el));
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      el.addEventListener(type, release);
    }
    return {
      release,
      enable(on) { if (!on) release(); enabled = on; },
    };
  }

  const controls = {
    throttle: surface(throttleEl, (p) => set('throttle', p.y), () => rel('throttle')),
    throttleB: surface(throttleBEl, (p) => set('throttleB', p.y), () => rel('throttleB')),
    steer: surface(steerEl, (p) => set('steer', p.x), () => rel('steer')),
    pad: surface(padEl, (p) => { set('tankThrottle', p.y); set('tankTurn', p.x); },
      () => { rel('tankThrottle'); rel('tankTurn'); }),
  };

  function releaseAll() {
    for (const c of Object.values(controls)) c.release();
    hub.gamepad?.touch.releaseAll();
  }

  function needsInvert() {
    const p = hub.protocol;
    const inverted = p?.invertedPorts ?? new Set();
    return ![p?.roles?.driveA, p?.roles?.driveB]
      .some((port) => port != null && inverted.has(port));
  }

  function renderCluster(next) {
    if (next === mode) return;
    // A mode change under a held finger produces no pointer event at all.
    for (const c of Object.values(controls)) c.enable(false);
    mode = next;
    for (const el of document.querySelectorAll('[data-mode]')) {
      el.hidden = !String(el.dataset.mode ?? '').split(' ').includes(mode);
    }
    for (const key of SURFACES[mode] ?? SURFACES.linked) controls[key].enable(true);
    const invertWarning = mode === 'tracked' && needsInvert();
    warn.textContent = invertWarning
      ? 'tracked: set a drive motor to REVERSED in Setup — turn and throttle are swapped without it'
      : '';
    warn.hidden = !invertWarning;
    lastSent = {};
    paint();
  }

  // Everything on screen comes from what the loop sent, never from a raw axis.
  function paint() {
    const s = lastSent;
    let throttle = 0, throttleB = 0, steerCmd = 0, x = 0, y = 0;
    let left = 0, right = 0, steerAux = 0;
    if (mode === 'playvm') {
      throttle = s.playvmSpeed ?? 0;
      steerCmd = s.playvmSteer ?? 0;
    } else if (mode === 'tracked') {
      left = s.tankL ?? 0;
      right = s.tankR ?? 0;
      steerAux = s.steer ?? 0;
      const stick = unmix(left, right);
      throttle = stick.throttle;
      y = stick.throttle;
      x = stick.turn;
      steerCmd = steerAux;
    } else {
      throttle = s.driveA ?? 0;
      throttleB = s.driveB ?? 0;
      steerCmd = s.steer ?? 0;
    }

    throttleVal.textContent = String(Math.round(throttle));
    throttleBVal.textContent = String(Math.round(throttleB));
    setVar(throttleEl, '--v', throttle);
    setVar(throttleBEl, '--v', throttleB);
    setVar(steerEl, '--v', steerCmd);
    setVar(padEl, '--x', x);
    setVar(padEl, '--y', y);
    setVar(trkL, '--v', left);
    setVar(trkR, '--v', right);
    setVar(aux, '--v', steerAux);
    paintSteer(steerCmd);
  }

  // The steering command in the current mode, for a repaint driven by a
  // measurement rather than by a frame.
  function lastCommand() {
    if (mode === 'playvm') return lastSent.playvmSteer ?? 0;
    return lastSent.steer ?? 0;
  }

  // The measured angle is the fill, the command is the bug. The command is an
  // angle only in closed-loop steer mode; elsewhere it is motor power.
  function paintSteer(cmd) {
    const maxAngle = hub.steering?.params?.maxAngle || 90;
    // Every mode but `tracked` puts the steer motor through the steering
    // controller, so the shaft angle is a real reading in `independent` too.
    // In `tracked` the steer motor is an auxiliary jogged as raw power and the
    // dial's command is that power, not an angle.
    // See src/gamepad-controller.js #poll() — the steering branch
    const feedback = mode !== 'tracked';
    const zeroed = zeroedNow();
    // The measured toggle governs everything measured, the fill included. The
    // position stream is wired up whether or not it is armed, so without this
    // the dial drew a real angle under a button that read OFF.
    const known = measured && feedback && lastPos != null;
    fill.classList.toggle('unzeroed', known && !zeroed);
    dial.show({
      measured: known && zeroed ? lastPos : null,
      commanded: (cmd / 100) * maxAngle,
      maxAngle,
    });
    steerVal.textContent = hub.steering?.mode === 'steer'
      ? `${Math.round((cmd / 100) * maxAngle)}°`
      : String(Math.round(cmd));
  }

  function paintAttitude() {
    const e = lastQ ? eulerSceneFromQuat(lastQ) : null;
    const head = e
      ? `roll ${Math.round(e.roll)}° · pitch ${Math.round(e.pitch)}° · yaw ${Math.round(e.yaw)}°`
      : ATT_REST;
    const steerLine = measured
      ? `\nsteer ${zeroedNow() && lastPos != null ? `${Math.round(lastPos)}°` : '— (set zero in Setup)'}`
      : '';
    att.textContent = head + steerLine;
  }

  function paintMeasure() {
    measureBtn.textContent = `measured: ${measured ? 'ON' : 'OFF'}`;
    setToggle(measureBtn, measured);
  }

  // acquire() throws when the port is already streaming another mode, and each
  // failure is reported separately.
  // See docs/ARCHITECTURE.md § 7. A port streams ONE input mode at a time
  async function arm() {
    const p = hub.protocol;
    if (!p) return;
    const errors = [];
    try {
      await p.subscribeOrientation(ORINT_MODE, ORINT_DELTA, HOLDER);
    } catch (err) {
      errors.push(`orientation: ${err.message}`);
    }
    try {
      if (p.roles?.steer != null) {
        await p.subscribeToPosition(p.roles.steer, STEER_DELTA, HOLDER);
      }
    } catch (err) {
      errors.push(`steer: ${err.message}`);
    }
    note.textContent = errors.length ? `stream unavailable: ${errors.join('; ')}` : '';
  }

  async function disarm() {
    await hub.protocol?.releaseStreams(HOLDER);
  }

  measureBtn.addEventListener('click', async () => {
    measured = !measured;
    try { localStorage.setItem(MEASURE_KEY, measured ? '1' : '0'); } catch { /* ignore */ }
    paintMeasure();
    if (measured) {
      if (active) await arm();
    } else {
      note.textContent = '';
      lastPos = null;
      lastQ = null;
      paintAttitude();
      paint();
      await disarm();
    }
  });

  // A hidden tab and a lost window are releases; neither emits a pointer event.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseAll();
  });
  window.addEventListener('blur', () => releaseAll());

  paintMeasure();
  paintAttitude();
  renderCluster(hub.gamepad?.params?.driveMode ?? loadDriveMode());

  return {
    applyInvert,

    async setActive(on) {
      if (on === active) return;
      active = on;
      if (on) { if (measured) await arm(); }
      else { releaseAll(); await disarm(); }
    },

    // A stop lets go of the controls and forgets what was on screen. It does
    // NOT touch the measured preference or its streams: measuring is a read,
    // stopping is about writes, and a stop that silently switched measuring off
    // left the panel dark for the rest of the session.
    //
    // `linkLost` is the reconnect path, and only there is the subscription
    // state meaningless — the protocol and its registry are replaced wholesale.
    // Standing the panel down there is what arms it again: the next link
    // re-announces the landing tab, and that re-runs setActive(true).
    // See src/ui/tabs.js setConnected()
    reset({ linkLost = false } = {}) {
      releaseAll();
      lastSent = {};
      lastPos = null;
      lastQ = null;
      if (linkLost) {
        active = false;
        note.textContent = '';
        Promise.resolve(hub.protocol?.releaseStreams(HOLDER)).catch(() => { /* gone anyway */ });
      }
      paintAttitude();
      paint();
    },

    showState(detail) {
      if (!active) return;
      if (detail?.driveMode) renderCluster(detail.driveMode);
      lastSent = detail?.sent ?? {};
      paint();
    },

    showMode(next) {
      if (!next) return;
      renderCluster(next);
    },

    showSteerPos(detail) {
      lastPos = detail?.pos ?? null;
      if (!active) return;
      paintAttitude();
      paintSteer(lastCommand());
    },

    showOrientation({ values }) {
      const q = alignSign(lastQ, quatHubToScene(quatFromOrint(values)));
      if (!q) return;
      lastQ = q;
      if (!active || !measured) return;
      paintAttitude();
    },
  };
}
