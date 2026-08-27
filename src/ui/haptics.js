// Haptics panel: master toggle, two intensity sliders and a probe button. It
// owns the persisted settings object and contains no haptics logic; every path
// has to work with `hub.haptics` absent, since the driver only exists after
// connect. Settings are clamped on load, pushed to the driver on every change,
// and re-pushed whenever a driver appears.
//
// See docs/superpowers/specs/2026-08-24-gamepad-haptic-feedback-design.md

import { $, rangeControl } from './dom.js';
import { log } from '../debug-log.js';

export const HAPTICS_KEY = 'lego-haptics-v1';

const DEFAULTS = { enabled: false, transient: 0.7, bed: 0.5 };

// Not a clamp: it answers "is this a usable stored setting", and `null` means
// no. Named for that, because it shared a name with two real clamps that each
// did something else.
// See docs/DESIGN-NOTES.md § One name for one behaviour
const asUnitOrNull = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

export function loadHapticsSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(HAPTICS_KEY) || '{}'); } catch { saved = null; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  return {
    enabled: saved.enabled === true,
    transient: asUnitOrNull(saved.transient) ?? DEFAULTS.transient,
    bed: asUnitOrNull(saved.bed) ?? DEFAULTS.bed,
  };
}

function save(settings) {
  try { localStorage.setItem(HAPTICS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

const LABELS = {
  unknown: 'haptics: ready',
  unsupported: 'haptics: unsupported on this browser or pad',
  disconnected: 'haptics: not connected',
  failed: 'haptics: test failed',
  idle: 'haptics: on',
  playing: 'haptics: on',
};

const STATES_SHOWN_EVEN_WHEN_OFF = new Set(['unsupported', 'failed']);

export function initHapticsPanel(hub) {
  const settings = loadHapticsSettings();
  const on = $('hap-on');
  const status = $('hap-status');

  status?.setAttribute?.('role', 'status');

  const paintStatus = (state, detail = '') => {
    if (!status) return;
    if (STATES_SHOWN_EVEN_WHEN_OFF.has(state)) { status.textContent = LABELS[state] + detail; return; }
    if (!settings.enabled) { status.textContent = 'haptics: off'; return; }
    status.textContent = LABELS[state] ?? LABELS.unknown;
  };

  let lastPushedDriver = null;
  const applySettings = () => {
    const haptics = hub.haptics;
    if (!haptics?.setSettings) return false;
    haptics.setSettings({ ...settings });
    lastPushedDriver = haptics;
    return true;
  };
  const syncIfNew = () => { if (hub.haptics && hub.haptics !== lastPushedDriver) applySettings(); };

  const push = () => {
    applySettings();
    paintStatus(hub.haptics?.status?.() ?? (hub.haptics ? 'unknown' : 'disconnected'));
  };

  if (on) {
    on.checked = settings.enabled;
    on.addEventListener('change', () => { settings.enabled = !!on.checked; save(settings); push(); });
  }

  const slider = (id, initial, apply) => {
    const el = $(id);
    if (!el) return null;
    el.value = String(Math.round(initial * 100));
    rangeControl(id, {
      scale: (v) => v / 100,
      format: (v) => String(Math.round(v * 100)),
      apply,
    });
    const persistOnRelease = () => save(settings);
    el.addEventListener('change', persistOnRelease);
    return el;
  };

  slider('hap-strong', settings.transient, (v) => { settings.transient = v; push(); });
  slider('hap-weak', settings.bed, (v) => { settings.bed = v; push(); });

  $('hap-test')?.addEventListener('click', () => {
    syncIfNew();
    const haptics = hub.haptics;
    if (!haptics?.test) { paintStatus('disconnected'); return; }
    const pads = globalThis.navigator?.getGamepads?.() ?? [];
    const connectedPad = [...pads].find((p) => p && p.connected !== false) || null;
    if (!connectedPad) { paintStatus('disconnected'); return; }
    Promise.resolve(haptics.test(connectedPad))
      .then((state) => paintStatus(state ?? 'unsupported'))
      .catch((err) => {
        paintStatus('failed', ` — ${err.message}`);
        log('haptics test failed:', err.message);
      });
  });

  paintStatus(hub.haptics?.status?.() ?? (hub.haptics ? 'unknown' : 'disconnected'));

  return {
    settings: () => ({ ...settings }),
    attach: syncIfNew,
    showStatus: (state) => { syncIfNew(); paintStatus(state); },
    reset: () => paintStatus('disconnected'),
  };
}
