// The macro host. Every rule is enforced here, per RPC message. The worker
// runs user code, and user code can call self.postMessage directly and forge
// any message it likes.
//
// See docs/superpowers/specs/2026-07-28-macro-system-design.md

import { API, isUnsafe, pathOf } from './api-spec.js';
import { PLAYVM_LIGHTS, encodeGotoAbsolutePosition, encodeStartSpeedForDegrees } from '../lwp-encoders.js';
import { createPlayVmHold, createRawDeadlines, MAX_COMMAND_MS } from './command-lifetime.js';
import { createRunState } from './run-state.js';
import { createLinkPacer } from './link-pacer.js';
import { log } from '../debug-log.js';
import { WAIT_UNTIL_POLL_MS } from './rpc.js';

const HOLDER = 'macro';

// Methods that write nothing to the link; they never queue behind the pacer.
const UNPACED_METHODS = new Set(['wait', 'waitUntil', 'print']);

export const QUEUE_DEPTH_LIMIT = 8;
export const QUEUE_DEPTH_STRIKES = 5;
const QUEUE_HEALTH_INTERVAL_MS = 250;

export const PRINT_PER_SECOND = 20;
const PRINT_WINDOW_MS = 1000;

// The API takes a lights name; the combined frame takes a numeric code.
// An unknown name must fail rather than pass through.
const LIGHT_MODES = {
  both: PLAYVM_LIGHTS.BOTH_ON,
  off: PLAYVM_LIGHTS.OFF,
  brake: PLAYVM_LIGHTS.FRONT_ON_BRAKE_REAR,
  'front-off-brake': PLAYVM_LIGHTS.FRONT_OFF_BRAKE_REAR,
};

export const SENSOR_TIMEOUT_MS = 3000;
export { WAIT_UNTIL_POLL_MS };

// A delta-gated stream says nothing while the value is steady, so a first
// read can wait forever. It fails instead of fabricating a zero.
// speed/position share one event name across every subscribed port, so a
// read for one port must not resolve (or cache) off a sample meant for
// another — `port`, when given, filters incoming events and scopes the key.
// `pending` lets an abort cancel the timer and detach the reader before
// timeoutMs elapses, so a stopped run leaves nothing running behind it.
//
// The listener the first read installs stays for the run and overwrites
// `cache` on every sample, so a later read answers with the newest value.
// See docs/DESIGN-NOTES.md § A sensor read answers with the latest sample, not the first
function readStream({ protocol, event, subscribe, cache, streams, port, pending }, timeoutMs) {
  const key = port == null ? event : `${event}:${port}`;
  // Only trust the cache while the listener that keeps it fresh is installed.
  if (streams.has(key) && cache.has(key)) return Promise.resolve(cache.get(key));
  return new Promise((resolve, reject) => {
    let entry = streams.get(key);
    if (!entry) {
      entry = { protocol, event, readers: new Set(), listener: null };
      entry.listener = (e) => {
        if (port != null && e.detail.port !== port) return;
        cache.set(key, e.detail);
        for (const reader of [...entry.readers]) reader(e.detail);
      };
      streams.set(key, entry);
      protocol.addEventListener(event, entry.listener);
    }
    let done;
    const onValue = (detail) => { done(); resolve(detail); };
    const timer = setTimeout(() => {
      done();
      reject(new Error(
        `no ${event} sample arrived within ${timeoutMs}ms — this stream only ` +
        `reports changes, so a value that never changes never arrives`));
    }, timeoutMs);
    done = () => {
      clearTimeout(timer);
      entry.readers.delete(onValue);
      pending?.delete(done);
      // A key that never produced a sample has nothing to keep fresh.
      if (!entry.readers.size && !cache.has(key)) releaseStream(streams, key);
    };
    pending?.add(done);
    entry.readers.add(onValue);
    Promise.resolve(subscribe()).catch((err) => { done(); reject(err); });
  });
}

function releaseStream(streams, key) {
  const entry = streams.get(key);
  if (!entry) return;
  streams.delete(key);
  entry.protocol.removeEventListener(entry.event, entry.listener);
}

export function createMacroHost(hub, {
  spawnWorker, onState, onPrint, onNotice,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
} = {}) {
  const state = createRunState({ onChange: (to, from, detail) => onState?.(to, detail) });
  let worker = null;
  let runId = 0;
  let allowUnsafe = false;
  let usedPath = null;      // 'playvm' | 'raw', whichever this run touched first
  let motionSeen = false;   // per-run; only stop() clears it
  let switching = false;
  let modeChanged = null;   // the mode a macro left the hub in, named in the end reason
  let collisionWas = null; // the user's collision mode, restored when the run ends
  let thresholdWas = null; // ditto for the collision threshold
  const cache = new Map();     // latest sample per stream key, this run only
  const streams = new Map();   // stream key -> the listener keeping `cache` fresh
  const pendingReads = new Set(); // cleanup fns for in-flight sensor/waitFor timers
  const runTimers = new Set();    // timers a handler is awaiting, cancelled by stop()
  const pacer = createLinkPacer({ schedule, cancel });
  let healthTimer = 0;
  let depthStrikes = 0;
  let printCount = 0;
  let printWindowTimer = 0;
  let printSuppressed = false;

  const playvm = createPlayVmHold({
    set: (s, st) => hub.playvm?.set(s, st),
    stop: () => hub.playvm?.stop(),
    schedule, cancel,
  });
  const rawDeadlines = createRawDeadlines({
    float: (port) => { hub.protocol?.setMotorSpeedRaw(port, 0); },
    schedule, cancel,
  });

  // ---- rule checks, all of which throw a plain Error the worker will see ----

  // A timer a handler awaits, tracked so stop() can cancel it. An untracked
  // one comes due inside the next run and acts on that run's state.
  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = schedule(() => { runTimers.delete(timer); resolve(); }, ms);
      runTimers.add(timer);
    });
  }

  // Own properties only: `Object.prototype` names — constructor, toString —
  // are not methods.
  function checkMethod(method) {
    if (!Object.hasOwn(API, method)) throw new Error(`no such macro method: ${method}`);
    if (isUnsafe(method) && !allowUnsafe) {
      throw new Error(
        `${method} is an unsafe call and this macro has unsafe turned off`);
    }
  }

  // Returns the path this call commits to. Callers must run a method's own
  // argument validation first — checkDuration, an unknown lights mode —
  // so a call that goes on to fail that validation never reaches here and
  // never commits usedPath.
  function checkPath(method) {
    if (switching) {
      throw new Error(
        'a drive-mode switch is still in progress — await mode() before calling anything else');
    }
    const path = pathOf(method);
    if (path === 'any') return null;
    if (usedPath && usedPath !== path) {
      throw new Error(
        `this run already used the ${usedPath} drive path; a run uses one drive path, not both`);
    }
    const armed = hub.playvm?.armed === true;
    if (path === 'playvm' && !armed) {
      throw new Error(
        "the combined frame is not armed — call mode('playvm') first, or arm it in Setup");
    }
    if (path === 'raw' && armed) {
      throw new Error(
        "the combined frame is armed and owns the motors — call mode('raw') first, or leave the hub drive mode in Setup");
    }
    usedPath = path;
    if (API[method].motion) motionSeen = true;
    return path;
  }

  function resetPrintWindow() {
    printWindowTimer = 0;
    printCount = 0;
    printSuppressed = false;
  }

  // A climbing queue is the early sign of a dying link.
  // See docs/DESIGN-NOTES.md § Queue depth is only shown when it is climbing
  function sampleQueueDepth() {
    healthTimer = 0;
    const depth = hub.transport?.queueDepth;
    if (depth != null) {
      if (depth > QUEUE_DEPTH_LIMIT) {
        depthStrikes++;
        log(`queue depth ${depth} over limit ${QUEUE_DEPTH_LIMIT} — strike ${depthStrikes}/${QUEUE_DEPTH_STRIKES}`);
        if (depthStrikes >= QUEUE_DEPTH_STRIKES) { stop('the link is falling behind'); return; }
      } else {
        depthStrikes = 0;
      }
    }
    healthTimer = schedule(sampleQueueDepth, QUEUE_HEALTH_INTERVAL_MS);
  }

  function checkDuration(ms) {
    if (!(ms >= 0) || ms > MAX_COMMAND_MS) {
      throw new Error(
        `a motion command may last at most ${MAX_COMMAND_MS}ms; asked for ${ms}ms`);
    }
  }

  // Only 'collision' exists; an unrecognised name is refused rather than
  // left to hang on an event nothing will ever dispatch.
  function waitForEvent(name, timeoutMs) {
    if (name !== 'collision') {
      throw new Error(`waitFor: unsupported event name '${name}' — only 'collision' is supported`);
    }
    return new Promise((resolve, reject) => {
      let done;
      const onImpact = (e) => { done(); resolve(e.detail); };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`waitFor('${name}') timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      done = () => {
        clearTimeout(timer);
        hub.collision?.removeEventListener('impact', onImpact);
        pendingReads.delete(done);
      };
      pendingReads.add(done);
      hub.collision?.addEventListener('impact', onImpact);
    });
  }

  // ---- the dispatch table ----
  // Only names present in API may appear here; test/api-spec.test.js is the
  // net that keeps the two in step.

  // Each entry's `validate` (if any) runs before checkPath, so a call whose
  // own arguments are bad — an over-ceiling duration, an unknown lights mode
  // — never reaches checkPath and never commits usedPath.

  const handlers = {
    mode: {
      // Sync, so both refusals answer ahead of checkPath and the link floor.
      validate: (name) => {
        if (name !== 'playvm' && name !== 'raw') {
          throw new Error(`unknown drive mode: ${name} — use 'playvm' or 'raw'`);
        }
        if (!hub.gamepad) throw new Error('not connected — no hub to change the drive mode on');
      },
      run: async (name) => {
        const id = runId;
        const armed = hub.playvm?.armed === true;

        if (name === 'playvm') {
          if (armed) { usedPath = null; return; }
          if (motionSeen) {
            throw new Error(
              "mode('playvm') arms the combined frame, which sweeps the steering rack — "
              + 'it has to come before the macro moves anything');
          }
        } else if (!armed) {
          usedPath = null;
          return;
        } else {
          // setDriveMode zeroes its own throttle, but the host's machinery
          // survives it: a hold keeps ticking and would push a stale command
          // after a later re-arm, and a deadline would float a port the frame
          // owns by then.
          playvm.release();
          rawDeadlines.clearAll();
        }

        if (name === 'playvm') {
          onNotice?.('arming combined frame — the steering rack will sweep…');
        }

        switching = true;
        try {
          await hub.gamepad.setDriveMode(name === 'playvm' ? 'playvm' : 'linked', { persist: false });
        } finally {
          // `switching` is host-level, not per-run: by the time this resumes,
          // a later run's switch may own the latch.
          if (id === runId) switching = false;
        }
        if (id !== runId) return;           // the run ended while we were switching
        if (name === 'playvm' && hub.playvm?.armed !== true) {
          throw new Error(
            'the combined frame could not be armed — the app fell back to a disarmed mode');
        }
        modeChanged = name;
        usedPath = null;
      },
    },

    drive: { run: async (speed, steer) => { playvm.hold(speed, steer); } },
    driveFor: {
      validate: (speed, steer, ms) => checkDuration(ms),
      run: async (speed, steer, ms) => {
        const id = runId;
        playvm.hold(speed, steer);
        await sleep(ms);
        if (id !== runId) return;   // the hold being released is not ours any more
        playvm.release();
      },
    },
    stopDrive: { run: async () => { playvm.release(); } },
    lights: {
      validate: (mode) => {
        if (LIGHT_MODES[mode] === undefined) {
          throw new Error(
            `unknown lights mode: ${mode} — use one of ${Object.keys(LIGHT_MODES).join(', ')}`);
        }
      },
      run: async (mode) => { hub.playvm?.setLights(LIGHT_MODES[mode]); },
    },

    motorFor: {
      validate: (port, speed, ms) => checkDuration(ms),
      run: async (port, speed, ms) => {
        await hub.protocol.setMotorSpeedRaw(port, speed);
        rawDeadlines.arm(port, ms);
      },
    },
    brakeAll: { run: async () => { await hub.protocol.brakeDrive(); } },
    coast: { run: async (port) => { await hub.protocol.setMotorSpeedRaw(port, 0); } },
    brake: { run: async (port) => { await hub.protocol.brakeMotor(port); } },

    print: {
      run: async (...args) => {
        if (!printWindowTimer) printWindowTimer = schedule(resetPrintWindow, PRINT_WINDOW_MS);
        printCount++;
        if (printCount > PRINT_PER_SECOND) {
          if (!printSuppressed) {
            printSuppressed = true;
            log('print suppressed — too many lines');
          }
          return;
        }
        onPrint?.(args);
      },
    },
    ports: { run: async () => ({ ...hub.protocol.roles }) },
    wait: { run: async (ms) => { await sleep(ms); } },

    throttleFor: {
      validate: (speed, ms) => checkDuration(ms),
      run: async (speed, ms) => {
        const { driveA, driveB } = hub.protocol.roles;
        for (const port of [driveA, driveB]) {
          if (port == null) continue;
          await hub.protocol.setMotorSpeedRaw(port, speed);
          rawDeadlines.arm(port, ms);
        }
      },
    },
    tankFor: {
      validate: (left, right, ms) => checkDuration(ms),
      run: async (left, right, ms) => {
        const { driveA, driveB } = hub.protocol.roles;
        // Each port is armed straight after its own write: a second write that
        // throws must not leave the first motor powered with no deadline.
        for (const [port, speed] of [[driveA, left], [driveB, right]]) {
          if (port == null) continue;
          await hub.protocol.setMotorSpeedRaw(port, speed);
          rawDeadlines.arm(port, ms);
        }
      },
    },

    steer: {
      // setInput only sets a target the P-loop acts on in 'steer' mode, so
      // outside it the call would do nothing at all. Sync, so the refusal
      // answers ahead of checkPath.
      validate: () => {
        if (hub.steering?.mode !== 'steer') {
          throw new Error(
            'steering is not in steer mode — set it in Setup; mode() covers the drive path, not the steering path');
        }
      },
      run: async (input) => { hub.steering.setInput(input); },
    },
    steerZero: { run: async () => { hub.steering?.setZero(); } },
    steerPos: { run: async () => hub.steering?.pos ?? 0 },

    lamps: { run: async (mask, brightness) => { await hub.protocol.setLights(mask, brightness); } },
    led: { run: async (colour) => { await hub.protocol.setLed(colour); } },

    tilt: {
      run: async (timeoutMs = SENSOR_TIMEOUT_MS) => readStream({
        protocol: hub.protocol, event: 'tilt', cache, streams, pending: pendingReads,
        subscribe: () => hub.protocol.subscribeToIMU(0, 5, HOLDER),
      }, timeoutMs),
    },
    accel: {
      run: async (timeoutMs = SENSOR_TIMEOUT_MS) => readStream({
        protocol: hub.protocol, event: 'accel', cache, streams, pending: pendingReads,
        subscribe: () => hub.protocol.subscribeToAccel(800, undefined, HOLDER),
      }, timeoutMs),
    },
    battery: {
      run: async (timeoutMs = SENSOR_TIMEOUT_MS) => (await readStream({
        protocol: hub.protocol, event: 'battery', cache, streams, pending: pendingReads,
        subscribe: () => hub.protocol.requestBattery(),
      }, timeoutMs)).percent,
    },
    motorSpeed: {
      run: async (port, timeoutMs = SENSOR_TIMEOUT_MS) => (await readStream({
        protocol: hub.protocol, event: 'speed', cache, streams, port, pending: pendingReads,
        subscribe: () => hub.protocol.subscribeToSpeed(port, 2, HOLDER),
      }, timeoutMs)).speed,
    },
    motorPos: {
      run: async (port, timeoutMs = SENSOR_TIMEOUT_MS) => (await readStream({
        protocol: hub.protocol, event: 'position', cache, streams, port, pending: pendingReads,
        subscribe: () => hub.protocol.subscribeToPosition(port, 2, HOLDER),
      }, timeoutMs)).pos,
    },

    waitUntil: { run: async (predicateResult) => predicateResult },

    waitFor: {
      run: async (name, timeoutMs = SENSOR_TIMEOUT_MS) => {
        if (name === 'collision' && hub.collision?.mode === 'abort') {
          throw new Error(
            'waitFor(\'collision\') can never return while the collision mode is ' +
            '\'abort\', because the impact ends the run — call collision(\'stop\') ' +
            'or collision(\'notify\') first');
        }
        return waitForEvent(name, timeoutMs);
      },
    },

    collision: {
      run: async (mode) => {
        if (collisionWas === null) collisionWas = hub.collision?.mode ?? 'abort';
        hub.collision?.setMode(mode);
      },
    },
    collisionThreshold: {
      run: async (mg) => {
        // Only capture while hub.collision actually exists — otherwise the
        // capture would store `undefined`, indistinguishable from "not yet
        // captured" and unrecoverable on a later call once it reappears.
        if (thresholdWas === null && hub.collision) thresholdWas = hub.collision.params.thresholdMg;
        // setThreshold, not params.thresholdMg: the hub does the filtering, so
        // a software-only change is invisible below the armed delta.
        if (hub.collision) await hub.collision.setThreshold(mg);
      },
    },

    'unsafe.raw': { run: async (bytes, key) => { await hub.protocol.sendRaw(bytes, key); } },
    'unsafe.writeDirect': {
      run: async (port, mode, values) => { await hub.protocol.writeDirectMode(port, mode, values); },
    },
    'unsafe.subscribe': {
      run: async (port, mode, delta) => { await hub.protocol.subscribePort(port, mode, delta, HOLDER); },
    },
    'unsafe.unsubscribe': {
      run: async (port, mode) => { await hub.protocol.unsubscribePort(port, mode, HOLDER); },
    },
    'unsafe.gotoPosition': {
      run: async (port, angle, speed, maxPower, endState) => {
        log('UNSAFE gotoPosition — this crashes the firmware on the steer motor');
        await hub.protocol.sendRaw(
          encodeGotoAbsolutePosition(port, angle, speed, maxPower, endState), 'unsafe');
      },
    },
    'unsafe.speedForDegrees': {
      run: async (port, degrees, speed, maxPower, endState) => {
        log('UNSAFE speedForDegrees — position-command family, suspect on this hub');
        await hub.protocol.sendRaw(
          encodeStartSpeedForDegrees(port, degrees, speed, maxPower, endState), 'unsafe');
      },
    },
    'unsafe.linkDriveMotors': {
      run: async () => {
        log('UNSAFE linkDriveMotors — this hub leaves the air within 0.1-1.1s');
        return hub.protocol.linkDriveMotorsUNSAFE();
      },
    },
    'unsafe.unlinkDriveMotors': { run: async () => { await hub.protocol.unlinkDriveMotors(); } },
  };

  async function dispatch(msg) {
    checkMethod(msg.method);
    const entry = handlers[msg.method];
    if (!entry) throw new Error(`${msg.method} is in the API table but has no handler`);
    const args = msg.args ?? [];
    entry.validate?.(...args);
    checkPath(msg.method);
    if (UNPACED_METHODS.has(msg.method)) return entry.run(...args);
    return pacer.pace(() => entry.run(...args));
  }

  function onWorkerMessage(id, e) {
    if (id !== runId) return;                 // a late message from an aborted run
    const msg = e.data;
    if (msg.kind === 'done') { stop('finished'); return; }
    if (msg.kind === 'failed') { stop(`error: ${msg.error?.message ?? 'unknown'}`, msg.error); return; }
    if (msg.kind !== 'call') return;
    Promise.resolve()
      .then(() => dispatch(msg))
      .then(
        (value) => post(id, { kind: 'reply', id: msg.id, ok: true, value }),
        (err) => post(id, {
          kind: 'reply', id: msg.id, ok: false,
          error: { name: err?.name ?? 'Error', message: err?.message ?? String(err) },
        }),
      );
  }

  function post(id, msg) {
    if (id !== runId || !worker) return;
    worker.postMessage(msg);
  }

  // Sources close before power is cut; the steer port is floated
  // (setMotorSpeedRaw(port, 0)), never braked.
  // See docs/DESIGN-NOTES.md § The emergency stop closes the sources before it cuts power
  function stop(reason, errorDetail) {
    if (!state.can('abort')) return;
    runId++;                                  // fences every reply still in flight
    try {
      // Inside the try: 'stopping' is a state can('abort') is false from, so a
      // throwing listener here must not skip the cleanup below.
      // See docs/DESIGN-NOTES.md § A listener must not be able to latch the run state
      state.to('stopping');
      if (healthTimer) { cancel(healthTimer); healthTimer = 0; }
      if (printWindowTimer) { cancel(printWindowTimer); printWindowTimer = 0; }
      printCount = 0;
      printSuppressed = false;
      for (const timer of [...runTimers]) cancel(timer);
      runTimers.clear();
      for (const cancelRead of [...pendingReads]) cancelRead();
      pendingReads.clear();
      for (const key of [...streams.keys()]) releaseStream(streams, key);
      worker?.terminate();
      pacer.clear();
      worker = null;
      playvm.release();
      hub.steering?.stop();
      // A frame being armed is driving nothing, so there is nothing here to
      // stop; both writes would fight the calibration sweep.
      if (!switching) {
        if (hub.protocol?.roles?.steer != null) {
          hub.protocol.setMotorSpeedRaw(hub.protocol.roles.steer, 0);
        }
        rawDeadlines.clearAll();
        hub.protocol?.brakeDrive?.();
      }
      hub.protocol?.releaseStreams?.(HOLDER);
      if (collisionWas !== null) { hub.collision?.setMode(collisionWas); collisionWas = null; }
      if (thresholdWas !== null) {
        const restore = thresholdWas;
        thresholdWas = null;
        // setThreshold puts the hub-side delta back too, so the run's finer
        // filtering does not outlive it. Fire-and-forget, like brakeDrive above.
        Promise.resolve(hub.collision?.setThreshold(restore)).catch(
          (err) => log('collision threshold restore failed:', err?.message ?? err));
      }
      cache.clear();
      log('macro stopped:', reason);
    } catch (err) {
      log('macro cleanup failed:', err?.message ?? err);
    } finally {
      // Composed before the clears below, which drop modeChanged.
      const endReason = modeChanged
        ? `${reason} — drive mode left as ${modeChanged}`
        : reason;
      usedPath = null;
      motionSeen = false;
      switching = false;
      modeChanged = null;
      // A script error passes through 'failed' with its detail before the
      // state settles back to 'idle'; the reason rides on 'idle' itself, so
      // the panel can tell a clean finish from a car that stopped itself.
      if (errorDetail) state.to('failed', errorDetail);
      state.reset(endReason);                 // nothing is ever left latched
    }
  }

  return {
    get state() { return state.state; },

    async run(source, options = {}) {
      if (!state.can('run')) throw new Error('a macro is already running');
      allowUnsafe = options.allowUnsafe === true;
      usedPath = null;
      state.to('arming');
      const id = ++runId;
      worker = spawnWorker();
      worker.onmessage = (e) => onWorkerMessage(id, e);
      state.to('running');
      depthStrikes = 0;
      if (hub.transport) healthTimer = schedule(sampleQueueDepth, QUEUE_HEALTH_INTERVAL_MS);
      worker.postMessage({ kind: 'run', source });
    },

    abort(reason = 'stopped') { stop(reason); },
  };
}
