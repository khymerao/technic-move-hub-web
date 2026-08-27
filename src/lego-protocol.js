// High-level LWP 3.0 protocol: wraps a transport, discovers devices by IOType,
// exposes drive/LED/IMU commands, and emits parsed telemetry events.

import {
  encodeMotorSpeed, encodeLedColor, encodeInputFormatSetup,
  encodeWriteDirectMode, encodeMotorFloat, encodeMotorBrake, encodePresetEncoder,
  applyInvert, encodeStartSpeedForTime,
  encodeVirtualPortConnect, encodeInputFormatDisable, encodeHubAlertSubscribe,
  encodePortValueRequest,
} from './lwp-encoders.js';
import {
  parseHubAttachedIO, parsePortValueSingle, buildRoleMap, EXPECTED_PORTS, parseInt32LE,
  parseHubProperty, LIGHTS_PORT, parseVector16, parseWords16, ACCEL_PORT, ORINT_PORT,
  parsePortInformation, parsePortModeInformation, parseHubAlert, HUB_ALERT,
} from './lwp-decoders.js';
import { log } from './debug-log.js';
import { createBrakePolicy } from './brake-policy.js';
import { createStreamRegistry } from './stream-registry.js';

export class LegoProtocol extends EventTarget {
  #transport;
  #events = [];
  #ready = false;
  roles = {};
  imuPort = EXPECTED_PORTS.imu;
  _posPorts = new Set();
  _speedPorts = new Set();
  _accelPort = null;
  _orintPort = null;
  _orintMode = null;
  // Who holds which input stream. The three sets above stay as the fast path
  // #onData reads on every incoming value; this is the bookkeeping behind them.
  streams = createStreamRegistry();
  _attachedPorts = [];
  // Ports whose motor is mounted mirrored.
  invertedPorts = new Set();
  #lastMotorCmd = new Map(); // port -> last command signature, to drop repeats
  #timedSeq = 0; // per-call counter, so every timed slice gets its own queue key
  // port -> the reads on it that are still owed a reply. One request is owed
  // exactly one 0x45, and resolving the promise does not prove which frame it
  // was, so the debt outlives the answer.
  // See docs/DESIGN-NOTES.md § A polled vector must not enter the guard's sample chain
  #polling = new Map();
  #setTimer;
  #clearTimer;
  // One policy for every motor — the single-port and pair paths share keys.
  // See docs/DESIGN-NOTES.md § A second brake request must not restart the staging
  #brake;

  // now/setTimer/clearTimer are optional and default to the real clock, so
  // every existing caller (`new LegoProtocol(transport)`) is unaffected.
  // See docs/DESIGN-NOTES.md § The brake policy's clock is now a seam, not a wall
  constructor(transport, {
    now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
    onBrake = () => {},
  } = {}) {
    super();
    this.#transport = transport;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#brake = createBrakePolicy({ now, setTimer, clearTimer, onBrake });
    transport.addEventListener('data', (e) => this.#onData(e.detail));
  }

  // Every inbound frame is a switch on its message type (byte 2). The trial
  // chain this replaced re-parsed the frame once per candidate — up to eight
  // parseMessage+slice allocations for a single streaming 0x45 sample.
  // See docs/DESIGN-NOTES.md § Inbound frames dispatch on the type byte, not a parse chain
  #onData(bytes) {
    log('recv', bytes);
    if (!bytes || bytes.length < 3) return;
    switch (bytes[2]) {
      case 0x01: {
        const prop = parseHubProperty(bytes);
        if (prop?.property === 0x06) {
          this.dispatchEvent(new CustomEvent('battery', { detail: { percent: prop.payload[0] } }));
        }
        return;
      }
      // Port Output Command Feedback (0x82) and Generic Error (0x05): the hub's
      // two possible answers to a write. Silence is the caller's to detect.
      // See docs/DESIGN-NOTES.md § Both the write acknowledgement and the error have to be surfaced
      case 0x82:
        for (let i = 3; i + 1 < bytes.length; i += 2) {
          this.dispatchEvent(new CustomEvent('port-feedback',
            { detail: { port: bytes[i], status: bytes[i + 1] } }));
        }
        return;
      case 0x05:
        this.dispatchEvent(new CustomEvent('protocol-error',
          { detail: { command: bytes[3], code: bytes[4] } }));
        return;
      // Hub Alerts (0x03). Deliberately log-and-report only: these have never
      // been observed on this hub, so nothing acts on them yet.
      // See docs/superpowers/specs/2026-07-28-macro-system-design.md § Layer 2
      case 0x03: {
        const alert = parseHubAlert(bytes);
        if (alert) {
          log('HUB ALERT', alert.name ?? '0x' + alert.alert.toString(16),
            alert.active ? 'ACTIVE' : 'cleared');
          this.dispatchEvent(new CustomEvent('hub-alert', { detail: alert }));
        }
        return;
      }
      // Answers to the introspection queries (0x21 / 0x22), dispatched raw.
      case 0x43: {
        const pi = parsePortInformation(bytes);
        if (pi) this.dispatchEvent(new CustomEvent('port-information', { detail: pi }));
        return;
      }
      case 0x44: {
        const pmi = parsePortModeInformation(bytes);
        if (pmi) this.dispatchEvent(new CustomEvent('port-mode-information', { detail: pmi }));
        return;
      }
      case 0x04: {
        const io = parseHubAttachedIO(bytes);
        if (io) this.#onAttachedIO(io);
        return;
      }
      case 0x45: {
        const pv = parsePortValueSingle(bytes);
        if (!pv) return;
        if (pv.port === this._accelPort) {
          const v = parseVector16(bytes);
          // Marked only when this process asked for it, so a delivered sample keeps
          // exactly the shape every other consumer already sees.
          // See docs/DESIGN-NOTES.md § A polled vector must not enter the guard's sample chain
          const polled = this.#claimReply(pv.port);
          if (v) this.dispatchEvent(new CustomEvent('accel', { detail: polled ? { ...v, polled: true } : v }));
          return;
        }
        if (this._speedPorts.has(pv.port)) {
          this.dispatchEvent(new CustomEvent('speed', { detail: { port: pv.port, speed: pv.values[0] ?? 0 } }));
        }
        if (this._posPorts.has(pv.port)) {
          this.dispatchEvent(new CustomEvent('position',
            { detail: { port: pv.port, pos: parseInt32LE(bytes, 4) } }));
        }
        if (pv.port === this.imuPort) {
          // See docs/DESIGN-NOTES.md § The tilt sensor reports words, not bytes
          const w = parseWords16(bytes, 3);
          const [x = 0, y = 0, z = 0] = w ?? pv.values;
          this.dispatchEvent(new CustomEvent('tilt', { detail: { x, y, z } }));
          this.dispatchEvent(new CustomEvent('imu-raw', { detail: { values: pv.values } }));
        }
        if (pv.port === this._orintPort) {
          const w = parseWords16(bytes, 4);
          if (w) this.dispatchEvent(new CustomEvent('orientation', { detail: { values: w } }));
        }
        // Untyped passthrough, so a probe can watch a port nothing else models.
        this.dispatchEvent(new CustomEvent('port-value',
          { detail: { port: pv.port, values: pv.values } }));
        return;
      }
      default:
        return;
    }
  }

  #onAttachedIO(io) {
    this.#events.push(io);
    if (io.event === 0x01) this._attachedPorts.push(io.port);
    this.roles = buildRoleMap(this.#events);
    log('attached-io: port=0x' + io.port.toString(16), 'event=' + io.event,
      'ioType=0x' + io.ioType.toString(16), '=> roles', this.roles);
    this.dispatchEvent(new CustomEvent('attached-io', { detail: io }));
    const drivable = this.roles.combined || this.roles.driveA;
    if (!this.#ready && this.roles.steer && this.roles.led && drivable) {
      this.#ready = true;
      log('READY', this.roles);
      this.dispatchEvent(new CustomEvent('ready', { detail: this.roles }));
    }
  }

  // Turns a registry verdict into a frame. 'none' means somebody else's
  // subscription already covers this one.
  async #applyStream(port, mode, verdict) {
    if (verdict.action === 'setup') {
      await this.#transport.sendPayload(encodeInputFormatSetup(port, mode, verdict.delta));
    } else if (verdict.action === 'disable') {
      await this.#transport.sendPayload(encodeInputFormatDisable(port, mode));
    }
  }

  async subscribeToIMU(mode = 0, delta = 5, holder = 'app') {
    log('subscribeToIMU port=0x' + this.imuPort.toString(16), 'mode=' + mode);
    await this.#applyStream(this.imuPort, mode,
      this.streams.acquire(this.imuPort, mode, delta, holder));
  }

  // Built-in 6-lamp light array (port 0x35, IOType 0x58), mode 0:
  // [0x09,0x00,0x81,0x35,0x11,0x51,0x00, mask, brightness]
  // mask = 6-bit bitmask (bit N = lamp N), brightness 0..100.
  // key: coalescing key for live control; omit it for sequences like a chase.
  async setLights(mask, brightness, key) {
    const port = this.roles.lights ?? LIGHTS_PORT;
    await this.writeDirectMode(port, 0x00, [mask & 0x3f, Math.max(0, Math.min(100, brightness))], key);
  }

  async setLed(colorInt) {
    if (this.roles.led) await this.#transport.sendPayload(encodeLedColor(this.roles.led, colorInt), 'led');
  }

  // Battery percent: Hub Properties (0x01), property 0x06.
  // op 0x05 = request once, 0x02 = enable continuous updates.
  async requestBattery() {
    await this.#transport.sendPayload(Uint8Array.of(0x05, 0x00, 0x01, 0x06, 0x05));
  }
  async subscribeBattery() {
    await this.#transport.sendPayload(Uint8Array.of(0x05, 0x00, 0x01, 0x06, 0x02));
  }

  // Four state-change notifications for the whole session. Cheap, and the only
  // channel on which the hub reports its own overload.
  async subscribeHubAlerts() {
    for (const type of Object.values(HUB_ALERT)) {
      await this.#transport.sendPayload(encodeHubAlertSubscribe(type));
    }
  }

  // Accelerometer stream. The large delta is the point — the hub only speaks up
  // when the vector jumps.
  // See docs/DESIGN-NOTES.md § The filtering happens in the hub, not here
  async subscribeToAccel(delta = 800, port = ACCEL_PORT, holder = 'app') {
    const verdict = this.streams.acquire(port, 0x00, delta, holder);
    this._accelPort = port;
    await this.#applyStream(port, 0x00, verdict);
  }

  async unsubscribeAccel(holder = 'app') {
    if (this._accelPort == null) return;
    const port = this._accelPort;
    const verdict = this.streams.release(port, 0x00, holder);
    if (verdict.action === 'disable') this._accelPort = null;
    await this.#applyStream(port, 0x00, verdict);
  }

  // The mode comes from the caller: the hardware session settled it, not this
  // layer. See docs/DESIGN-NOTES.md § A trap for the next caller
  async subscribeOrientation(mode, delta, holder = 'app') {
    log('subscribeOrientation port=0x' + ORINT_PORT.toString(16), 'mode=' + mode);
    const verdict = this.streams.acquire(ORINT_PORT, mode, delta, holder);
    this._orintPort = ORINT_PORT;
    this._orintMode = mode;
    await this.#applyStream(ORINT_PORT, mode, verdict);
  }

  async unsubscribeOrientation(holder = 'app') {
    if (this._orintPort == null) return;
    const mode = this._orintMode;
    const verdict = this.streams.release(this._orintPort, mode, holder);
    if (verdict.action === 'disable') this._orintPort = null;
    await this.#applyStream(ORINT_PORT, mode, verdict);
  }

  // Cut power everywhere at once. Used by the collision guard.
  async emergencyStop() {
    log('EMERGENCY STOP');
    await this.brakeDrive();
    if (this.roles.steer != null) await this.setMotorSpeedRaw(this.roles.steer, 0);
  }

  // Motor SPEED readback: input mode 0x01, one signed byte per update.
  // The registry enforces that a port streams exactly one mode.
  // See docs/DESIGN-NOTES.md § A port can only be interpreted as one mode at a time
  async subscribeToSpeed(port, delta = 2, holder = 'app') {
    const verdict = this.streams.acquire(port, 0x01, delta, holder);
    this._posPorts.delete(port);
    this._speedPorts.add(port);
    await this.#applyStream(port, 0x01, verdict);
  }

  // Preset the motor's POS reference (used to define steering zero).
  async presetEncoder(port, value = 0) {
    await this.#transport.sendPayload(encodePresetEncoder(port, value));
  }

  // Speed streams and the IMU only. The steering position stream stays up.
  // See docs/DESIGN-NOTES.md § The steering position stream is not telemetry
  async unsubscribeTelemetry(holder = 'app') {
    for (const port of [...this._speedPorts]) {
      const verdict = this.streams.release(port, 0x01, holder);
      if (verdict.action === 'disable') this._speedPorts.delete(port);
      await this.#applyStream(port, 0x01, verdict);
    }
    const imu = this.streams.release(this.imuPort, 0x00, holder);
    await this.#applyStream(this.imuPort, 0x00, imu);
    log('telemetry: speed and IMU streams stopped');
  }

  // `force` exists for callers that need the frame on the wire even when the
  // registry considers the subscription unchanged — e.g. reviving a dead
  // stream. The dedup is still correct for everyone else; this only bypasses
  // it for this one call.
  // See docs/DESIGN-NOTES.md § A port can only be interpreted as one mode at a time
  // See docs/DESIGN-NOTES.md § Re-entering steer mode must re-subscribe
  async subscribeToPosition(port, delta = 2, holder = 'app', force = false) {
    const verdict = this.streams.acquire(port, 0x02, delta, holder);
    this._speedPorts.delete(port);
    this._posPorts.add(port);
    const toApply = force && verdict.action === 'none'
      ? { action: 'setup', delta: verdict.delta }
      : verdict;
    await this.#applyStream(port, 0x02, toApply);
  }

  // Drop everything one holder was keeping, restoring the delta of anyone
  // still holding the same stream. Used when a macro run ends.
  async releaseStreams(holder) {
    for (const { port, mode, ...verdict } of this.streams.releaseAll(holder)) {
      if (verdict.action === 'disable') {
        if (mode === 0x01) this._speedPorts.delete(port);
        if (mode === 0x02) this._posPorts.delete(port);
        if (mode === 0x00 && port === this._accelPort) this._accelPort = null;
        if (port === this._orintPort) this._orintPort = null;
      }
      await this.#applyStream(port, mode, verdict);
    }
  }

  // Generic input stream on any port and mode, for ports nothing else models.
  async subscribePort(port, mode = 0x00, delta = 1, holder = 'probe') {
    await this.#applyStream(port, mode, this.streams.acquire(port, mode, delta, holder));
  }

  async unsubscribePort(port, mode = 0x00, holder = 'probe') {
    await this.#applyStream(port, mode, this.streams.release(port, mode, holder));
  }

  // A bare value request, answered without any InputFormatSetup in force. Every
  // sensor port on this hub answers it; a motor port does too, measured on
  // hardware — docs/superpowers/reference/2026-08-09-sense-gates.md § Gate 4.
  // See docs/DESIGN-NOTES.md § A snapshot polls, it does not subscribe
  // See docs/DESIGN-NOTES.md § A polled vector must not enter the guard's sample chain
  readPortValue(port, { timeoutMs = 600 } = {}) {
    return new Promise((resolve) => {
      let timer = null;
      const owed = this.#openRead(port, timeoutMs);
      const done = (value) => {
        this.#transport.removeEventListener('data', onData);
        this.#clearTimer(timer);
        // Answered, not accounted for: the frame taken as the answer may have
        // been a delivered sample, in which case the reply is still coming.
        owed.settled = true;
        resolve(value);
      };
      const onData = (e) => {
        const b = e.detail;
        if (b[2] !== 0x45 || b[3] !== port) return;
        const body = b.subarray(4);
        // The gesture ports answer with a single int8; everything else on this hub
        // answers in int16 pairs. Reading a one-byte reply in pairs yields an empty
        // array, which a caller cannot tell from a port that answered zero.
        if (body.length === 1) return done([body[0] > 127 ? body[0] - 256 : body[0]]);
        const out = [];
        for (let i = 0; i + 1 < body.length; i += 2) {
          const v = body[i] | (body[i + 1] << 8);
          out.push(v > 32767 ? v - 65536 : v);
        }
        done(out);
      };
      this.#transport.addEventListener('data', onData);
      timer = this.#setTimer(() => done(null), timeoutMs);
      this.#transport.sendPayload(encodePortValueRequest(port));
    });
  }

  // POS is one Int32; readPortValue hands back int16 pairs, so the halves are
  // recombined here. The low half must be read unsigned or every position past
  // 32767 comes back wrong by 65536.
  // See docs/DESIGN-NOTES.md § A delta-gated stream says nothing about a machine that is not moving
  async readPosition(port, options) {
    const values = await this.readPortValue(port, options);
    if (!values || values.length < 2) return null;
    return (values[0] & 0xffff) | (values[1] << 16);
  }

  // The reply debt, opened by the request and closed by the frame counted off
  // against it — or by the deadline, after which no reply can still arrive.
  // See docs/DESIGN-NOTES.md § A polled vector must not enter the guard's sample chain
  #openRead(port, timeoutMs) {
    const owed = { settled: false, timer: null };
    const open = this.#polling.get(port) ?? [];
    open.push(owed);
    this.#polling.set(port, open);
    owed.timer = this.#setTimer(() => this.#closeRead(port, owed), timeoutMs);
    return owed;
  }

  #closeRead(port, owed) {
    this.#clearTimer(owed.timer);
    const open = this.#polling.get(port);
    if (!open) return;
    const at = open.indexOf(owed);
    if (at >= 0) open.splice(at, 1);
    if (open.length === 0) this.#polling.delete(port);
  }

  // A frame on a port that still owes a reply cannot be attributed. It is
  // counted off against a read that already handed back an answer, since that
  // is the only one whose own reply can still be in flight.
  #claimReply(port) {
    const open = this.#polling.get(port);
    if (!open?.length) return false;
    const owed = open.find((r) => r.settled);
    if (owed) this.#closeRead(port, owed);
    return true;
  }

  // Drops an identical consecutive command per port, to keep the link quiet.
  // See docs/DESIGN-NOTES.md § Identical consecutive motor commands are dropped
  #sendMotor(port, bytes, signature) {
    if (this.#lastMotorCmd.get(port) === signature) return;
    this.#lastMotorCmd.set(port, signature);
    return this.#transport.sendPayload(bytes, `motor:${port}`);
  }

  setMotorInverted(port, inverted) {
    if (inverted) this.invertedPorts.add(port);
    else this.invertedPorts.delete(port);
  }

  // speed 0 floats the motor rather than encoding as StartSpeed(0).
  // See docs/DESIGN-NOTES.md § StartSpeed(0) is a regulated hold, not a stop
  async setMotorSpeedRaw(port, rawSpeed) {
    const speed = applyInvert(port, rawSpeed, this.invertedPorts);
    this.#brake.noteSpeed(port, speed);
    const bytes = speed === 0 ? encodeMotorFloat(port) : encodeMotorSpeed(port, speed);
    await this.#sendMotor(port, bytes, speed === 0 ? 'float' : `speed:${speed}`);
  }

  // A timed slice: the hub stops it on its own deadline, so two consecutive
  // identical slices are two separate commands, not a repeat to drop.
  async startSpeedForTime(port, timeMs, speed, maxPower, endState) {
    const applied = applyInvert(port, speed, this.invertedPorts);
    this.#brake.noteSpeed(port, applied);
    const bytes = encodeStartSpeedForTime(port, timeMs, applied, maxPower, endState);
    this.#lastMotorCmd.delete(port);
    await this.#transport.sendPayload(bytes, `timed:${port}:${this.#timedSeq++}`);
  }

  // Tells the brake policy the hub already stopped this motor on its own.
  noteMotorStopped(port) { this.#brake.noteSpeed(port, 0); }

  // Coast first, brake once slowed — a direct brake from speed can reset the hub.
  // See docs/DESIGN-NOTES.md § Braking from speed browns out the hub
  async brakeMotor(port) {
    await this.#brake.requestBrake(port, {
      coast: () => {
        log('staged brake on 0x' + port.toString(16));
        return this.#sendMotor(port, encodeMotorFloat(port), 'float');
      },
      brake: () => this.#sendMotor(port, encodeMotorBrake(port), 'brake'),
    });
  }

  // Resolves once no staged stop is pending for `port`, or for the drive pair
  // when no port is given. Rejects if the staged brake write did.
  async stopSettled(port) {
    const keys = port == null
      ? [this.roles.driveA, this.roles.driveB].filter((p) => p != null)
      : port;
    await this.#brake.settled(keys);
  }

  // Escape hatch for frames the encoders do not model. Everything on the
  // driving path goes through a named method instead.
  async sendRaw(bytes, key) {
    await this.#transport.sendPayload(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes), key);
  }

  async writeDirectMode(port, mode, values, key) {
    await this.#transport.sendPayload(encodeWriteDirectMode(port, mode, values), key);
  }

  // All ports the hub reported as attached (for probing unknown devices).
  get attachedPorts() {
    return [...new Set(this._attachedPorts)];
  }

  // DISABLED — kept for reference only; nothing may call this.
  // See docs/DESIGN-NOTES.md § Fusing the drive motors into a virtual port drops the hub off the air
  async linkDriveMotorsUNSAFE(timeoutMs = 2000) {
    if (this.roles.driveA == null || this.roles.driveB == null) return null;
    if (this.roles.combined != null) return this.roles.combined;
    log('linking drive motors 0x' + this.roles.driveA.toString(16) +
        ' + 0x' + this.roles.driveB.toString(16));
    // The port only exists once the hub reports it; wait for the confirmation.
    const confirmed = new Promise((resolve) => {
      const onIO = (e) => {
        if (e.detail.event === 0x02) {
          this.removeEventListener('attached-io', onIO);
          resolve(e.detail.port);
        }
      };
      this.addEventListener('attached-io', onIO);
      setTimeout(() => { this.removeEventListener('attached-io', onIO); resolve(null); }, timeoutMs);
    });
    await this.#transport.sendPayload(
      encodeVirtualPortConnect(this.roles.driveA, this.roles.driveB));
    const port = await confirmed;
    if (port == null) log('linking: hub did not confirm a virtual port');
    return port;
  }

  // Release the virtual port so the member motors are addressable again. Only
  // one addressing scheme may be live at a time.
  async unlinkDriveMotors() {
    const vp = this.roles.combined;
    if (vp == null) return;
    log('unlinking virtual drive port 0x' + vp.toString(16));
    await this.#transport.sendPayload(Uint8Array.of(0x05, 0x00, 0x61, 0x00, vp));
    delete this.roles.combined;
  }

  // No virtual port is created any more; drive commands address both motors.
  get drivePort() { return null; }

  // Both drive motors in one burst, so nothing can land between them.
  // See docs/DESIGN-NOTES.md § Two motors stay in step through one queue slot, not a virtual port
  async driveThrottle(speed) {
    const ports = [this.roles.driveA, this.roles.driveB].filter((p) => p != null);
    if (!ports.length) return;
    this.#brake.noteSpeed(ports, speed);
    // Per-port inversion applies inside the pair too, or the wheels fight.
    const frames = ports.map((p) => {
      const s = applyInvert(p, speed, this.invertedPorts);
      return s === 0 ? encodeMotorFloat(p) : encodeMotorSpeed(p, s);
    });
    this.#transport.sendBurst(frames, 'drive');
  }

  // Tank steering: a speed per motor, still one burst so the tracks stay in step.
  async driveTank(left, right) {
    const a = this.roles.driveA, b = this.roles.driveB;
    if (a == null || b == null) return;
    this.#brake.noteSpeed([a, b], Math.max(Math.abs(left), Math.abs(right)));
    const frame = (port, speed) => {
      const s = applyInvert(port, speed, this.invertedPorts);
      return s === 0 ? encodeMotorFloat(port) : encodeMotorSpeed(port, s);
    };
    this.#transport.sendBurst([frame(a, left), frame(b, right)], 'drive');
  }

  // Stop both drive motors together, staging the brake when they are spinning.
  async brakeDrive() {
    const ports = [this.roles.driveA, this.roles.driveB].filter((p) => p != null);
    if (!ports.length) return;
    await this.#brake.requestBrake(ports, {
      coast: () => {
        log('staged brake on drive pair');
        this.#transport.sendBurst(ports.map(encodeMotorFloat), 'drive');
      },
      brake: () => this.#transport.sendBurst(ports.map(encodeMotorBrake), 'drive'),
    });
  }

}
