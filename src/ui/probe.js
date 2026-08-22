// Light / port probe: empirically find which port drives which light.

import { $ } from './dom.js';
import { log } from '../debug-log.js';
import {
  encodePortInformationRequest, encodePortModeInformationRequest, MODE_INFO,
} from '../lwp-encoders.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INFO_NAME = Object.fromEntries(
  Object.entries(MODE_INFO).map(([name, code]) => [code, name]));

const hex8 = (n) => '0x' + n.toString(16).padStart(2, '0');
const bits8 = (v) => (v & 0xff).toString(2).padStart(8, '0');
// Port values arrive signed, but a port that declares RAW 0..255 means the
// byte. Both readings are shown so the log matches whichever the port meant.
const byte8 = (v) => '0x' + (v & 0xff).toString(16).padStart(2, '0');
const unsigned8 = (v) => v & 0xff;

// Resolves with the first matching event detail, or null on timeout.
function once(target, type, match, timeoutMs, trigger) {
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      target.removeEventListener(type, onEvent);
      resolve(value);
    };
    const onEvent = (e) => { if (match(e.detail)) done(e.detail); };
    const timer = setTimeout(() => done(null), timeoutMs);
    target.addEventListener(type, onEvent);
    trigger?.();
  });
}

function describeModeInfo(d) {
  if (d.text !== undefined) return d.text;
  if (d.range) return `${d.range[0]} .. ${d.range[1]}`;
  if (d.mapping) return `in=${bits8(d.mapping[0])} out=${bits8(d.mapping[1])}`;
  if (d.format) {
    const f = d.format;
    return `${f.values}x ${f.dataType}, ${f.figures} figures, ${f.decimals} decimals`;
  }
  return `[${d.raw}]`;
}

export function initProbePanel(hub) {
  const hexPort = () => parseInt($('p-port').value.replace(/^0x/i, ''), 16);

  $('p-send').addEventListener('click', () =>
    hub.protocol?.writeDirectMode(hexPort(), +$('p-mode').value, +$('p-val').value));
  $('p-off').addEventListener('click', () =>
    hub.protocol?.writeDirectMode(hexPort(), +$('p-mode').value, 0));
  $('p-csv-send').addEventListener('click', () => {
    const vals = $('p-csv').value.split(',').map((s) => +s.trim()).filter((n) => !Number.isNaN(n));
    hub.protocol?.writeDirectMode(hexPort(), +$('p-mode').value, vals);
  });

  // Walk modes 0..5 on one port.
  $('p-modes').addEventListener('click', async () => {
    if (!hub.protocol) return;
    const port = hexPort(), val = +$('p-val').value;
    for (let mode = 0; mode <= 5; mode++) {
      log(`probe: port 0x${port.toString(16)} mode ${mode} = ${val}`);
      await hub.protocol.writeDirectMode(port, mode, val);
      await sleep(700);
      await hub.protocol.writeDirectMode(port, mode, 0);
      await sleep(200);
    }
    log('probe: mode sweep done');
  });

  initIntrospectPanel(hub);
}

// Read-only side: ask the hub to describe a port, and watch one mode's values.
function initIntrospectPanel(hub) {
  const iPort = () => parseInt($('i-port').value.replace(/^0x/i, ''), 16);
  const iMode = () => +$('i-mode').value;
  const watched = new Set();
  const repeats = new Map();
  const wired = new WeakSet();

  const wire = (protocol) => {
    if (wired.has(protocol)) return;
    wired.add(protocol);
    protocol.addEventListener('port-information', (e) => {
      const d = e.detail;
      log(`port ${hex8(d.port)}: capabilities ${bits8(d.capabilities)},`,
        `${d.modeCount} modes, input [${d.inputModes}], output [${d.outputModes}]`);
    });
    protocol.addEventListener('port-mode-information', (e) => {
      const d = e.detail;
      log(`  ${hex8(d.port)} mode ${d.mode} ${INFO_NAME[d.infoType] ?? d.infoType}:`,
        describeModeInfo(d));
    });
    protocol.addEventListener('port-value', (e) => {
      const { port, values } = e.detail;
      if (!watched.has(port)) return;
      const shown = `[${values}] u8 [${values.map(unsigned8)}]`
        + ` hex ${values.map(byte8).join(' ')} bits ${values.map(bits8).join(' ')}`;
      const seen = repeats.get(port);
      if (seen?.shown === shown) { seen.count += 1; return; }
      if (seen?.count > 1) log(`WATCH ${hex8(port)} — previous value repeated ${seen.count}x`);
      repeats.set(port, { shown, count: 1 });
      log(`WATCH ${hex8(port)} = ${shown}`);
    });
  };

  $('i-describe').addEventListener('click', async () => {
    const protocol = hub.protocol;
    if (!protocol) { log('introspect: not connected'); return; }
    wire(protocol);
    const port = iPort();
    log(`introspect: describing port ${hex8(port)}`);
    const info = await once(protocol, 'port-information', (d) => d.port === port, 2000,
      () => protocol.sendRaw(encodePortInformationRequest(port, 0x01)));
    if (!info) { log(`introspect: no reply for port ${hex8(port)}`); return; }
    for (let mode = 0; mode < info.modeCount; mode++) {
      for (const infoType of Object.values(MODE_INFO)) {
        await protocol.sendRaw(encodePortModeInformationRequest(port, mode, infoType));
        await sleep(80);
      }
    }
    log('introspect: describe done');
  });

  $('i-value').addEventListener('click', async () => {
    const protocol = hub.protocol;
    if (!protocol) { log('introspect: not connected'); return; }
    wire(protocol);
    const port = iPort();
    watched.add(port);
    await protocol.sendRaw(encodePortInformationRequest(port, 0x00));
    log(`introspect: value requested from ${hex8(port)}`);
  });

  $('i-watch').addEventListener('click', async () => {
    const protocol = hub.protocol;
    if (!protocol) { log('introspect: not connected'); return; }
    wire(protocol);
    const port = iPort(), mode = iMode(), delta = +$('i-delta').value;
    if (delta < 1) { log('introspect: delta 0 floods the link and drops it — use 1 or more'); return; }
    watched.add(port);
    try {
      await protocol.subscribePort(port, mode, delta, 'probe');
      log(`introspect: watching ${hex8(port)} mode ${mode} delta ${delta}`);
    } catch (err) {
      watched.delete(port);
      log('introspect: watch failed —', err.message);
    }
  });

  $('i-unwatch').addEventListener('click', async () => {
    const port = iPort();
    watched.delete(port);
    await hub.protocol?.unsubscribePort(port, iMode(), 'probe');
    log(`introspect: stopped watching ${hex8(port)}`);
  });
}
