// Shared DOM plumbing for the panels.

export const $ = (id) => document.getElementById(id);

// Press-and-hold control. All three release events are required.
// See docs/DESIGN-NOTES.md § Every way the pointer can leave a hold button counts as a release
export function holdButton(node, onDown, onUp) {
  const down = (e) => { e.preventDefault(); onDown(); node.classList.add('active'); };
  const up = (e) => { e.preventDefault(); onUp(); node.classList.remove('active'); };
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  node.addEventListener('pointerleave', up);
}

// One state system for the hand-rolled toggles: class paints, aria-pressed
// announces. See docs/DESIGN-NOTES.md § One state system for the hand-rolled toggles
export function setToggle(node, on) {
  node.classList.toggle('on', on);
  node.ariaPressed = on ? 'true' : 'false';
}

// Slider with a live readout in the matching `<output id="{id}-out">`. `scale`
// converts the integer input to the value the controller wants (kp 1..50 ->
// 0.1..5.0), `format` renders it. Returns the input so callers can read it.
// See docs/DESIGN-NOTES.md § Sliders carry integers; `scale` converts
export function rangeControl(id, { scale = (v) => v, format = String, apply } = {}) {
  const input = $(id), out = $(`${id}-out`);
  const value = () => scale(+input.value);
  const paint = () => { if (out) out.textContent = format(value()); };
  input.addEventListener('input', () => { paint(); apply?.(value()); });
  paint();
  return input;
}

// Value-keyed DOM writes: each helper remembers what it last put on that
// element for that property and skips a write that would change nothing.
//
// Gating here rather than in the panels is what makes it correct. The panels'
// paint functions are not pure functions of the frame — the dial also reads the
// position stream, the measured toggle and the steering mode — so a memo keyed
// on the incoming frame would freeze the dial against everything else that
// moves it. Keyed on the value actually written, every writer shares one memo
// and none of them can leave it stale: the out-of-band status messages, the
// mode cluster and the link-lost reset all go through the same door.
//
// See docs/DESIGN-NOTES.md § The panels write what changed, and nothing else
const written = new WeakMap();

const changed = (el, key, value) => {
  let seen = written.get(el);
  if (!seen) { seen = new Map(); written.set(el, seen); }
  if (seen.has(key) && Object.is(seen.get(key), value)) return false;
  seen.set(key, value);
  return true;
};

export function setText(el, value) {
  if (!el) return;
  const v = String(value);
  if (changed(el, 'text', v)) el.textContent = v;
}


export function setAttr(el, name, value) {
  if (!el) return;
  const v = String(value);
  if (changed(el, `attr:${name}`, v)) el.setAttribute(name, v);
}


export function setClass(el, name, on) {
  if (!el) return;
  if (changed(el, `class:${name}`, !!on)) el.classList.toggle(name, !!on);
}
