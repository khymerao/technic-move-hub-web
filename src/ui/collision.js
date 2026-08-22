// Crash guard toggle. Off by default: it costs an accelerometer subscription.
// The label is rendered from the guard, never from the click that caused it —
// the guard is armed and disarmed by things other than this button.
// See docs/DESIGN-NOTES.md § The filtering happens in the hub, not here

import { $, setToggle } from './dom.js';

export function initCollisionPanel(hub) {
  const btn = $('collision');

  const sync = () => {
    const armed = hub.collision?.armed ?? false;
    btn.textContent = `crash guard: ${armed ? 'ON' : 'OFF'}`;
    setToggle(btn, armed);
  };

  btn.addEventListener('click', async () => {
    const guard = hub.collision;
    if (!guard) return;
    if (guard.armed) await guard.disarm();
    else await guard.arm();
    sync();
  });

  return { sync, reset: sync };
}
