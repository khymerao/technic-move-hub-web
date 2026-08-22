// Serial command queue with per-key coalescing: a keyed send REPLACES any
// still-pending value for the same key, an unkeyed send is never dropped.
//
// See docs/DESIGN-NOTES.md § Keyed sends must replace each other, not queue up

export function createCommandQueue(write) {
  const pending = new Map(); // key -> bytes (insertion-ordered, latest value wins)
  let autoId = 0;
  let running = false;
  let idleWaiters = [];

  async function pump() {
    running = true;
    while (pending.size) {
      const [key, bytes] = pending.entries().next().value;
      pending.delete(key);
      try { await write(bytes); } catch { /* transport logs it; keep draining */ }
    }
    running = false;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  return {
    send(bytes, key) {
      pending.set(key ?? `#${autoId++}`, bytes);
      if (!running) pump();
    },
    idle() {
      if (!running && pending.size === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    get depth() { return pending.size; },
  };
}
