// Collision guard: on a hard knock, cut the motors and flash every lamp.
//
// See docs/DESIGN-NOTES.md § The filtering happens in the hub, not here

import { impactMagnitude, isImpact } from './impact.js';
import { log } from './debug-log.js';

const ALL_LAMPS = 0x3f;

export function createCollisionGuard(protocol, options = {}) {
  // The guard detects and announces. What the app does about an impact is
  // decided in main.js, which is the only place that can close the sources
  // before it cuts the power.
  // See docs/DESIGN-NOTES.md § The emergency stop closes the sources before it cuts power
  const bus = new EventTarget();
  let armed = false;
  let last = null;
  let flashing = false;
  let lastHitAt = 0;
  // What an impact should do to a running macro.
  // See docs/superpowers/specs/2026-07-28-macro-system-design.md § Impact is a program input
  let mode = 'abort';

  const params = {
    thresholdMg: 1400, // was 1800; wall-grind often never spiked that high (see collision-defaults)
    flashes: 4,
    flashMs: 120,
    cooldownMs: 1500,  // one crash must not retrigger on its own rebound
    ...options,
  };

  async function flashLamps() {
    if (params.flashes < 1) return;
    if (flashing) return;
    flashing = true;
    try {
      for (let i = 0; i < params.flashes; i++) {
        await protocol.setLights(ALL_LAMPS, 100);
        await wait(params.flashMs);
        await protocol.setLights(ALL_LAMPS, 0);
        await wait(params.flashMs);
      }
    } finally {
      flashing = false;
    }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Roughly half the trigger threshold — see the note above on hub-side filtering.
  const hubDelta = () => Math.max(1, Math.round(params.thresholdMg / 2));

  async function onAccel(e) {
    const cur = e.detail;
    // The answer to somebody's one-shot read, not a delivered sample.
    // See docs/DESIGN-NOTES.md § A polled vector must not enter the guard's sample chain
    if (cur?.polled) return;
    const magnitude = impactMagnitude(last, cur);
    last = cur;
    if (!armed || !isImpact(magnitude, params.thresholdMg)) return;
    // Before the cooldown stamp, not after: a hit taken while off must not
    // suppress the next real one. The line is the only trace off leaves.
    // See docs/DESIGN-NOTES.md § collision('stop') cuts the motion without ending the run
    if (mode === 'off') {
      log(`COLLISION: ${magnitude}mG (mode off — not recorded, not acted on)`);
      return;
    }

    const now = Date.now();
    if (now - lastHitAt < params.cooldownMs) return;
    lastHitAt = now;

    log(`COLLISION: ${magnitude}mG`);
    // Announced synchronously, so the listener's stop runs before anything
    // else this handler does. flashLamps is deliberately not awaited.
    // See docs/DESIGN-NOTES.md § Power first, lights second
    // The mode rides along: 'abort' asks for the full stop, 'stop' for the
    // motion only. The impact below has to reach a macro waiting on it.
    // See docs/DESIGN-NOTES.md § collision('stop') cuts the motion without ending the run
    if (mode !== 'notify') bus.dispatchEvent(new CustomEvent('cut', { detail: { mode } }));
    bus.dispatchEvent(new CustomEvent('impact', { detail: { magnitude, mode } }));
    flashLamps();
  }

  protocol.addEventListener('accel', onAccel);

  return {
    params,
    get armed() { return armed; },
    get mode() { return mode; },
    setMode(next) {
      if (!['abort', 'stop', 'notify', 'off'].includes(next)) {
        throw new Error(`unknown collision mode: ${next}`);
      }
      mode = next;
    },
    // The hub filters below its own delta, so a change here has to move the
    // subscription with it or nothing under the armed delta ever arrives.
    // See docs/DESIGN-NOTES.md § The filtering happens in the hub, not here
    async setThreshold(mg) {
      params.thresholdMg = mg;
      if (!armed) return;
      await protocol.subscribeToAccel(hubDelta(), undefined, 'collision');
    },
    async arm() {
      if (armed) return;
      armed = true;
      last = null;
      await protocol.subscribeToAccel(hubDelta(), undefined, 'collision');
      log('collision guard armed');
    },
    async disarm() {
      if (!armed) return;
      armed = false;
      await protocol.unsubscribeAccel('collision');
      log('collision guard disarmed');
    },
    addEventListener: (type, fn, opts) => bus.addEventListener(type, fn, opts),
    removeEventListener: (type, fn, opts) => bus.removeEventListener(type, fn, opts),
  };
}
