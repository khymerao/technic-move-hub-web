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
