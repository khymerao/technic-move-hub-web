// Who is holding which input stream, and at what delta. Pure bookkeeping:
// no bytes, no BLE, no DOM. The protocol turns the returned action into a
// frame; this file only decides what the frame should be.
//
// Two rules live here:
//
//   Rule 7 — a port streams exactly one input mode at a time.
//   See docs/ARCHITECTURE.md § 7. A port streams ONE input mode at a time
//
//   The finest delta wins. A port has one InputFormatSetup, so two holders
//   asking for different deltas cannot both be served; the smaller delta is
//   the safe one to honour, because a holder that asked for fine updates
//   breaks if it gets coarse ones, while the reverse only costs traffic.

export function createStreamRegistry() {
  // `${port}:${mode}` -> Map<holder, delta>, insertion-ordered
  const streams = new Map();

  const key = (port, mode) => `${port}:${mode}`;

  const effective = (holders) => Math.min(...holders.values());

  // The one mode a port is currently streaming, if any.
  const modeOf = (port) => {
    for (const [k, holders] of streams) {
      if (!holders.size) continue;
      const [p, m] = k.split(':').map(Number);
      if (p === port) return m;
    }
    return null;
  };

  const release = (port, mode, holder) => {
    const k = key(port, mode);
    const holders = streams.get(k);
    if (!holders || !holders.has(holder)) return { action: 'none' };
    const before = effective(holders);
    holders.delete(holder);
    if (!holders.size) { streams.delete(k); return { action: 'disable' }; }
    const after = effective(holders);
    return before === after ? { action: 'none' } : { action: 'setup', delta: after };
  };

  return {
    modeOf,

    holders(port, mode) {
      return [...(streams.get(key(port, mode))?.keys() ?? [])];
    },

    acquire(port, mode, delta, holder) {
      const live = modeOf(port);
      if (live !== null && live !== mode) {
        throw new Error(
          `port 0x${port.toString(16)} is already streaming mode 0x${live.toString(16)}; ` +
          `a port streams one input mode at a time`);
      }
      const k = key(port, mode);
      let holders = streams.get(k);
      if (!holders) { holders = new Map(); streams.set(k, holders); }
      const before = holders.size ? effective(holders) : null;
      holders.set(holder, delta);
      const after = effective(holders);
      return before === after ? { action: 'none', delta: after }
        : { action: 'setup', delta: after };
    },

    release,

    releaseAll(holder) {
      const out = [];
      for (const k of [...streams.keys()]) {
        const [port, mode] = k.split(':').map(Number);
        if (!streams.get(k)?.has(holder)) continue;
        out.push({ port, mode, ...release(port, mode, holder) });
      }
      return out;
    },
  };
}
