// The hub's voltage sensor, and what the panel does with it. Both the decode
// and the sag latch are measured behaviour — see
// docs/DESIGN-NOTES.md § The supply sags under load, and the hub will report it in millivolts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoleMap, IO_TYPE, analyticsTotalFromWords } from '../src/lwp-decoders.js';

const VOLT_PORT = 0x3c, TEMP_PORT = 0x37, ANALYTICS_PORT = 0x3d;

test('the voltage and temperature devices are mapped by IOType, not by port number', () => {
  const roles = buildRoleMap([
    { port: 0x32, event: 0x01, ioType: IO_TYPE.DRIVE_MOTOR },
    { port: VOLT_PORT, event: 0x01, ioType: IO_TYPE.VOLTAGE },
    { port: TEMP_PORT, event: 0x01, ioType: IO_TYPE.TEMPERATURE },
    { port: ANALYTICS_PORT, event: 0x01, ioType: IO_TYPE.ANALYTICS },
  ]);
  assert.equal(roles.volt, VOLT_PORT);
  assert.equal(roles.temp, TEMP_PORT);
  assert.equal(roles.analytics, ANALYTICS_PORT);
});

test('a hub with no voltage device simply has no role for it', () => {
  const roles = buildRoleMap([{ port: 0x32, event: 0x01, ioType: IO_TYPE.DRIVE_MOTOR }]);
  assert.equal(roles.volt, undefined);
  assert.equal(roles.temp, undefined);
});

// One element per id, recording only what the panel writes into it.
function stubDom(ids) {
  const nodes = new Map();
  for (const id of ids) {
    nodes.set(id, {
      id, _text: '',
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); },
      addEventListener() {},
      setAttribute() {}, removeAttribute() {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    });
  }
  globalThis.document = {
    getElementById: (id) => nodes.get(id) ?? null,
    querySelectorAll: () => [],
  };
  return nodes;
}

const PANEL_IDS = ['bat-pct', 'queue-depth', 'tilt', 'telemetry', 'bat-refresh', 'bat-mv', 'power', 'bat-fill', 'odometer'];

async function panel() {
  const nodes = stubDom(PANEL_IDS);
  const priorInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  const { initTelemetryPanel } = await import('../src/ui/telemetry.js');
  let clock = 0;
  const api = initTelemetryPanel({}, { now: () => clock });
  globalThis.setInterval = priorInterval;
  return { api, nodes, tick: (ms) => { clock += ms; }, at: () => clock };
}

test('a live voltage is shown in volts, and no sag is claimed while the rail is steady', async () => {
  const { api, nodes } = await panel();
  api.showVoltage(3626);
  api.showVoltage(3622);
  assert.equal(nodes.get('power').textContent, 'supply 3.62 V · temp —');
  assert.equal(nodes.get('bat-mv').textContent, ' · 3.62 V');
});

test('a dip is latched after the rail recovers, which is the only way it is visible', async () => {
  const { api, nodes } = await panel();
  api.showVoltage(3626);
  api.showVoltage(2991);   // the measured sag under a full-throttle ramp
  api.showVoltage(3611);   // recovered ~150 ms later
  assert.match(nodes.get('power').textContent, /supply 3\.61 V · sag 2\.99 V \(10s\)/);
});

test('the latch expires with its window, so an old sag stops being reported', async () => {
  const { api, nodes, tick } = await panel();
  api.showVoltage(2991);
  tick(11000);
  api.showVoltage(3626);
  assert.equal(nodes.get('power').textContent, 'supply 3.63 V · temp —');
});

test('temperature shares the line and carries one decimal', async () => {
  const { api, nodes } = await panel();
  api.showTemperature(30.4);
  assert.equal(nodes.get('power').textContent, 'supply — · temp 30.4 °C');
});

test('a lost link blanks the readout rather than leaving a stale low number on screen', async () => {
  const { api, nodes } = await panel();
  api.showVoltage(2991);
  api.showTemperature(30.4);
  api.resetPower();
  assert.equal(nodes.get('power').textContent, 'supply — · temp —');
  assert.equal(nodes.get('bat-mv').textContent, '');
});

// The lifetime counters, which a port read hands back as Int16 words even
// though the hub declares them Int32.
// See docs/superpowers/expert/_knowledge-base/lego-lwp3-technic-move-hub.md § Updated 2026-09-02

test('Total is reassembled from word pairs, and the seconds stay unsigned', () => {
  // The reading measured on this hub: 326870 charge, 1336707 play, 108.
  const totals = analyticsTotalFromWords([-810, 4, 25987, 20, 108, 0]);
  assert.deepEqual(totals, { chargeSeconds: 326870, playSeconds: 1336707, third: 108 });
});

test('a short Total frame yields nothing rather than a partial reading', () => {
  assert.equal(analyticsTotalFromWords([1, 2, 3]), null);
  assert.equal(analyticsTotalFromWords(null), null);
});

test('the odometer prints hours once there is an hour, and minutes below it', async () => {
  const { api, nodes } = await panel();
  api.showOdometer({ chargeSeconds: 326870, playSeconds: 1336707, third: 108 });
  assert.equal(nodes.get('odometer').textContent, 'played 371.3 h · charged 90.8 h');
  api.showOdometer({ chargeSeconds: 0, playSeconds: 900, third: 0 });
  assert.equal(nodes.get('odometer').textContent, 'played 15 min · charged 0 min');
});

test('a hub with no analytics device leaves the odometer blank, not zeroed', async () => {
  const { api, nodes } = await panel();
  api.showOdometer(null);
  assert.equal(nodes.get('odometer').textContent, 'played — · charged —');
});

test('a lost link clears the odometer too', async () => {
  const { api, nodes } = await panel();
  api.showOdometer({ chargeSeconds: 3600, playSeconds: 7200, third: 0 });
  api.resetPower();
  assert.equal(nodes.get('odometer').textContent, 'played — · charged —');
});
