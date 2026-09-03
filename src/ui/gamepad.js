// Gamepad panel: arm/disarm the control loop, tuning, and the remap table.

import { $, setToggle, rangeControl } from './dom.js';
import { loadMap, resetMap, saveMap, loadDriveMode } from '../gamepad-controller.js';
import { initMapper } from './gamepad-mapper.js';
import { log } from '../debug-log.js';

// onRunChange fires whenever the user arms or disarms the loop, so the app can
// take or drop the screen wake lock.
export function initGamepadPanel(hub, { onRunChange } = {}) {
  const gpEnable = $('gp-enable'), gpDriveMode = $('gp-drivemode');
  const gpLabel = $('gp-label'), gpStatus = $('gp-status');
  const gpLive = $('gp-live'), gpMap = $('gp-map');

  // The loop owns both facts and this panel mirrors them, keeping no copy of
  // its own: a private flag went stale the moment anything else moved the loop
  // — an on-screen control arms it, a macro's watch() suppresses it — and a
  // stale copy made `disable()` a no-op with the car still driving.
  // `armed` is what the label means: will a motor be commanded next frame.
  // See docs/DESIGN-NOTES.md § Arming has one owner, whatever does the arming
  // See docs/DESIGN-NOTES.md § One getter answers whether the gamepad will command next frame
  const armed = () => !!hub.gamepad?.armed;

  const paintEnable = () => {
    // Own span, not the button — see docs/DESIGN-NOTES.md § The enable label lives in its own span
    gpLabel.textContent = armed() ? 'pad: ARMED' : 'pad: OFF';
    setToggle(gpEnable, armed());
  };

  gpEnable.addEventListener('click', () => {
    if (!hub.gamepad) return;
    if (armed()) hub.gamepad.stop();
    else hub.gamepad.start();
    // The label follows the controller's own `armed` event and the wake lock
    // its `run` event, so the toggle, a finger, a macro and a stop path all
    // repaint through one route.
  });

  // See docs/DESIGN-NOTES.md § The select follows the controller, it does not own the mode
  gpDriveMode.value = loadDriveMode();

  gpDriveMode.addEventListener('change', (e) => {
    // Arming takes a few seconds and sweeps the rack, so say so.
    if (e.target.value === 'playvm') {
      $('gp-live').textContent = 'arming combined frame — the steering rack will sweep…';
    }
    // setDriveMode is async; without this catch a failed change is invisible.
    Promise.resolve(hub.gamepad?.setDriveMode(e.target.value)).catch((err) => {
      $('gp-live').textContent = `drive mode failed: ${err.message}`;
      log('drive mode change failed:', err.message);
    });
  });

  // Every slider's current value, kept whether or not a controller exists yet.
  // Without this a slider moved before connecting is silently discarded and the
  // controller starts on its own defaults, with the panel showing numbers it is
  // not obeying — which is indistinguishable from a slider that does nothing.
  const tuned = new Map();
  const tune = (key) => (v) => {
    tuned.set(key, v);
    if (hub.gamepad) hub.gamepad.params[key] = v;
  };
  function applyTuning(gamepad) {
    for (const [key, v] of tuned) gamepad.params[key] = v;
  }
  // Deadzone and expo are fractional; the sliders carry hundredths and tenths.
  // See docs/DESIGN-NOTES.md § Sliders carry integers; `scale` converts
  rangeControl('gp-dz', { scale: (v) => v / 100, format: (v) => v.toFixed(2), apply: tune('deadzone') });
  rangeControl('gp-expo', { scale: (v) => v / 10, format: (v) => v.toFixed(1), apply: tune('expo') });
  rangeControl('gp-max', { apply: tune('maxSpeed') });
  rangeControl('gp-gain', { apply: tune('steerGain') });
  rangeControl('gp-ramp-rate', {
    apply: (v) => {
      if (!hub.gamepad) return;
      // One slider, two profiles: rate for linear, inverse time constant for expo.
      hub.gamepad.params.rampRate = v;
      hub.gamepad.params.rampTau = Math.round(60000 / v);
    },
  });
  $('gp-ramp').addEventListener('change', (e) => {
    if (hub.gamepad) hub.gamepad.params.rampMode = e.target.value;
  });

  // The map is drawn on a picture of the pad, one slot per physical control.
  // It lives without a controller: the map is in localStorage either way, so
  // the panel can be read and edited before anything is connected.
  // See docs/DESIGN-NOTES.md § The mapping panel names controls, not indices
  let held = loadMap();
  const mapper = gpMap && initMapper(gpMap, {
    getMap: () => hub.gamepad?.map ?? held,
    setMap: (next) => {
      held = next;
      if (hub.gamepad) hub.gamepad.map = next;
      else saveMap(next);
    },
    mode: gpDriveMode?.value,
  });
  const renderMapping = () => mapper?.refresh();

  $('gp-reset').addEventListener('click', () => {
    held = resetMap();
    if (hub.gamepad) hub.gamepad.map = held;
    mapper?.refresh();
  });

  // Called by main once hub.gamepad exists — the panel is built before the
  // controller, so listeners cannot be attached at init time.
  function attach(gamepad) {
    // Whatever was set on the sliders before this controller existed.
    applyTuning(gamepad);
    // The loop announces its own lifetime, so a touch-armed loop takes the wake
    // lock exactly like a pad-armed one — and a watching loop keeps it, because
    // a macro is driving the car for as long as that lasts.
    gamepad.addEventListener('run', (e) => {
      paintEnable();
      onRunChange?.(e.detail.running);
    });
    gamepad.addEventListener('needs-invert', () => {
      $('gp-live').textContent =
        'tracked: set a drive motor to REVERSED in Setup — turn and throttle are swapped without it';
    });
    // Corrected here as well as in showState: the 'state' frame that would fix
    // the select only arrives while the pad loop is running.
    gamepad.addEventListener('playvm-failed', (e) => {
      $('gp-live').textContent = `combined frame unavailable (${e.detail.reason}) — back to linked`;
      gpDriveMode.value = 'linked';
    });
    gamepad.addEventListener('drivemode', (e) => {
      if (e.detail.mode === 'playvm') $('gp-live').textContent = 'combined frame armed — hub steers itself';
      if (gpDriveMode.value !== e.detail.mode) gpDriveMode.value = e.detail.mode;
    });
    // The controller's armed state can change with no click of this panel's
    // own toggle — a finger on a Drive control, watch()/unwatch() and a crash
    // all move it — so the label repaints from the 'armed' event too, which
    // moves without the loop's lifetime moving with it.
    gamepad.addEventListener('armed', () => paintEnable());
    // A newly attached controller may never fire either transition (it can
    // start and stay disarmed), so paint its real state once up front rather
    // than relying on the page's static markup to already agree with it.
    paintEnable();
  }

  return {
    attach,
    // What this panel reports is "is the pad about to command a motor" — the
    // question the wake lock's neighbours ask (the arrow-key swallow), not the
    // loop's lifetime. See docs/DESIGN-NOTES.md § `running` is the loop, `armed` is the motor
    get running() { return armed(); },

    renderMapping,
    showState(d) {
      if (!d.connected) { gpStatus.textContent = 'not connected'; return; }
      // The pad id shares a 320px bar with two other chips.
      gpStatus.textContent = d.id.slice(0, 16);
      const b = d.driveMode === 'independent' ? ` · B ${d.throttleB}` : '';
      gpLive.textContent =
        `A ${d.throttle}${b} · steer ${d.steer} · trim ${d.trim} · lamps ${d.lamps.map((v) => (v ? '●' : '○')).join('')}`;
      // The gamepad's own mode button can change this too.
      const mode = String(d.driveMode ?? 'linked');
      if (gpDriveMode.value !== mode) gpDriveMode.value = mode;
      // Raw axes, so a pad that numbers its sticks differently is visible.
      const axesOut = $('gp-axes');
      if (axesOut && d.axes) {
        axesOut.textContent = 'axes ' + d.axes.map((v, i) => `${i}:${v.toFixed(2)}`).join('  ')
          + `  (${d.mapping})`;
      }
    },
    // Every loss-of-control path reaches in here, not just the UI toggle, and it
    // is unconditional: this panel's toggle is not the only thing that arms the
    // loop, so a guard on what this panel last did would skip the stop.
    // See docs/DESIGN-NOTES.md § Disabling the panel is part of stopping, not cosmetic
    disable() {
      hub.gamepad?.stop();
      paintEnable();
    },
  };
}
