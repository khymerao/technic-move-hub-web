// One dial: the measured angle is the fill, the commanded angle is the bug.
// Geometry is the shipped one — centre (50,50), r 44, zero at the top.
//
// See docs/DESIGN-NOTES.md § The reading is the fill, the setpoint is the bug

const R = 44, CX = 50, CY = 50;

export function arcPoint(v) {
  const a = (90 - (Math.max(-100, Math.min(100, v)) / 100) * 90) * Math.PI / 180;
  return { x: CX + R * Math.cos(a), y: CY - R * Math.sin(a) };
}

export function arcPath(from, to) {
  const a = arcPoint(from), b = arcPoint(to);
  const sweep = to >= from ? 1 : 0;
  return `M${+a.x.toFixed(1)} ${+a.y.toFixed(1)} A${R} ${R} 0 0 ${sweep} ${+b.x.toFixed(1)} ${+b.y.toFixed(1)}`;
}

export function createDial({ fill = null, bug }) {
  return {
    show({ measured, commanded, maxAngle = 90 }) {
      const pct = (deg) => (deg == null ? null : Math.max(-100, Math.min(100, (deg / maxAngle) * 100)));
      const m = pct(measured), c = pct(commanded);
      if (fill) fill.setAttribute('d', m == null ? arcPath(0, 0) : arcPath(0, m));
      bug.style.transform = `rotate(${((c ?? 0) / 100) * 90}deg)`;
    },
  };
}
