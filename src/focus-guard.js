// The window `blur` estop decision, kept pure and apart from the composition
// root so it can be tested without booting it.
// See docs/DESIGN-NOTES.md § Blur is the focus loss visibilitychange never reports
export function blurShouldStop({ running, hasFocus }) {
  if (typeof hasFocus === 'function' && hasFocus()) return false;
  return !!running;
}
