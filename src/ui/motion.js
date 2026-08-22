// Motion panel: the hub's attitude and the live steering angle. The 3D scene is
// optional — everything here works as numbers if it never loads.
//
// See docs/superpowers/specs/2026-07-30-motion-visualisation-design.md

import { $ } from './dom.js';
import { createDial } from './dial.js';
import {
  quatFromOrint, quatHubToScene, eulerSceneFromQuat, applyMount, alignSign,
} from '../orientation.js';

const HOLDER = 'motion';
const MOUNT_KEY = 'motion.mount';
// Both settled by the hardware session; see the plan's Task 1.
const ORINT_MODE = 0x00;
const ORINT_DELTA = 40;
// Must equal the P-loop's delta or sharing the stream rewrites it.
// See src/steering-controller.js enterSteerMode()
const STEER_DELTA = 15;

export function initMotionPanel(hub) {
  const readout = $('m-readout'), needle = $('m-needle'), degOut = $('m-deg');
  const note = $('m-note'), canvas = $('m-canvas');
  const dial = createDial({ bug: needle });

  let active = false;
  let mount = loadMount();
  let last = null;
  let scene = null;
  let sceneTried = false;

  function loadMount() {
    try { return JSON.parse(localStorage.getItem(MOUNT_KEY)) || null; }
    catch { return null; }
  }

  $('m-centre').addEventListener('click', () => {
    if (!last) { note.textContent = 'no orientation data yet'; return; }
    mount = last;
    localStorage.setItem(MOUNT_KEY, JSON.stringify(mount));
    note.textContent = 'centred — keep the car level and facing away when you do this';
  });

  async function arm() {
    const p = hub.protocol;
    if (!p) return;
    // acquire() throws when the port is already streaming another mode —
    // the Debug probe is the realistic case.
    // See docs/ARCHITECTURE.md § 7. A port streams ONE input mode at a time
    const errors = [];
    try {
      await p.subscribeOrientation(ORINT_MODE, ORINT_DELTA, HOLDER);
    } catch (err) {
      errors.push(`orientation: ${err.message}`);
    }
    try {
      if (p.roles?.steer != null) {
        await p.subscribeToPosition(p.roles.steer, STEER_DELTA, HOLDER);
      }
    } catch (err) {
      errors.push(`steer: ${err.message}`);
    }
    if (errors.length) note.textContent = `stream unavailable: ${errors.join('; ')}`;
    if (!sceneTried) { sceneTried = true; scene = await loadScene(errors.length > 0); }
    if (active) scene?.start();
  }

  async function disarm() {
    scene?.stop();
    await hub.protocol?.releaseStreams(HOLDER);
  }

  // See docs/superpowers/specs/2026-07-30-motion-visualisation-design.md §
  // three.js (the `m-note` priority bullet)
  async function loadScene(hasStreamError) {
    try {
      const { createMotionScene } = await import('../motion-scene.js');
      return createMotionScene(canvas);
    } catch {
      if (!hasStreamError) note.textContent = '3D unavailable — numbers only';
      canvas.hidden = true;
      return null;
    }
  }

  function render(q) {
    last = q;
    const e = eulerSceneFromQuat(applyMount(q, mount));
    readout.textContent = `roll ${Math.round(e.roll)}° · pitch ${Math.round(e.pitch)}°`
      + ` · yaw ${Math.round(e.yaw)}° (relative)`;
    scene?.setOrientation(applyMount(q, mount));
  }

  return {
    async setActive(on) {
      if (on === active) return;
      active = on;
      if (on) await arm(); else await disarm();
    },

    // The protocol and its registry are replaced wholesale on reconnect, so no
    // subscription state from before is meaningful.
    reset() {
      active = false;
      last = null;
      scene?.stop();
      readout.textContent = 'roll — · pitch — · yaw —';
      degOut.textContent = '—';
      needle.style.transform = 'rotate(0deg)';
    },

    showOrientation({ values }) {
      const q = alignSign(last, quatHubToScene(quatFromOrint(values)));
      if (q) render(q);
    },

    showSteer({ pos, zeroed }) {
      if (!active) return;
      degOut.textContent = zeroed ? `${Math.round(pos)}°` : '— (set zero in Setup)';
      needle.classList.toggle('unzeroed', !zeroed);
      const maxAngle = hub.steering?.params?.maxAngle || 90;
      dial.show({ commanded: zeroed ? pos : 0, maxAngle });
    },
  };
}
