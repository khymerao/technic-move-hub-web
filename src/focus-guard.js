// The window `blur` estop decision, kept pure and apart from the composition
// root so it can be tested without booting it.
// See docs/DESIGN-NOTES.md § Blur is the focus loss visibilitychange never reports
export function blurShouldStop({ running, hasFocus }) {
  if (typeof hasFocus === 'function' && hasFocus()) return false;
  return !!running;
}

// On Android a gamepad also emits key events — the D-pad arrives as arrow keys
// — and those scroll the page, so an armed loop takes them away from the
// browser. A field being typed into keeps them: without that the macro editor
// lost Backspace, Enter, space, Tab and the arrows whenever the pad was armed.
// See docs/DESIGN-NOTES.md § The swallowed keys are the browser's, not the typist's
export const SWALLOW_KEYS = [' ', 'Spacebar', 'Enter', 'Backspace', 'Tab',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

const isTyping = (el) => !!el
  && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true);

export function swallowKey({ running, key, target }) {
  if (!running) return false;
  if (isTyping(target)) return false;
  return SWALLOW_KEYS.includes(key);
}
