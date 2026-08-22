// Drives the car through the hub's own combined frame on port 0x36: one write
// carries speed, steering and lights, and the hub's internal controller holds
// the steering angle instead of our P-loop.

import { encodePlayVmFrame, PLAYVM_LIGHTS } from './lwp-encoders.js';
import { PLAYVM_PORT } from './lwp-decoders.js';
import { playVmInit } from './playvm-drive.js';
import { log } from './debug-log.js';

// Floor between writes. Not optional, and not covered by the write queue.
// See docs/DESIGN-NOTES.md § Rate limiting is not optional on this path
export const PLAYVM_MIN_INTERVAL_MS = 60;

// How often a live command is resent, against the hub's own watchdog.
// See docs/DESIGN-NOTES.md § The hub stops the motors unless the command is refreshed
export const PLAYVM_HEARTBEAT_MS = 500;

// How long a refresh may outlive the input that asked for it.
// See docs/DESIGN-NOTES.md § The heartbeat overrides the hub's failsafe, so it carries its own
export const PLAYVM_COMMAND_TTL_MS = 1000;

// See docs/DESIGN-NOTES.md § A command too small to move the car still counts as moving
export const PLAYVM_DEADBAND = 3;

// Latest-wins with a guaranteed trailing send — the dropped value would be the stop.
// The timer functions are WRAPPED, never passed by reference:
// see docs/DESIGN-NOTES.md § Browser timer functions must be wrapped, not passed by reference
export function createRateLimitedSender(send, {
  intervalMs = PLAYVM_MIN_INTERVAL_MS,
  now = () => performance.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
} = {}) {
  let lastAt = -Infinity, pending = null, timer = 0;

  const flush = () => {
    timer = 0;
    if (pending == null) return;
    const payload = pending;
    pending = null;
    lastAt = now();
    send(payload);
  };

  return {
    push(payload) {
      const t = now();
      if (!timer && t - lastAt >= intervalMs) {
        lastAt = t;
        send(payload);
        return;
      }
      pending = payload;
      if (!timer) timer = schedule(flush, Math.max(0, intervalMs - (t - lastAt)));
    },
    // Bypasses the floor. Only for stops.
    flushNow() {
      if (timer) { cancel(timer); timer = 0; }
      if (pending == null) return;
      const payload = pending;
      pending = null;
      lastAt = now();
      send(payload);
    },
    cancel() {
      if (timer) { cancel(timer); timer = 0; }
      pending = null;
    },
  };
}

export class PlayVmController {
  #protocol;
  #sender;
  #armed = false;
  #speed = 0;
  #steer = 0;
  #lights = PLAYVM_LIGHTS.OFF;
  #lastKey = null;

  #init;
  #heartbeatMs;
  #ttlMs;
  #lastSetAt = -Infinity;
  #schedule;
  #now;
  #cancelTimer;
  #beat = 0;

  // init is injectable so this class can be exercised without the hardware
  // handshake it would otherwise have to complete first.
  constructor(protocol, options = {}) {
    this.#protocol = protocol;
    this.#init = options.init ?? playVmInit;
    this.#heartbeatMs = options.heartbeatMs ?? PLAYVM_HEARTBEAT_MS;
    this.#ttlMs = options.commandTtlMs ?? PLAYVM_COMMAND_TTL_MS;
    this.#now = options.now ?? (() => performance.now());
    // Wrapped, not referenced — see createRateLimitedSender above.
    this.#schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.#cancelTimer = options.cancel ?? ((id) => clearTimeout(id));
    this.#sender = createRateLimitedSender(
      (bytes) => { this.#protocol.sendRaw(bytes, 'playvm'); },
      options,
    );
  }

  get armed() { return this.#armed; }
  get lights() { return this.#lights; }

  // Arming sweeps the steering rack to its end stops, so it is never implicit.
  // See docs/DESIGN-NOTES.md § Arming is never implicit
  async arm() {
    const result = await this.#init(this.#protocol);
    this.#armed = result.ok;
    return result;
  }

  disarm() {
    this.stop();          // still armed here, so the stop does reach the hub
    this.#sender.cancel();
    this.#armed = false;
  }

  setLights(lights) {
    this.#lights = lights;
    this.#push();
  }

  set(speed, steer) {
    const clamp = (v) => {
      const n = Math.max(-100, Math.min(100, Math.round(v)));
      return Math.abs(n) < PLAYVM_DEADBAND ? 0 : n;
    };
    this.#speed = clamp(speed);
    this.#steer = clamp(steer);
    // Renews the licence to keep refreshing; see #keepAlive's dead man's switch.
    this.#lastSetAt = this.#now();
    this.#push();
  }

  // Zero and send immediately: a stop that waits out the rate limit is a car
  // that keeps going. Silent when the port was never armed —
  // see docs/DESIGN-NOTES.md § The combined-frame stop is silent when the port was never armed
  stop() {
    this.#speed = 0;
    this.#steer = 0;
    this.#lastKey = null;
    this.#sender.cancel();
    this.#stopHeartbeat();
    if (!this.#armed) return;
    this.#protocol.sendRaw(
      encodePlayVmFrame(PLAYVM_PORT, 0, 0, this.#lights), 'playvm');
  }

  #stopHeartbeat() {
    if (this.#beat) { this.#cancelTimer(this.#beat); this.#beat = 0; }
  }

  // Only a moving command needs refreshing; at rest the hub is already stopped.
  #keepAlive() {
    this.#stopHeartbeat();
    if (!this.#armed || (!this.#speed && !this.#steer)) return;
    this.#beat = this.#schedule(() => {
      this.#beat = 0;
      // Dead man's switch — the heartbeat's own failsafe. Do not remove.
      // See docs/DESIGN-NOTES.md § The heartbeat overrides the hub's failsafe, so it carries its own
      if (this.#now() - this.#lastSetAt > this.#ttlMs) {
        log('playvm: no input for ' + this.#ttlMs + 'ms — releasing the held frame');
        this.stop();
        return;
      }
      this.#lastKey = null;   // the whole point is to repeat an unchanged frame
      this.#push();
    }, this.#heartbeatMs);
  }

  #push() {
    if (!this.#armed) return;
    // An unchanged frame carries no information and still costs a write. The
    // heartbeat bypasses this by clearing #lastKey, not by skipping the check.
    // See docs/DESIGN-NOTES.md § The heartbeat repeats a frame the deduplicator would otherwise drop
    const key = `${this.#speed}:${this.#steer}:${this.#lights}`;
    if (key === this.#lastKey) return;
    this.#lastKey = key;
    this.#sender.push(encodePlayVmFrame(PLAYVM_PORT, this.#speed, this.#steer, this.#lights));
    this.#keepAlive();
  }
}
