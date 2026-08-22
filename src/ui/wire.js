// The live frame on the landing page.
//
// The sliders drive `encodePlayVmFrame` — the same function that drives the car
// — and the bytes on screen are its actual output. That is the whole point:
// the page claims the protocol was read off the wire, and a mock-up of a frame
// would undercut the claim it is there to make.
//
// It runs before any hub is connected and writes to nothing, so there is no
// path from here to a motor.

import { encodePlayVmFrame } from '../lwp-encoders.js';
import { PLAYVM_PORT } from '../lwp-decoders.js';

const hex = (b) => b.toString(16).padStart(2, '0');

export function initWire() {
  const speed = document.getElementById('w-speed');
  const steer = document.getElementById('w-steer');
  const light = document.getElementById('w-light');
  const cells = document.getElementById('wire-bytes');
  if (!speed || !steer || !light || !cells) return;

  const speedOut = document.getElementById('w-speed-out');
  const steerOut = document.getElementById('w-steer-out');
  const spans = [...cells.children];

  function paint() {
    const s = Number(speed.value), a = Number(steer.value), l = Number(light.value);
    const bytes = encodePlayVmFrame(PLAYVM_PORT, s, a, l);
    // Rewrite in place rather than rebuilding: the three coloured cells keep
    // their classes, and nothing reflows around them.
    bytes.forEach((b, i) => { if (spans[i]) spans[i].textContent = hex(b); });
    speedOut.textContent = s > 0 ? `+${s}` : String(s);
    steerOut.textContent = a > 0 ? `+${a}` : String(a);
    // A changed byte is worth noticing. The class is removed on the next frame
    // so a drag does not leave every cell permanently lit.
    for (const el of [spans[9], spans[10], spans[11]]) el?.classList.remove('changed');
    requestAnimationFrame(() => {
      if (s) spans[9]?.classList.add('changed');
      if (a) spans[10]?.classList.add('changed');
    });
  }

  // The byte strip is wider than a phone, so the cell a slider changes is often
  // off-screen. Scrolling the container directly, rather than scrollIntoView,
  // keeps the page's vertical position untouched.
  const scroller = cells.closest('.wire__scroll');

  function revealCell(i) {
    const cell = spans[i];
    if (!scroller || !cell) return;
    const overflow = scroller.scrollWidth - scroller.clientWidth;
    if (overflow <= 0) return;
    const box = scroller.getBoundingClientRect();
    const rect = cell.getBoundingClientRect();
    const delta = (rect.left + rect.width / 2) - (box.left + box.width / 2);
    scroller.scrollLeft = Math.max(0, Math.min(scroller.scrollLeft + delta, overflow));
  }

  // Frame layout: byte 9 is speed, 10 is steering, 11 is lights.
  for (const [el, cell] of [[speed, 9], [steer, 10], [light, 11]]) {
    el.addEventListener('input', () => { paint(); revealCell(cell); });
  }
  paint();
}
