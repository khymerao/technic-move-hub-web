// Hub readouts: battery, supply voltage, temperature, queue depth, tilt, and
// the opt-in motion telemetry.

import { $, setToggle } from './dom.js';

// How far back the sag reading looks. A brake recovers in about 150 ms, so a
// live number alone never shows the dip that just happened.
// See docs/DESIGN-NOTES.md § The supply sags under load, and the hub will report it in millivolts
const SAG_WINDOW_MS = 10000;

export function initTelemetryPanel(hub, { now = () => Date.now() } = {}) {
  const batPct = $('bat-pct'), queueOut = $('queue-depth'), tilt = $('tilt'), telemetryBtn = $('telemetry');
  const batMv = $('bat-mv'), power = $('power'), odometer = $('odometer');

  const volts = [];
  let lastMv = null, lastC = null;

  const volt = (mv) => `${(mv / 1000).toFixed(2)} V`;

  // Hours once there is an hour to show, minutes below that. A hub fresh out of
  // the box reads 0 min, which is a reading; an em dash would claim no answer.
  const duration = (seconds) => (seconds >= 3600
    ? `${(seconds / 3600).toFixed(1)} h`
    : `${Math.round(seconds / 60)} min`);

  function paintPower() {
    if (!power) return;
    const supply = lastMv == null ? '—' : volt(lastMv);
    const sag = volts.length ? volt(Math.min(...volts.map((v) => v.mv))) : null;
    const temp = lastC == null ? '—' : `${lastC.toFixed(1)} °C`;
    const dip = sag && lastMv != null && lastMv - Math.min(...volts.map((v) => v.mv)) >= 50
      ? ` · sag ${sag} (${SAG_WINDOW_MS / 1000}s)` : '';
    power.textContent = `supply ${supply}${dip} · temp ${temp}`;
    if (batMv) batMv.textContent = lastMv == null ? '' : ` · ${volt(lastMv)}`;
  }

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

    showVoltage(mv) {
      const t = now();
      lastMv = mv;
      volts.push({ t, mv });
      while (volts.length && t - volts[0].t > SAG_WINDOW_MS) volts.shift();
      paintPower();
    },

    showTemperature(c) {
      lastC = c;
      paintPower();
    },

    // Lifetime counters the hub keeps for itself. Read once per connection —
    // they only move between sessions, so there is nothing to repaint.
    showOdometer(totals) {
      if (!odometer) return;
      odometer.textContent = totals
        ? `played ${duration(totals.playSeconds)} · charged ${duration(totals.chargeSeconds)}`
        : 'played — · charged —';
    },

    // The link is gone, so every number on this panel is stale rather than low.
    resetPower() {
      volts.length = 0;
      lastMv = null;
      lastC = null;
      paintPower();
      if (odometer) odometer.textContent = 'played — · charged —';
    },
  };
}
