// Xbox controller integration: polls the Gamepad API, applies deadzone/expo,
// mixes the two drive motors, and drives steering either as a raw motor
// (stick centre = motor stop) or through the closed-loop steering controller.

import { applyDeadzone, expCurve, applyMinPower } from './control-math.js';
import { createInputMix } from './input-mix.js';
import { rampStep, DEFAULT_RATE, DEFAULT_TAU } from './ramp.js';
import { DEFAULT_MAP, ACTIONS, HOLD_ACTIONS, resolveActions, learnBinding, sourceLabel, tankMix } from './gamepad-map.js';
import { log } from './debug-log.js';

// How long a per-motor drive command may go unrefreshed before the watchdog
// brakes it, and how often that watchdog wakes to check.
// See docs/DESIGN-NOTES.md § The per-motor drive paths need their own dead-man
export const PERMOTOR_TTL_MS = 1000;
export const PERMOTOR_WATCHDOG_MS = 500;

const MAP_KEY = 'lego-gamepad-map-v2';
const MODE_KEY = 'lego-drive-mode-v1';
const LED_CYCLE = [1, 3, 6, 7, 9, 10];

export function loadMap() {
  try {
    const saved = JSON.parse(localStorage.getItem(MAP_KEY) || '{}');
    return { ...structuredClone(DEFAULT_MAP), ...saved };
  } catch { return structuredClone(DEFAULT_MAP); }
}
export function saveMap(map) {
  try { localStorage.setItem(MAP_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}
export function loadDriveMode(fallback = 'playvm') {
  try {
    const saved = JSON.parse(localStorage.getItem(MODE_KEY) || 'null');
    return GamepadController.DRIVE_MODES.includes(saved) ? saved : fallback;
  } catch { return fallback; }
}
export function saveDriveMode(mode) {
  try { localStorage.setItem(MODE_KEY, JSON.stringify(mode)); } catch { /* ignore */ }
}

export function resetMap() {
  try { localStorage.removeItem(MAP_KEY); } catch { /* ignore */ }
  return structuredClone(DEFAULT_MAP);
}

const snapshot = (pad) => pad
  ? { axes: [...pad.axes], buttons: pad.buttons.map((b) => b.value) }
  : null;

export class GamepadController extends EventTarget {
  #protocol; #roles; #steering; #playvm;
  #haptics = null;
  #raf = 0; #prev = null; #map;
  #ledIdx = 0;
  #lamps = [false, false, false, false, false, false];
  #lastSent = new Map(); // port -> last speed, to avoid redundant writes
  #learning = null;
  #shouldBrake;
  #lastLinked = null;
  #lastTank = null;
  #ramped = new Map(); // key -> last ramped output
  #lastFrameAt = 0;
  #brakeHeld = false;
  #holdSince = new Map(); // action -> timestamp of press, for hold-guarded actions
  #lastPadTs = 0; #staleSince = 0; #stoppedStale = false; #warnedMapping = false;
  #mix;
  #watching = false; #watchOwnsLoop = false; #lastArmed = false; #lastRunning = false;
  // Was the tab live (focused and visible) on the last frame? The !live→live
  // edge reseeds the frame so a return from unfocused does not ramp on a stale
  // multi-second dt. See docs/DESIGN-NOTES.md § Coming back from unfocused starts a fresh frame, not a stale one
  #wasLive = true;
  // Per-motor dead-man: injected time/timer, the TTL/interval, and the state a
  // self-rescheduling watchdog reads. See docs/DESIGN-NOTES.md § The per-motor drive paths need their own dead-man
  #now; #schedule; #cancelTimer;
  #permotorTtlMs; #watchdogMs;
  #lastDriveAt = -Infinity; #driveActive = false; #driveWatch = 0;

  params = {
    deadzone: 0.15,
    expo: 2,        // response curve exponent
    maxSpeed: 100,  // ceiling applied to drive output
    steerGain: 100, // raw-mode steering power at full stick
    // 'linked'      both drive motors on the triggers
    // 'independent' motor A on the triggers, motor B on the right stick
    // 'tracked'     one stick: Y drives both tracks, X counter-rotates them
    // 'playvm'      the hub's own combined frame: one write for speed, steering
    //               and lights, with the hub holding the steering angle
    // See docs/DESIGN-NOTES.md § The hub's own drive mode is the default, and applying it is what makes it real
    driveMode: 'playvm',
    // How fast the commanded speed may rise: 'instant', 'linear' or 'expo'.
    rampMode: 'expo',
    rampRate: DEFAULT_RATE,
    rampTau: DEFAULT_TAU,
    minPower: 6,           // below this a motor only stalls and buzzes, so treat as stop
    trim: 0,               // steering trim offset
  };

  // The on-screen controls' way in. They never reach the protocol themselves.
  touch = {
    set: (axis, value) => this.#mix.setTouch(axis, value),
    release: (axis) => this.#mix.releaseTouch(axis),
    releaseAll: () => this.#mix.releaseAll(),
  };

  // Is any on-screen control actually commanding something? Post-deadzone, the
  // same test the mixer arbitrates with — a thumb resting at dead centre is not
  // an engaged axis. Anything outside that needs this answer asks for it here
  // rather than counting `touch` calls, which the internal stops bypass.
  // See docs/DESIGN-NOTES.md § Arbitration is per axis, and engagement is post-deadzone
  anyEngaged() { return this.#mix.anyEngaged(); }

  // shouldBrake(port) lets the UI decide brake-vs-coast per motor. playvm is
  // optional: without it the combined-frame mode simply is not offered.
  constructor(protocol, roles, steering, shouldBrake = () => true, playvm = null, options = {}) {
    super();
    this.#protocol = protocol;
    this.#roles = roles;
    this.#steering = steering;
    this.#shouldBrake = shouldBrake;
    this.#playvm = playvm;
    // Injectable so the dead-man can be exercised without real milliseconds,
    // mirroring PlayVmController. Wrapped, never passed by reference.
    this.#now = options.now ?? (() => performance.now());
    // unref() so a lingering watchdog never holds a node test process open; in
    // the browser the id is a number and the optional call is a no-op.
    this.#schedule = options.schedule ?? ((fn, ms) => { const id = setTimeout(fn, ms); id?.unref?.(); return id; });
    this.#cancelTimer = options.cancel ?? ((id) => clearTimeout(id));
    this.#permotorTtlMs = options.permotorTtlMs ?? PERMOTOR_TTL_MS;
    this.#watchdogMs = options.watchdogMs ?? PERMOTOR_WATCHDOG_MS;
    // Without a playvm collaborator the default mode can command nothing at all.
    this.params.driveMode = loadDriveMode();
    if (!playvm) this.params.driveMode = 'linked';
    this.#mix = createInputMix({ deadzone: () => this.params.deadzone });
    this.#map = loadMap();
  }

  get haptics() { return this.#haptics; }
  set haptics(driver) { this.#haptics = driver ?? null; }

  get map() { return this.#map; }
  set map(m) { this.#map = m; saveMap(m); }
  get lamps() { return [...this.#lamps]; }
  // Whether this pad will actually command a motor on its next frame. This
  // is the single source of truth for any UI showing an armed/disarmed
  // state — a loop can be running (`#raf`) while watching suppresses it.
  get armed() { return this.#raf !== 0 && !this.#watching; }
  // Dispatches 'armed' only on a real transition, so a listener can repaint
  // a label without polling this getter on a timer.
  #syncArmed() {
    const now = this.armed;
    if (now === this.#lastArmed) return;
    this.#lastArmed = now;
    this.dispatchEvent(new CustomEvent('armed', { detail: { armed: now } }));
  }
  // Accept lamp state changed elsewhere (the on-screen panel).
  // See docs/DESIGN-NOTES.md § Lamp state has one source of truth
  syncLamps(states) { this.#lamps = [...states]; }

  static DRIVE_MODES = ['linked', 'independent', 'tracked', 'playvm'];

  // See docs/DESIGN-NOTES.md § Exactly one drive path may be live at a time
  async setDriveMode(mode, { persist = true } = {}) {
    // Logged before anything that can throw or await, so a half-failed mode
    // change still leaves a trace.
    log('drive mode requested:', mode);
    if (persist && GamepadController.DRIVE_MODES.includes(mode)) saveDriveMode(mode);
    this.params.driveMode = mode;
    this.#lastSent.clear();
    this.#lastLinked = null;
    this.#lastTank = null;
    // Leaving a per-motor mode must strand no watchdog on that mode's command.
    // See docs/DESIGN-NOTES.md § The per-motor drive paths need their own dead-man
    this.#driveActive = false;
    this.#clearDriveWatch();
    // Leaving a mode must not strand the motors at that mode's last command.
    this.#protocol.driveThrottle(0);
    // Tracked mode needs a mirrored drive motor to make sense; its closed loop
    // also runs on its own rAF timer and has to be shut down explicitly.
    // See docs/DESIGN-NOTES.md § Tracked mode needs a mirrored drive motor to make sense
    if (mode === 'tracked') {
      const inverted = this.#protocol.invertedPorts ?? new Set();
      const anyInverted = [this.#roles.driveA, this.#roles.driveB].some((p) => p != null && inverted.has(p));
      if (!anyInverted) {
        log('tracked mode: neither drive motor is reversed — turn and throttle will feel swapped. Set direction in Setup.');
        this.dispatchEvent(new CustomEvent('needs-invert'));
      }
    }
    if (mode === 'tracked' && this.#steering) {
      this.#steering.mode = 'raw';
      this.#steering.jogStop();
    }
    if (this.#playvm) {
      if (mode === 'playvm') {
        if (this.#steering) { this.#steering.mode = 'raw'; this.#steering.jogStop(); }
        // Caught, not propagated: a rejection from here would escape an event
        // handler and abandon the mode change silently.
        let result;
        try {
          result = await this.#playvm.arm();
        } catch (err) {
          result = { ok: false, reason: err.message };
        }
        if (!result.ok) {
          log('playvm: init failed —', result.reason, '— falling back to linked');
          this.dispatchEvent(new CustomEvent('playvm-failed', { detail: result }));
          this.params.driveMode = 'linked';
        }
      } else if (this.#playvm.armed) {
        this.#playvm.disarm();
      }
    }
    log('drive mode:', this.params.driveMode);
    this.dispatchEvent(new CustomEvent('drivemode', { detail: { mode: this.params.driveMode } }));
  }

  cycleDriveMode() {
    const modes = GamepadController.DRIVE_MODES;
    const next = modes[(modes.indexOf(this.params.driveMode) + 1) % modes.length];
    return this.setDriveMode(next);
  }

  startLearning(actionId) { this.#learning = actionId; }
  get learning() { return this.#learning; }
  cancelLearning() { this.#learning = null; }

  // Whether the control loop is actually running. The single source of truth
  // for the loop's lifetime: a panel mirrors this, it never keeps its own copy.
  // A watching loop is running and commands nothing — `armed` is that answer.
  // See docs/DESIGN-NOTES.md § Arming has one owner, whatever does the arming
  // See docs/DESIGN-NOTES.md § `running` is the loop, `armed` is the motor
  get running() { return this.#raf !== 0; }

  // Dispatches 'run' only on a real transition, so watch()/unwatch() moving
  // the loop cannot announce a change that did not happen.
  #announceRun() {
    const now = this.running;
    if (now === this.#lastRunning) return;
    this.#lastRunning = now;
    this.dispatchEvent(new CustomEvent('run', { detail: { running: now } }));
  }

  start() {
    if (this.#raf) return;
    const tick = () => {
      // #poll() can call stop() on itself; skip the reschedule below if it did.
      const scheduledAs = this.#raf;
      // On any fault: stop the car, tear the loop down, do NOT re-arm.
      // See docs/DESIGN-NOTES.md § A crash in the loop stops the car before tearing the loop down
      try {
        this.#poll();
      } catch (err) {
        log('gamepad loop crashed:', err.message, '- stopping');
        this.#raf = 0;
        // #raf is going to 0 regardless of #watching, so these must drop
        // with it — a later watch() call would otherwise find #watching
        // already true and never restart polling. src/main.js aborts the
        // macro on 'crashed' below, so the run ends rather than continuing
        // with no way to take the car back.
        this.#watching = false;
        this.#watchOwnsLoop = false;
        this.#stopAll();
        this.#announceRun();
        this.#syncArmed();
        this.dispatchEvent(new CustomEvent('crashed', { detail: { message: err.message } }));
        return;
      }
      if (this.#raf !== scheduledAs) return;
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
    this.#announceRun();
    this.#syncArmed();
  }

  // Refused while watching: this loop is `input`'s only channel, and
  // watch()/unwatch() own its lifetime for as long as watching lasts.
  stop() {
    if (this.#watching) return;
    this.#stopLoop();
    this.#stopAll();
    this.#announceRun();
    this.#syncArmed();
  }

  #stopLoop() {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
  }

  // Polls and reports without commanding. Idempotent; starts its own loop
  // only when none is running, otherwise the loop already in flight switches
  // to report-only for as long as watching lasts.
  watch() {
    if (this.#watching) return;
    this.#watching = true;
    if (!this.#raf) {
      this.#watchOwnsLoop = true;
      this.start();
    }
    this.#syncArmed();
  }

  // Tears the loop down, only, and only if watch() started it — #stopAll()
  // is for stop()'s other caller, the panel toggle, whose loop was driving.
  unwatch() {
    this.#watching = false;
    if (this.#watchOwnsLoop) {
      this.#watchOwnsLoop = false;
      this.#stopLoop();
    }
    this.#announceRun();
    this.#syncArmed();
  }

  #stopAll() {
    // See docs/DESIGN-NOTES.md § The emergency stop closes the sources before it cuts power
    this.#mix.releaseAll();
    try {
      this.#haptics?.silence();
    } catch (err) {
      log('haptics fault - disabling:', err.message);
      this.#haptics = null;
    }
    this.#ramped.clear();
    this.#lastLinked = null;
    // The dead-man watchdog is a timer, and a stop/disarm/disconnect/crash all
    // route here — none may leave it armed.
    // See docs/DESIGN-NOTES.md § The per-motor drive paths need their own dead-man
    this.#driveActive = false;
    this.#clearDriveWatch();
    // See docs/DESIGN-NOTES.md § A stop that only covers the per-motor path leaves the car driving
    this.#playvm?.stop();
    this.#protocol.driveThrottle(0);
    for (const port of [this.#roles.driveA, this.#roles.driveB]) {
      if (port != null) this.#lastSent.set(port, 0);
    }
    if (this.#steering && this.#steering.mode === 'raw' && this.#roles.steer != null) {
      this.#protocol.setMotorSpeedRaw(this.#roles.steer, 0);
      this.#lastSent.set(this.#roles.steer, 0);
    } else if (this.#steering) {
      // Closed loop: the rack is held by SteeringController's own rAF against a
      // target this loop set, so cutting this loop's outputs leaves that target
      // standing and the rack drives on to it. Release is what a centred stick
      // does every frame; a stop has to do it too — and unconditionally, because
      // `release()` obeys `autoReturn` and a stop is not a release.
      // See docs/DESIGN-NOTES.md § A stop must unwind the steering target, not just the motors
      this.#steering.release();
      this.#steering.setInput(0);
    }
  }

  #send(port, speed) {
    if (port == null) return;
    if (this.#lastSent.get(port) === speed) return;
    this.#lastSent.set(port, speed);
    // Brake stops on the spot; float coasts. Chosen per motor by the UI.
    if (speed === 0 && this.#shouldBrake(port)) this.#protocol.brakeMotor(port);
    else this.#protocol.setMotorSpeedRaw(port, speed);
  }

  // Called once per frame with whether a per-motor drive path is commanding a
  // non-zero speed. A live command renews the licence and keeps the watchdog
  // armed; a zero (or a mode that hands the ports back — playvm/hold/brake)
  // clears it. See docs/DESIGN-NOTES.md § The per-motor drive paths need their own dead-man
  #noteDrive(active) {
    if (active) {
      this.#lastDriveAt = this.#now();
      this.#driveActive = true;
      this.#armDriveWatch();
    } else if (this.#driveActive) {
      this.#driveActive = false;
      this.#clearDriveWatch();
    }
  }

  #armDriveWatch() {
    if (this.#driveWatch) return;            // one self-rescheduling timer
    this.#driveWatch = this.#schedule(() => {
      this.#driveWatch = 0;
      if (!this.armed || !this.#driveActive) return;
      if (this.#now() - this.#lastDriveAt > this.#permotorTtlMs) {
        this.#driveActive = false;
        // Reset every per-motor dedup, #lastSent included.
        // See docs/DESIGN-NOTES.md § The per-motor drive paths need their own dead-man
        this.#lastLinked = 0; this.#lastTank = null;
        this.#ramped.clear(); this.#lastSent.clear();
        this.#protocol.brakeDrive();
        return;
      }
      this.#armDriveWatch();
    }, this.#watchdogMs);
  }

  #clearDriveWatch() {
    if (this.#driveWatch) { this.#cancelTimer(this.#driveWatch); this.#driveWatch = 0; }
  }

  // Rate-limit a commanded speed. Keyed so each output (drive pair, per-track,
  // per-motor) carries its own ramp state.
  #ramp(key, target, dtMs) {
    const current = this.#ramped.get(key) ?? 0;
    const next = rampStep(current, target, dtMs, {
      mode: this.params.rampMode,
      rate: this.params.rampRate,
      tau: this.params.rampTau,
    });
    this.#ramped.set(key, next);
    return next;
  }

  #curve(raw) {
    return expCurve(applyDeadzone(raw, this.params.deadzone), this.params.expo);
  }

  #poll() {
    // Filter on connected, do not take the first non-null entry.
    // See docs/DESIGN-NOTES.md § Chrome keeps dead pads in the gamepad array
    const pads = navigator.getGamepads?.() ?? [];
    const pad = [...pads].find((p) => p && p.connected !== false) || null;
    // Reports without commanding, on the same deadzone the drive path uses.
    // Ahead of the stop below, which commands: while a macro owns the drive
    // path this loop writes nothing at all, pad or no pad.
    // See docs/DESIGN-NOTES.md § Watch mode suppresses every source, not just the pad
    if (this.#watching) {
      if (pad) {
        const { axes, buttons } = pad;
        const moved = axes.some((v) => Math.abs(v) > this.params.deadzone)
          || buttons.some((b) => b.pressed);
        if (moved) this.dispatchEvent(new CustomEvent('input'));
      }
      return;
    }
    // An unfocused or hidden tab hands back a frozen navigator.getGamepads(), so
    // driving from it commands the car off a stick reading that can no longer
    // change. Suppress commanding while not live; default LIVE when hasFocus is
    // absent (the node stubs), or every gamepad test crashes here.
    // See docs/DESIGN-NOTES.md § The focus gate is the fresh-input signal the loop was missing
    const live = (typeof document.hasFocus === 'function' ? document.hasFocus() : true)
      && document.visibilityState !== 'hidden';
    if (!live) { this.#wasLive = false; this.#prev = null; return; }
    if (!this.#wasLive) {
      // See docs/DESIGN-NOTES.md § Coming back from unfocused starts a fresh frame, not a stale one
      this.#wasLive = true;
      this.#lastFrameAt = 0;      // dtMs recomputes to the 16ms seed, no jump
      this.#holdSince.clear();
      // Seed from the live pad, not null: a button held across the blur must read
      // as already-down, or #wasPressed() sees no history and the edge misfires.
      this.#prev = pad ? snapshot(pad) : null;
    }
    const touching = this.#mix.anyEngaged();
    if (!pad && !touching) {
      // Logged once per transition: cutting the motors must leave a trace.
      if (!this.#stoppedStale) {
        this.#stoppedStale = true;
        log('no input source — stopping');
        this.#stopAll();
      }
      this.dispatchEvent(new CustomEvent('state', { detail: { connected: false, sent: {} } }));
      this.#prev = null;
      return;
    }
    if (pad && !this.#warnedMapping) {
      this.#warnedMapping = true;
      const src = (id) => sourceLabel(this.#map[id]);
      log(`gamepad "${pad.id}" mapping=${pad.mapping} axes=${pad.axes.length}`);
      log(`tank bindings: turn=${src('tankTurn')} throttle=${src('tankThrottle')}`);
      if (pad.mapping !== 'standard') log('non-standard mapping - default indices may be wrong, use remap');
    }

    // Learning consumes the input instead of driving the car.
    if (this.#learning) {
      const bind = pad ? learnBinding(pad, this.#prev) : null;
      if (bind) {
        const action = ACTIONS.find((a) => a.id === this.#learning);
        if (action?.kind === 'pair') this.#map[this.#learning] = { pos: bind, neg: this.#map[this.#learning]?.neg };
        else this.#map[this.#learning] = bind;
        saveMap(this.#map);
        log(`mapped ${this.#learning} -> ${sourceLabel(bind)}`);
        this.#learning = null;
        this.dispatchEvent(new CustomEvent('mapped'));
      }
      this.#prev = snapshot(pad);
      return;
    }

    // #staleSince is recorded for diagnosis and acted on by NOBODY. A frozen
    // timestamp means a held control, not a wedged pad — do not stop on it.
    // See docs/DESIGN-NOTES.md § A frozen gamepad timestamp is not a disconnected pad
    const now = performance.now();
    this.#stoppedStale = false;
    if (pad) {
      if (pad.timestamp === this.#lastPadTs) {
        if (!this.#staleSince) this.#staleSince = now;
      } else {
        this.#staleSince = 0;
        this.#lastPadTs = pad.timestamp;
      }
    }

    const dtMs = this.#lastFrameAt ? now - this.#lastFrameAt : 16;
    this.#lastFrameAt = now;

    const a = pad ? resolveActions(pad, this.#map) : {};
    // Every continuous axis, arbitrated between the pad and the on-screen controls.
    const ax = {
      throttle: this.#mix.resolve('throttle', a.throttle ?? 0),
      throttleB: this.#mix.resolve('throttleB', a.throttleB ?? 0),
      steer: this.#mix.resolve('steer', a.steer ?? 0),
      tankThrottle: this.#mix.resolve('tankThrottle', a.tankThrottle ?? 0),
      tankTurn: this.#mix.resolve('tankTurn', a.tankTurn ?? 0),
    };
    const pressed = (id) => a[id] && !this.#wasPressed(id);
    // Hold-guarded: fires once after the button has been held long enough.
    const held = (id) => {
      const ms = HOLD_ACTIONS[id];
      if (!a[id]) { this.#holdSince.delete(id); return false; }
      const since = this.#holdSince.get(id);
      if (since == null) { this.#holdSince.set(id, now); return false; }
      if (since === -1) return false;            // already fired this press
      if (now - since >= ms) { this.#holdSince.set(id, -1); return true; }
      return false;
    };

    // --- edge-triggered actions ---
    if (pressed('ledCycle')) {
      this.#ledIdx = (this.#ledIdx + 1) % LED_CYCLE.length;
      this.#protocol.setLed(LED_CYCLE[this.#ledIdx]);
    }
    if (pressed('lightsToggle')) {
      const anyOn = this.#lamps.some(Boolean);
      this.#lamps = this.#lamps.map(() => !anyOn);
      this.#applyLamps();
    }
    for (let i = 0; i < 6; i++) {
      if (pressed(`lamp${i + 1}`)) {
        this.#lamps[i] = !this.#lamps[i];
        this.#applyLamps();
      }
    }
    if (pressed('driveModeToggle')) this.cycleDriveMode();
    if (pressed('steerModeToggle') && this.#steering) {
      if (this.#steering.mode === 'raw') {
        this.#steering.enterSteerMode()
          .then(() => log('steer mode:', this.#steering.mode))
          .catch((err) => log('steer mode failed:', err.message));
      } else {
        this.#steering.mode = 'raw';
        this.#steering.jogStop();
        log('steer mode:', this.#steering.mode);
      }
    }
    if (held('steerZero') && this.#steering) this.#steering.setZero();
    if (pressed('trimLeft')) this.params.trim -= 2;
    if (pressed('trimRight')) this.params.trim += 2;

    // --- continuous control ---
    // The numbers actually written this frame, keyed per output. An absent key
    // was not commanded in this mode.
    const sent = {};
    const rawThrottle = Math.round(this.#curve(ax.throttle) * this.params.maxSpeed);
    const throttle = Math.abs(rawThrottle) < this.params.minPower ? 0 : rawThrottle;
    const steerRaw = this.#curve(ax.steer);
    const braking = a.brake;
    if (!braking) this.#brakeHeld = false;

    if (braking) {
      // See docs/DESIGN-NOTES.md § Brake is a level signal but `brakeDrive()` is edge-triggered
      if (!this.#brakeHeld) {
        this.#brakeHeld = true;
        this.#lastLinked = 0;
        this.#protocol.brakeDrive();
      }
      if (this.params.driveMode === 'tracked') { sent.tankL = 0; sent.tankR = 0; }
      else if (this.params.driveMode === 'playvm') { sent.playvmSpeed = 0; sent.playvmSteer = 0; }
      else { sent.driveA = 0; sent.driveB = 0; }
      this.#noteDrive(false);
    } else if (this.params.driveMode === 'playvm') {
      // One write carries both axes. No ramp and no minimum power: the hub runs
      // its own controller behind this frame and does its own smoothing.
      // Trim biases an ACTIVE steering input only.
      // See docs/DESIGN-NOTES.md § Trim biases an active steering input only
      const active = Math.abs(steerRaw) > 0;
      const steerCmd = active
        ? Math.round(steerRaw * this.params.steerGain) + this.params.trim
        : 0;
      if (this.#playvm) {
        this.#playvm.set(throttle, steerCmd);
        sent.playvmSpeed = throttle;
        sent.playvmSteer = steerCmd;
      }
      this.#noteDrive(false);
    } else if (this.params.driveMode === 'tracked') {
      // One stick: Y drives, X counter-rotates. Both tracks in one burst.
      const turn = Math.round(this.#curve(ax.tankTurn) * this.params.maxSpeed);
      const drive = Math.round(this.#curve(ax.tankThrottle) * this.params.maxSpeed);
      const mixed = tankMix(drive, turn);
      // See docs/DESIGN-NOTES.md § Below the stall threshold, jitter re-triggers the staged brake
      const left = applyMinPower(this.#ramp('tankL', mixed.left, dtMs), this.params.minPower);
      const right = applyMinPower(this.#ramp('tankR', mixed.right, dtMs), this.params.minPower);
      sent.tankL = left;
      sent.tankR = right;
      const stopped = left === 0 && right === 0;
      const key = stopped ? 'stop' : `${left}:${right}`;
      if (key !== this.#lastTank) {
        this.#lastTank = key;
        if (stopped && this.#shouldBrake(this.#roles.driveA)) this.#protocol.brakeDrive();
        else this.#protocol.driveTank(left, right);
      }
      this.#noteDrive(!stopped);
    } else if (this.params.driveMode === 'linked') {
      // One burst drives both motors with the same value, back-to-back.
      const ramped = applyMinPower(this.#ramp('drive', throttle, dtMs), this.params.minPower);
      sent.driveA = ramped;
      sent.driveB = ramped;
      if (ramped !== this.#lastLinked) {
        this.#lastLinked = ramped;
        if (ramped === 0 && this.#shouldBrake(this.#roles.driveA)) this.#protocol.brakeDrive();
        else this.#protocol.driveThrottle(ramped);
      }
      this.#noteDrive(ramped !== 0);
    } else {
      // Independent: motor A on the triggers, motor B on the right stick.
      const throttleB = Math.round(this.#curve(ax.throttleB) * this.params.maxSpeed);
      sent.driveA = applyMinPower(this.#ramp('a', throttle, dtMs), this.params.minPower);
      sent.driveB = applyMinPower(this.#ramp('b', throttleB, dtMs), this.params.minPower);
      this.#send(this.#roles.driveA, sent.driveA);
      this.#send(this.#roles.driveB, sent.driveB);
      this.#noteDrive(sent.driveA !== 0 || sent.driveB !== 0);
    }

    // Steering. In raw mode the stick maps straight to motor power, so the
    // stick's own centre is the zero — no calibration needed.
    // See docs/DESIGN-NOTES.md § The steering motor gets its own stick in tracked mode
    if (this.params.driveMode === 'playvm') {
      // Deliberately empty: steering rides in the combined frame, and touching
      // the motor here would fight the hub's own controller for the same hardware.
    } else if (this.#steering && this.params.driveMode === 'tracked') {
      // Raw power off the RIGHT stick — the tracks do the steering here.
      const raw = this.#curve(a.tankSteer ?? 0);
      const cmd = Math.round(raw * this.params.steerGain);
      const power = Math.abs(cmd) < this.params.minPower ? 0 : Math.max(-100, Math.min(100, cmd));
      this.#send(this.#roles.steer, power);
      sent.steer = power;
    } else if (this.#steering) {
      if (this.#steering.mode === 'raw') {
        // See docs/DESIGN-NOTES.md § Trim biases an active steering input only
        const active = Math.abs(steerRaw) > 0;
        const raw = active ? Math.round(steerRaw * this.params.steerGain) + this.params.trim : 0;
        const power = Math.abs(raw) < this.params.minPower ? 0 : Math.max(-100, Math.min(100, raw));
        this.#send(this.#roles.steer, power);
        sent.steer = power;
      } else {
        this.#steering.setInput(steerRaw * 100 + this.params.trim);
        if (Math.abs(steerRaw) < 0.01) this.#steering.release();
        sent.steer = Math.round(steerRaw * 100 + this.params.trim);
      }
    }

    // Everything below runs AFTER the frame's motor command is on the link.
    // None of it needs to happen before the motor byte goes out, so none of it
    // should. Still above the snapshot, so edge detection is untouched.
    // See docs/DESIGN-NOTES.md § The frame commands the motor before it does anything else
    // The rumble bed, fed the same deadzoned stick the motor path sees. A
    // haptics fault disables it rather than tearing the loop down.
    if (this.#haptics) {
      try {
        const dz = this.params.deadzone;
        const drive = Math.max(
          Math.abs(applyDeadzone(ax.throttle, dz)),
          Math.abs(applyDeadzone(ax.throttleB, dz)),
          Math.abs(applyDeadzone(ax.tankThrottle, dz)),
        );
        const turn = Math.max(
          Math.abs(applyDeadzone(ax.steer, dz)),
          Math.abs(applyDeadzone(ax.tankTurn, dz)),
        );
        this.#haptics.drive({ drive, turn, dtMs });
        this.#haptics.tick(pad, now);
      } catch (err) {
        log('haptics fault - disabling:', err.message);
        this.#haptics = null;
      }
    }

    this.#prev = snapshot(pad);
    this.dispatchEvent(new CustomEvent('state', {
      detail: {
        connected: !!pad, id: pad?.id, actions: a,
        axes: pad ? pad.axes.map((v) => Math.round(v * 100) / 100) : [],
        mapping: pad?.mapping,
        throttle, throttleB: Math.round(this.#curve(ax.throttleB) * this.params.maxSpeed),
        steer: Math.round(steerRaw * 100),
        driveMode: this.params.driveMode, lamps: this.lamps, trim: this.params.trim,
        sent,
      },
    }));
  }

  // Reads the previous snapshot through the binding shape, axes included.
  // See docs/DESIGN-NOTES.md § Edge detection has to understand axis bindings
  #wasPressed(id) {
    if (!this.#prev) return false;
    const b = this.#map[id];
    if (!b) return false;
    if (b.type === 'button') return (this.#prev.buttons[b.index] ?? 0) > 0.5;
    if (b.type === 'axis') {
      const v = this.#prev.axes[b.index] ?? 0;
      return (b.invert ? -v : v) > 0.5;
    }
    return false;
  }

  #applyLamps() {
    const on = this.#lamps.reduce((m, v, i) => (v ? m | (1 << i) : m), 0);
    const off = 0x3f & ~on;
    if (on) this.#protocol.setLights(on, 100, 'lights:on');
    if (off) this.#protocol.setLights(off, 0, 'lights:off');
    this.dispatchEvent(new CustomEvent('lamps', { detail: { lamps: this.lamps } }));
  }
}
