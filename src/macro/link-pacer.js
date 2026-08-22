// One write floor for the whole link, not per port, at the measured safe
// rate of 60ms.
// See docs/DESIGN-NOTES.md § Rate limiting is not optional on this path

export const LINK_FLOOR_MS = 60;

// A forged postMessage flood queues one entry per message, and at one write
// per 60ms the queue only grows. Writes stay floored either way, so this is a
// memory cap, not a safety one; 64 is minutes of link time and far past
// anything a real macro queues.
export const MAX_QUEUE = 64;

export function createLinkPacer({
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
  now = () => Date.now(),
  floorMs = LINK_FLOOR_MS,
  maxQueue = MAX_QUEUE,
} = {}) {
  const queue = [];
  let lastAt = -Infinity;
  let timer = 0;

  const drain = () => {
    timer = 0;
    const entry = queue.shift();
    if (!entry) return;
    lastAt = now();
    try { entry.resolve(entry.fn()); } catch (err) { entry.reject(err); }
    if (queue.length) timer = schedule(drain, floorMs);
  };

  return {
    get waiting() { return queue.length; },

    pace(fn) {
      return new Promise((resolve, reject) => {
        if (queue.length >= maxQueue) {
          reject(new Error(
            `too many writes waiting on the link (${maxQueue}) — this one was refused`));
          return;
        }
        queue.push({ fn, resolve, reject });
        if (timer) return;
        const since = now() - lastAt;
        if (since >= floorMs) drain();
        else timer = schedule(drain, floorMs - since);
      });
    },

    clear() {
      if (timer) { cancel(timer); timer = 0; }
      const dropped = queue.splice(0, queue.length);
      for (const e of dropped) e.reject(new Error('the run ended before this write went out'));
    },
  };
}
