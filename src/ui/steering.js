// Steering panel: raw/closed-loop toggle, zero capture, jog buttons, tuning.

import { $, holdButton, rangeControl } from './dom.js';
import { log } from '../debug-log.js';

export function initSteeringPanel(hub) {
  const stMode = $('st-mode');
  const readout = $('st-readout');

  // The select follows the controller rather than owning the value.
  // See docs/DESIGN-NOTES.md § The select follows the controller, it does not own the mode
  const showMode = () => {
    const mode = hub.steering?.mode === 'steer' ? 'steer' : 'raw';
    if (stMode.value !== mode) stMode.value = mode;
  };

  stMode.addEventListener('change', (e) => {
    const steering = hub.steering;
    if (!steering) { showMode(); return; }
    if (e.target.value === 'steer') {
      // See docs/DESIGN-NOTES.md § The select follows the controller, it does not own the mode
      steering.enterSteerMode()
        .then(showMode) // captures zero if the user has not set one
        .catch((err) => {
          log('steer mode failed:', err.message);
          showMode();
        });
    } else {
      steering.mode = 'raw';
      steering.jogStop(); // leaving closed-loop must not leave the motor energised
      showMode();
    }
  });

  $('st-zero').addEventListener('click', () => hub.steering?.setZero());
  $('st-center').addEventListener('click', () => hub.steering?.setInput(0));

  // LEFT / RIGHT: in raw mode spin the motor; in steer mode command full lock.
  const steerHold = (node, dir) => holdButton(node,
    () => {
      const steering = hub.steering;
      if (!steering) return;
      if (steering.mode === 'raw') steering.jog(dir);
      else steering.setInput(dir * 100);
    },
    () => {
      const steering = hub.steering;
      if (!steering) return;
      if (steering.mode === 'raw') steering.jogStop();
      else steering.release();
    });
  steerHold($('st-left'), -1);
  steerHold($('st-right'), 1);

  const tune = (key) => (v) => { if (hub.steering) hub.steering.params[key] = v; };
  rangeControl('st-speed', { apply: tune('turnSpeed') });
  rangeControl('st-angle', { format: (v) => `${v}°`, apply: tune('maxAngle') });
  // kp is fractional; the slider carries tenths.
  rangeControl('st-kp', { scale: (v) => v / 10, format: (v) => v.toFixed(1), apply: tune('kp') });
  rangeControl('st-dead', { format: (v) => `${v}°`, apply: tune('deadband') });
  $('st-return').addEventListener('change', (e) => { if (hub.steering) hub.steering.params.autoReturn = e.target.checked; });
  $('st-invert').addEventListener('change', (e) => { if (hub.steering) hub.steering.params.invert = e.target.checked; });

  return {
    showMode,
    // An emergency stop drops closed-loop control; the motors themselves are
    // stopped by the motor panel right after.
    forceRaw() {
      if (!hub.steering) return;
      hub.steering.mode = 'raw';
      showMode();
    },
    showPos({ pos, target, zeroed }) {
      readout.textContent = `pos ${pos} → ${target}${zeroed ? '' : ' (set zero!)'}`;
    },
  };
}
