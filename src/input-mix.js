// Per-axis arbitration between the physical pad and the on-screen controls.
// Pure: no DOM, no BLE, no timers.
//
// See docs/DESIGN-NOTES.md § Arbitration is per axis, and engagement is post-deadzone

export function createInputMix({ deadzone = 0 } = {}) {
  const touch = new Map();   // axis -> value
  const seq = new Map();     // axis -> { pad, touch } engagement order
  let tick = 0;

  const dz = () => (typeof deadzone === 'function' ? deadzone() : deadzone);
  const past = (v) => Math.abs(v) > dz();

  return {
    setTouch(axis, value) {
      if (!touch.has(axis) || !past(touch.get(axis))) {
        if (past(value)) seq.set(axis, { ...(seq.get(axis) ?? {}), touch: ++tick });
      }
      touch.set(axis, value);
    },

    releaseTouch(axis) {
      touch.delete(axis);
      const s = seq.get(axis);
      if (s) seq.set(axis, { ...s, touch: 0 });
    },

    releaseAll() {
      touch.clear();
      for (const [axis, s] of seq) seq.set(axis, { ...s, touch: 0 });
    },

    resolve(axis, padValue) {
      const s = seq.get(axis) ?? {};
      if (past(padValue) && !s.pad) seq.set(axis, { ...s, pad: ++tick });
      if (!past(padValue)) seq.set(axis, { ...(seq.get(axis) ?? {}), pad: 0 });

      const t = touch.get(axis);
      const touchLive = t !== undefined && past(t);
      if (!touchLive) return padValue;

      const cur = seq.get(axis) ?? {};
      return (cur.touch ?? 0) >= (cur.pad ?? 0) ? t : padValue;
    },

    engaged(axis) {
      const t = touch.get(axis);
      return t !== undefined && past(t);
    },

    anyEngaged() {
      for (const v of touch.values()) if (past(v)) return true;
      return false;
    },
  };
}
