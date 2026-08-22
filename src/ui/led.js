// Hub RGB LED colour buttons.

import { $ } from './dom.js';

export function initLedPanel(hub) {
  $('leds').addEventListener('click', (e) => {
    const c = e.target.dataset.color;
    if (c != null && hub.protocol) hub.protocol.setLed(+c);
  });
}
