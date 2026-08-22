// Hub readouts: battery, queue depth, tilt, and the opt-in motion telemetry.

import { $, setToggle } from './dom.js';

export function initTelemetryPanel(hub) {
  const batPct = $('bat-pct'), queueOut = $('queue-depth'), tilt = $('tilt'), telemetryBtn = $('telemetry');

  $('bat-refresh').addEventListener('click', () => hub.protocol?.requestBattery());

  // Off by default — it is the main source of link pressure.
  // See docs/DESIGN-NOTES.md § Motion telemetry is off by default
  let telemetryOn = false;
  telemetryBtn.addEventListener('click', async () => {
    if (!hub.protocol) return;
    telemetryOn = !telemetryOn;
    telemetryBtn.textContent = `telemetry: ${telemetryOn ? 'ON' : 'OFF'}`;
    setToggle(telemetryBtn, telemetryOn);
    if (telemetryOn) {
      await hub.protocol.subscribeToIMU(0, 60, 'telemetry');
      // Drive motors only: the steer port is owned by the position stream.
      // See docs/DESIGN-NOTES.md § A port can only be interpreted as one mode at a time
      for (const port of [hub.protocol.roles.driveA, hub.protocol.roles.driveB]) {
        if (port != null) await hub.protocol.subscribeToSpeed(port, 20, 'telemetry');
      }
    } else {
      await hub.protocol.unsubscribeTelemetry('telemetry');
    }
  });

  // Queue depth: should sit at 0-2; blank at rest, shown when it climbs.
  // See docs/DESIGN-NOTES.md § Queue depth is only shown when it is climbing
  setInterval(() => {
    if (!hub.transport) return;
    const depth = hub.transport.queueDepth;
    queueOut.textContent = depth > 0 ? ` · q${depth}` : '';
  }, 250);

  return {
    showBattery(percent) {
      batPct.textContent = `${percent}%`;
      // The glyph's inner rect is 18.6 wide at full; scaling it is the whole
      // indicator. Colour changes only at the point where it starts to matter.
      const fill = document.getElementById('bat-fill');
      if (!fill) return;
      const p = Math.max(0, Math.min(100, percent));
      fill.setAttribute('width', String((18.6 * p / 100).toFixed(2)));
      fill.classList.toggle('low', p <= 20);
    },
    showTilt({ x, y, z }) { tilt.textContent = `tilt: x=${x} y=${y} z=${z}`; },
  };
}
