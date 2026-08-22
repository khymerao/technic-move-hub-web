// Steering control for the steer motor.
//
// Two modes:
//   'raw'   — plain motor: hold a button, it spins; release, it floats.
//   'steer' — closed-loop: live POS feedback drives a P-controller toward a
//             target angle, entirely on the StartSpeed path.
//
// GotoAbsolutePosition is NOT used; zero is captured in software; the throw is
// fixed rather than swept for. All three are deliberate:
//   docs/DESIGN-NOTES.md § The position-command family crashes this hub's firmware
//   docs/DESIGN-NOTES.md § Steering zero is tracked in software
//   docs/DESIGN-NOTES.md § The throw is fixed, not discovered

import { positionControlStep, relativePos, isRunaway } from './steering-cal.js';
import { log } from './debug-log.js';

export class SteeringController extends EventTarget {
  #protocol; #port; #raf = 0;
  #rawPos = 0; #zeroOffset = 0; #target = 0; #lastSpeed = null; #lastSendAt = 0;
  #zeroed = false;
  // -Infinity, not 0 — see docs/DESIGN-NOTES.md § `#lastPosAt` starts at -Infinity, not 0
  #lastPosAt = -Infinity;
  #moveSince = 0;
  mode = 'raw';
  params = {
    turnSpeed: 40,      // max speed the P-loop may command
    maxAngle: 90,       // degrees of throw each side of zero
    kp: 0.3,            // proportional gain — kept low against BLE lag
    deadband: 8,        // degrees of slop before the motor is told to move
    minPower: 6,        // below this the motor stalls instead of turning
    sendIntervalMs: 60, // floor between motor commands
    invert: false,      // flip if positive speed moves position negative
    autoReturn: true,   // return to zero when input is released
    feedbackTimeoutMs: 1000, // silence from the position stream that ends the loop
  };

  constructor(protocol, port) {
    super();
    this.#protocol = protocol;
    this.#port = port;
    protocol.addEventListener('position', (e) => {
      if (e.detail.port !== this.#port) return;
      this.#rawPos = e.detail.pos;
      this.#lastPosAt = performance.now();
    });
  }

  // Position relative to the software zero.
  get pos() { return relativePos(this.#rawPos, this.#zeroOffset); }
  get target() { return this.#target; }
  get isZeroed() { return this.#zeroed; }

  // No position stream here; enterSteerMode() arms it when it is needed.
  // See docs/DESIGN-NOTES.md § The position stream is not armed until closed-loop actually needs it
  async start() {
    if (this.#raf) return;
    const tick = () => { this.#step(); this.#raf = requestAnimationFrame(tick); };
    this.#raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.#raf);
    this.#raf = 0;
    this.#lastSpeed = null;
    this.#moveSince = 0;
    this.#protocol.setMotorSpeedRaw(this.#port, 0);
  }

  // Current position becomes zero, tracked in software.
  // See docs/DESIGN-NOTES.md § Steering zero is tracked in software
  setZero() {
    this.#zeroOffset = this.#rawPos;
    this.#target = 0;
    this.#lastSpeed = null;
    this.#zeroed = true;
    log('steering: zero set at raw', this.#zeroOffset);
    this.dispatchEvent(new CustomEvent('zeroed'));
  }

  async enterSteerMode() {
    // See docs/DESIGN-NOTES.md § Re-entering steer mode must re-subscribe
    const stale = performance.now() - this.#lastPosAt > this.params.feedbackTimeoutMs;
    await this.#protocol.subscribeToPosition(this.#port, 15, 'steering', stale);
    if (!this.#zeroed) this.setZero();
    this.#target = 0;
    this.#lastSpeed = null;
    this.#moveSince = 0;
    this.mode = 'steer';
  }

  // input -100..100 maps onto ±maxAngle. Only meaningful in 'steer' mode.
  setInput(input) {
    const i = Math.max(-100, Math.min(100, input)) / 100;
    this.#target = Math.round(i * this.params.maxAngle);
  }

  // Called when the user lets go of the control.
  release() {
    if (this.params.autoReturn) this.#target = 0;
  }

  // 'raw' mode: drive the motor directly, no position control.
  jog(dir) {
    this.#protocol.setMotorSpeedRaw(this.#port, Math.sign(dir) * this.params.turnSpeed);
  }
  jogStop() {
    this.#protocol.setMotorSpeedRaw(this.#port, 0);
  }

  // Leave closed-loop with the motor floating. Zero stays valid unless the
  // caller invalidates it — see docs/DESIGN-NOTES.md § Leaving closed-loop keeps the zero
  #abortSteer(reason, detail) {
    this.mode = 'raw';
    this.#lastSpeed = null;
    this.#moveSince = 0;
    this.#protocol.setMotorSpeedRaw(this.#port, 0);
    this.dispatchEvent(new CustomEvent(reason, { detail }));
  }

  #step() {
    const pos = this.pos;
    if (this.mode === 'steer') {
      // See docs/DESIGN-NOTES.md § A runaway means the mechanism, not the loop, is wrong
      if (isRunaway(pos, this.params.maxAngle)) {
        log('steering: RUNAWAY at pos', pos, '- cutting power, back to raw mode');
        this.#abortSteer('runaway', { pos });
        this.#zeroed = false; // force a fresh zero before re-arming
      } else {
        let speed = positionControlStep(this.#target, pos, {
          kp: this.params.kp,
          maxSpeed: this.params.turnSpeed,
          deadband: this.params.deadband,
          minPower: this.params.minPower,
        });
        if (this.params.invert) speed = -speed;
        const now = performance.now();
        if (speed === 0) {
          this.#moveSince = 0;
        } else {
          if (!this.#moveSince) this.#moveSince = now;
          // Only quiet time that overlaps commanded movement counts.
          // See docs/DESIGN-NOTES.md § Commanding movement with no position feedback is open-loop driving
          const quietSince = Math.max(this.#moveSince, this.#lastPosAt);
          if (now - quietSince > this.params.feedbackTimeoutMs) {
            log('steering: no position feedback for', this.params.feedbackTimeoutMs,
              'ms while driving - cutting power, back to raw mode');
            this.#abortSteer('feedback-lost', { pos, target: this.#target });
            this.#zeroed = false; // force a fresh zero before re-arming
          }
        }
        // See docs/DESIGN-NOTES.md § The P-loop is rate-limited because BLE lag oscillates it
        const due = now - this.#lastSendAt >= this.params.sendIntervalMs;
        // An abort above already cut power and left steer mode; do not re-command.
        if (this.mode === 'steer' && speed !== this.#lastSpeed && (due || speed === 0)) {
          this.#lastSpeed = speed;
          this.#lastSendAt = now;
          this.#protocol.setMotorSpeedRaw(this.#port, speed);
        }
      }
    }
    this.dispatchEvent(new CustomEvent('pos', {
      detail: { pos, target: this.#target, mode: this.mode, zeroed: this.#zeroed },
    }));
  }
}
