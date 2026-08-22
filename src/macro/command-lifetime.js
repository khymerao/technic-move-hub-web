// No motion command outlives its ceiling without being renewed.
//
// PlayVM refreshes on tick. Raw StartSpeed floats the port at deadline.
// Neither survives tab death. There is no device-side failsafe.
// See docs/superpowers/specs/2026-07-28-macro-system-design.md § Layer 1

export const MAX_COMMAND_MS = 10000;
export const PLAYVM_TICK_MS = 200;

const checkDuration = (ms, maxMs) => {
  if (!(ms >= 0) || ms > maxMs) {
    throw new RangeError(
      `a motion command may last at most ${maxMs}ms; asked for ${ms}ms`);
  }
};

export function createPlayVmHold({
  set, stop, schedule, cancel, tickMs = PLAYVM_TICK_MS, maxMs = MAX_COMMAND_MS,
}) {
  let timer = 0, elapsed = 0, current = null;

  const stopTimer = () => { if (timer) { cancel(timer); timer = 0; } };

  const tick = () => {
    timer = 0;
    elapsed += tickMs;
    if (elapsed >= maxMs) { release(); return; }
    set(current[0], current[1]);
    timer = schedule(tick, tickMs);
  };

  function release() {
    stopTimer();
    if (current === null) return;
    current = null;
    elapsed = 0;
    stop();
  }

  return {
    get held() { return current !== null; },
    hold(speed, steer) {
      checkDuration(0, maxMs);
      stopTimer();
      elapsed = 0;              // a new command restarts the ceiling
      current = [speed, steer];
      set(speed, steer);
      timer = schedule(tick, tickMs);
    },
    release,
  };
}

export function createRawDeadlines({ float, schedule, cancel, maxMs = MAX_COMMAND_MS }) {
  const timers = new Map(); // port -> timer id

  const drop = (port) => {
    const t = timers.get(port);
    if (t) { cancel(t); timers.delete(port); }
  };

  return {
    get armed() { return [...timers.keys()]; },
    arm(port, ms) {
      checkDuration(ms, maxMs);
      drop(port);
      timers.set(port, schedule(() => { timers.delete(port); float(port); }, ms));
    },
    clear(port) { drop(port); float(port); },
    clearAll() { for (const port of [...timers.keys()]) { drop(port); float(port); } },
  };
}
