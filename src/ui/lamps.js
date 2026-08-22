// Built-in 6-lamp light array (port 0x35): mask + brightness.

import { $, setToggle, rangeControl } from './dom.js';
import { log } from '../debug-log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maskOf = (states) => states.reduce((m, on, i) => (on ? m | (1 << i) : m), 0);

export function initLampPanel(hub) {
  const brightInput = $('lamp-bright');
  const lampOn = [false, false, false, false, false, false];
  const lampBtns = [];

  function applyLamps() {
    if (!hub.protocol) return;
    const bright = +brightInput.value;
    const on = maskOf(lampOn);
    const off = maskOf(lampOn.map((v) => !v));
    // One brightness per command: lit lamps at brightness, the rest at 0.
    // Keyed, unlike the chase below.
    // See docs/DESIGN-NOTES.md § Lamp state has one source of truth
    if (on) hub.protocol.setLights(on, bright, 'lights:on');
    if (off) hub.protocol.setLights(off, 0, 'lights:off');
  }

  const host = $('lamps');
  for (let i = 0; i < 6; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(i + 1);
    b.className = 'lamp';
    // The button text is a bare number; on/off is carried by fill alone.
    b.ariaLabel = `lamp ${i + 1}`;
    setToggle(b, false);
    b.addEventListener('click', () => {
      lampOn[i] = !lampOn[i];
      setToggle(b, lampOn[i]);
      hub.gamepad?.syncLamps(lampOn);
      applyLamps();
    });
    lampBtns.push(b);
    host.append(b);
  }

  function setAllLamps(on) {
    lampOn.fill(on);
    lampBtns.forEach((b) => setToggle(b, on));
    hub.gamepad?.syncLamps(lampOn);
    applyLamps();
  }

  rangeControl('lamp-bright', { apply: applyLamps });
  $('lamps-all').addEventListener('click', () => setAllLamps(true));
  $('lamps-none').addEventListener('click', () => setAllLamps(false));
  $('lamps-chase').addEventListener('click', async () => {
    if (!hub.protocol) return;
    const bright = +brightInput.value;
    for (let i = 0; i < 6; i++) {
      log(`lamp ${i + 1} (bit ${i}, mask 0x${(1 << i).toString(16)})`);
      await hub.protocol.setLights(1 << i, bright);
      await hub.protocol.setLights(0x3f & ~(1 << i), 0);
      await sleep(700);
    }
    await hub.protocol.setLights(0x3f, 0);
    log('lamp chase done');
  });

  return {
    // Follows whatever changed the lamps elsewhere (the gamepad controller).
    showLamps(states) {
      states.forEach((on, i) => {
        lampOn[i] = on;
        lampBtns[i]?.classList.toggle('on', on);
      });
    },
  };
}
