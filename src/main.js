// Composition root: build the transport/protocol/controllers on connect, wire
// the UI panels to them, and make sure nothing keeps driving when it should not.

import { LegoBLETransport } from './ble-transport.js';
import { LegoProtocol } from './lego-protocol.js';
import { log, initDebugPanel } from './debug-log.js';
import { BUILD } from './version.js';
import { SteeringController } from './steering-controller.js';
import { GamepadController } from './gamepad-controller.js';
import { PlayVmController } from './playvm-controller.js';
import { createMacroHost } from './macro/host.js';
import { $ } from './ui/dom.js';
import { blurShouldStop } from './focus-guard.js';
import { initTabs } from './ui/tabs.js';
import { createCollisionGuard } from './collision.js';
import { createHapticsMix } from './haptics-mix.js';
import { createHapticsDriver } from './haptics-driver.js';
import { initHapticsPanel } from './ui/haptics.js';
import { initMotorPanel } from './ui/motors.js';
import { initSteeringPanel } from './ui/steering.js';
import { initLampPanel } from './ui/lamps.js';
import { initLedPanel } from './ui/led.js';
import { initGamepadPanel } from './ui/gamepad.js';
import { initProbePanel } from './ui/probe.js';
import { initTelemetryPanel } from './ui/telemetry.js';
import { initCollisionPanel } from './ui/collision.js';
import { initMotionPanel } from './ui/motion.js';
import { initDrivePanel } from './ui/drive-panel.js';
import { initMacroPanel } from './ui/macros.js';
import { initWire } from './ui/wire.js';
import { initShare } from './ui/share.js';

const support = $('support'), connectBtn = $('connect');
const ports = $('ports');
const tabs = initTabs();

// One call site for status, mirrored into the always-visible chrome chip so the
// link state is readable from any tab.
// See docs/DESIGN-NOTES.md § Status words are for problems; the dot carries a healthy link
function setStatus(text, state) {
  const problem = state === 'down' || state === 'warn';
  $('status').hidden = !problem;
  $('status').textContent = text;
  $('status-full').textContent = text;
  // The chip is the dot and nothing else: the words were duplicated by the line
  // below it and truncated to uselessness at the width the bar can spare. They
  // live in the tooltip, in the Hub tab, and in the debug log.
  // See docs/DESIGN-NOTES.md § Status words are for problems; the dot carries a healthy link
  const chip = $('chrome-status');
  chip.title = text;
  chip.setAttribute('aria-label', `Link status: ${text} — open the Hub tab`);
  $('state-dot').className = state ?? '';
}

initDebugPanel();
// First line of every session.
// See docs/DESIGN-NOTES.md § The build stamp is the first line of every session
log('build', BUILD);

// The live connection. Panels read it at event time because it only exists
// between connect and disconnect.
// See docs/DESIGN-NOTES.md § Panels read the hub at event time
const hub = { transport: null, protocol: null, steering: null, gamepad: null, haptics: null };

const motors = initMotorPanel(hub);
const collisionPanel = initCollisionPanel(hub);
const hapticsPanel = initHapticsPanel(hub);
const steerPanel = initSteeringPanel(hub);
const lamps = initLampPanel(hub);
const telemetry = initTelemetryPanel(hub);
const gp = initGamepadPanel(hub, { onRunChange: keepAwake });
initLedPanel(hub);
initProbePanel(hub);
const motion = initMotionPanel(hub);
const drivePanel = initDrivePanel(hub);
tabs.onChange((name) => {
  motion.setActive(name === 'motion');
  drivePanel.setActive(name === 'drive');
});
// The landing tab never arrives as a change, so state it once here.
drivePanel.setActive(tabs.current() === 'drive');
// The landing's live frame. Harmless before a hub exists — it writes nowhere.
initWire();
// Reveals the copy button when there is a clipboard to copy into.
initShare();

// hub.macro exists before the panel reads it for its initial Run-enabled
// paint — the panel itself still reads hub.macro at event time thereafter.
hub.macro = createMacroHost(hub, {
  spawnWorker: () => new Worker(new URL('./macro/worker.js', import.meta.url), { type: 'module' }),
  onState: (s, detail) => {
    macroPanel.showState(s, detail);
    if (s === 'arming') hub.gamepad?.watch();
    if (s === 'idle' || s === 'failed') hub.gamepad?.unwatch();
  },
  onPrint: (args) => macroPanel.showPrint(args),
  onNotice: (text) => macroPanel.showNotice(text),
});
const macroPanel = initMacroPanel(hub);

// Sources first, power second. The order is load-bearing.
// See docs/DESIGN-NOTES.md § The emergency stop closes the sources before it cuts power
// The steering loop is stopped before the power is cut because it would
// otherwise drive the steer motor straight back at its target.
function motionStop() {
  hub.playvm?.stop();
  hub.steering?.stop();
  motors.stopAll();
  hub.protocol?.emergencyStop?.();
}

// `reason` is what the Macros panel shows the operator once the run ends.
function emergencyStop(reason = 'emergency stop') {
  // Ahead of gp.disable(): the run ends synchronously and unwatches the pad,
  // and a stop() is refused while watching.
  // See docs/DESIGN-NOTES.md § Watch mode suppresses every source, not just the pad
  hub.macro?.abort(reason);
  // The on-screen controls are a source too, and they are released before the
  // loop: it is still armed for another frame and would re-command from them.
  drivePanel.reset();
  gp.disable();
  steerPanel.forceRaw();
  motionStop();
}



// The landing's call to action and the chrome button are the same action; a
// visitor should not have to hunt for the small one at the top.
// See docs/DESIGN-NOTES.md § Status words are for problems; the dot carries a healthy link
const ctaBtn = $('cta-connect');
const ctaNote = $('cta-note');

if (!navigator.bluetooth) {
  support.textContent = '❌ Web Bluetooth NOT available. Use Chrome on Android or desktop.';
  connectBtn.disabled = true;
  if (ctaBtn) ctaBtn.disabled = true;
  if (ctaNote) ctaNote.textContent = 'This browser has no Web Bluetooth — see “What you need”.';
} else {
  // Deliberately blank: nothing to announce when it works.
  support.textContent = '';
  connectBtn.disabled = false;
  connectBtn.addEventListener('click', onConnect);
  if (ctaBtn) ctaBtn.addEventListener('click', onConnect);
  if (ctaNote) ctaNote.textContent = 'Your browser supports Web Bluetooth.';
}

let connectInFlight = false;

async function onConnect() {
  if (connectInFlight || hub.transport?.connected) return;
  connectInFlight = true;
  const transport = new LegoBLETransport();
  const protocol = new LegoProtocol(transport, {
    onBrake: () => hub.haptics?.hit('brake', 0.6),
  });
  hub.transport = transport;
  hub.protocol = protocol;
  hub.collision = createCollisionGuard(protocol);
  const hapticsMix = createHapticsMix();
  hub.haptics = createHapticsDriver({
    mix: hapticsMix,
    onStatus: (state) => hapticsPanel.showStatus(state),
  });
  hub.haptics.attach(window);
  hapticsPanel.attach();
  // The guard cuts nothing itself. This is the only stop that closes the
  // sources first — without it the combined frame is re-sent on the next
  // heartbeat and the car drives off after the crash.
  // See docs/DESIGN-NOTES.md § A stop that only covers the per-motor path leaves the car driving
  // 'cut' fires for every mode but 'notify' and 'off'. In 'stop' mode the
  // motion is cut and the run lives on, so the impact below can reach a macro
  // waiting on it; every other mode ends the run.
  // See docs/DESIGN-NOTES.md § collision('stop') cuts the motion without ending the run
  // A collision cuts the motors but leaves the loop armed — the driver keeps
  // control without re-arming. Non-'stop' modes still end a macro run.
  // See docs/DESIGN-NOTES.md § A collision cuts the motors but keeps the loop armed
  hub.collision.addEventListener('cut', (e) => {
    hub.haptics?.hit('cut', 1);
    if (e.detail?.mode !== 'stop') hub.macro?.abort('collision');
    motionStop();
  });
  hub.collision.addEventListener('impact', (e) => {
    setStatus(`collision detected (${e.detail.magnitude}mG)`, 'warn');
    hub.haptics?.hit('impact', Math.min(1, e.detail.magnitude / 3500));
    if (e.detail.mode === 'abort') hub.macro?.abort('collision');
  });

  transport.addEventListener('disconnected', (e) => {
    log('DISCONNECTED:', e.detail?.reason ?? '(no reason)');
    // One way out for every loss of control. Sources first, then power — and
    // the controllers are only dropped after the stop has run through them.
    emergencyStop('disconnected');
    setStatus(`disconnected: ${e.detail?.reason ?? ''}`, 'down');
    tabs.setConnected(false);
    if (hub.steering) { hub.steering.stop(); hub.steering = null; }
    hub.playvm = null;
    hub.gamepad = null;
    hub.collision = null;
    hub.haptics?.silence();
    hub.haptics?.detach();
    hub.haptics = null;
    hapticsPanel.reset();
    collisionPanel.reset();
    motion.reset();
    drivePanel.reset({ linkLost: true });
  });
  protocol.addEventListener('attached-io', () => {
    ports.textContent = 'ports: ' + Object.entries(protocol.roles)
      .map(([k, v]) => `${k}=0x${v.toString(16)}`).join(', ');
  });
  protocol.addEventListener('ready', async () => {
    setStatus('ready', 'up');
    tabs.setConnected(true);
    motors.build(protocol.roles);
    // Battery is the only stream armed here — it is cheap. Motion telemetry is
    // opt-in via the Telemetry button.
    // See docs/DESIGN-NOTES.md § Motion telemetry is off by default
    await protocol.subscribeBattery();
    await protocol.requestBattery();
    // The hub's own alert channel. Reported and logged only — nothing acts on
    // it until a hardware session shows what actually arrives.
    await protocol.subscribeHubAlerts();
    protocol.addEventListener('hub-alert', (e) => {
      const { name, active } = e.detail;
      if (active) setStatus(`hub alert: ${name ?? 'unknown'}`, 'warn');
      // Alerts stay log-only, with one exception: a car going out of range on
      // the raw path has nothing standing behind it, and the BLE supervision
      // timeout can be 32s of a car still running its last command.
      if (active && name === 'low-signal') hub.macro?.abort('low signal');
    });
    if (protocol.roles.steer != null) {
      const steering = new SteeringController(protocol, protocol.roles.steer);
      hub.steering = steering;
      steering.addEventListener('pos', (e) => {
        steerPanel.showPos(e.detail);
        motion.showSteer(e.detail);
        drivePanel.showSteerPos(e.detail);
      });
      // The controller drops itself to raw mode on runaway — reflect that.
      steering.addEventListener('runaway', (e) => {
        steerPanel.showMode();
        setStatus(`steering runaway at ${e.detail.pos}° — power cut, re-zero`);
      });
      // Same story when the position stream goes quiet mid-move.
      // See docs/superpowers/specs/2026-07-30-motion-visualisation-design.md § Zero lost mid-session
      steering.addEventListener('feedback-lost', (e) => {
        steerPanel.showMode();
        setStatus(`steering feedback lost at ${e.detail.pos}° — power cut, re-arm steer`);
        motion.showSteer({ pos: e.detail.pos, zeroed: false });
        // The drive dial reads the zero flag off the controller itself, which
        // has already dropped it — the position alone is enough here.
        drivePanel.showSteerPos({ pos: e.detail.pos });
      });
      await steering.start();
    }
    hub.playvm = new PlayVmController(protocol);
    // The controller is rebuilt on every reconnect and carries no settings, so
    // the stored reversal has to be pushed onto the new instance from here.
    drivePanel.applyInvert();
    hub.gamepad = new GamepadController(protocol, protocol.roles, hub.steering,
      motors.shouldBrake, hub.playvm);
    hub.gamepad.haptics = hub.haptics;
    // Fires on touch, not on release — an absent or centred pad emits nothing.
    hub.gamepad.addEventListener('input', () => hub.macro?.abort('gamepad'));
    // A crash mid-watch leaves no way to detect a further touch; end the run
    // now rather than leave it un-abortable. No-op if nothing is running.
    hub.gamepad.addEventListener('crashed', () => hub.macro?.abort('gamepad crashed'));
    gp.attach?.(hub.gamepad);
    hub.gamepad.addEventListener('state', (e) => {
      gp.showState(e.detail);
      drivePanel.showState(e.detail);
    });
    // The effective mode, which is not always the one that was asked for — so
    // this is attached before the default is applied, not after.
    hub.gamepad.addEventListener('drivemode', (e) => drivePanel.showMode(e.detail.mode));
    hub.gamepad.addEventListener('mapped', () => gp.renderMapping());
    // Applying the default is what makes it real; it arms the port and sweeps
    // the steering rack. See docs/DESIGN-NOTES.md § The hub's own drive mode is the default, and applying it is what makes it real
    await hub.gamepad.setDriveMode(hub.gamepad.params.driveMode);
    // See docs/DESIGN-NOTES.md § Lamp state has one source of truth
    hub.gamepad.addEventListener('lamps', (e) => lamps.showLamps(e.detail.lamps));
    gp.renderMapping();
    collisionPanel.sync();
  });
  protocol.addEventListener('orientation', (e) => {
    motion.showOrientation(e.detail);
    drivePanel.showOrientation(e.detail);
  });
  protocol.addEventListener('tilt', (e) => telemetry.showTilt(e.detail));
  protocol.addEventListener('battery', (e) => telemetry.showBattery(e.detail.percent));
  protocol.addEventListener('speed', (e) => motors.showSpeed(e.detail.port, e.detail.speed));

  try {
    setStatus('connecting…');
    await transport.connect();
    setStatus('connected, discovering…');
  } catch (err) {
    setStatus(`error: ${err.message}`);
  } finally {
    connectInFlight = false;
  }
}

// Keep the browser out of the way while driving. On Android a gamepad also
// emits key events (D-pad arrives as arrow keys), and those scroll the page —
// so swallow them while the control loop is armed.
const SWALLOW_KEYS = [' ', 'Spacebar', 'Enter', 'Backspace', 'Tab',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
window.addEventListener('keydown', (e) => {
  if (gp.running && SWALLOW_KEYS.includes(e.key)) e.preventDefault();
}, { passive: false });

// Screen wake lock is dropped whenever the page hides, so it must be re-taken.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not fatal */ }
}

// Losing focus cuts the motors but leaves the loop armed: the poll guard stops
// it commanding off a frozen pad, and driving resumes on return without a
// re-arm. See docs/DESIGN-NOTES.md § Focus loss stops the motors but keeps the loop armed
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    motionStop();
    // Both measuring panels are stood down the same way, so both are stood back
    // up the same way. Drive used to be stood down by `reset()` clearing its
    // measured flag, which nothing ever set again.
    motion.setActive(false);
    drivePanel.setActive(false);
  } else {
    motion.setActive(tabs.current() === 'motion');
    drivePanel.setActive(tabs.current() === 'drive');
  }
});

// visibilitychange never fires for a blur that keeps the tab visible — devtools
// taking focus, a window on a second monitor, a notification. The pad's reading
// freezes there just as it does when hidden, so blur cuts the motors too — but
// leaves the loop armed, so returning resumes driving without a re-arm.
// See docs/DESIGN-NOTES.md § Focus loss stops the motors but keeps the loop armed
window.addEventListener('blur', () => {
  if (!blurShouldStop({ running: hub.gamepad?.running, hasFocus: document.hasFocus?.bind(document) })) return;
  motionStop();
  motion.setActive(false);
  drivePanel.setActive(false);
});

window.addEventListener('gamepadconnected', (e) => log('gamepad connected:', e.gamepad.id, 'mapping:', e.gamepad.mapping));
window.addEventListener('gamepaddisconnected', () => {
  // Losing the pad while a finger is on a control is not a loss of control:
  // tearing the loop down here would take the other source with it. Power is
  // cut all the same; the finger re-commands it on the next frame. The loop's
  // own mixer answers this — a thumb resting inside the deadzone commands
  // nothing and must not suppress the stop.
  // Never while a macro is running: the pad is that run's abort channel, and a
  // held control commands nothing until the run ends, so leaving the loop up
  // here would cut the motors under a macro that goes on driving them.
  // See docs/DESIGN-NOTES.md § Watch mode suppresses every source, not just the pad
  const macroLive = (hub.macro?.state ?? 'idle') !== 'idle';
  if (!macroLive && hub.gamepad?.anyEngaged?.()) {
    log('gamepad disconnected - on-screen controls still held, motors cut, loop left armed');
    motors.stopAll();
    hub.protocol?.emergencyStop?.();
    return;
  }
  log('gamepad disconnected - full stop');
  emergencyStop();
});
