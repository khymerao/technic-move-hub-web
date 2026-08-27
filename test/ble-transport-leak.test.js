import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LegoBLETransport } from '../src/ble-transport.js';

// A fake Web Bluetooth stack that counts listener add/remove per event type, so
// a test can prove the transport lets go of the browser-retained device and
// characteristic on disconnect. The real leak: Chromium keeps the
// BluetoothDevice for the document's lifetime, so an un-removed
// `gattserverdisconnected` listener pins the whole transport -> protocol ->
// controllers graph, one graph per connect/disconnect cycle.
// See docs/DESIGN-NOTES.md § The device listener has to be removed, or every reconnect leaks a graph
function fakeBluetooth() {
  const count = (target) => {
    const live = new Map();
    target.addEventListener = (type, fn) => {
      const set = live.get(type) ?? new Set();
      set.add(fn);
      live.set(type, set);
    };
    target.removeEventListener = (type, fn) => { live.get(type)?.delete(fn); };
    target.fire = (type) => { for (const fn of live.get(type) ?? []) fn({ target }); };
    target.liveCount = (type) => (live.get(type)?.size ?? 0);
    return target;
  };

  const characteristic = count({
    value: { buffer: new Uint8Array([0x03, 0x00, 0x02]).buffer },
    async startNotifications() {},
    async writeValueWithoutResponse() {},
  });
  const device = count({
    name: 'Technic Move',
    gatt: {
      connected: true,
      async connect() {
        return { async getPrimaryService() { return { async getCharacteristic() { return characteristic; } }; } };
      },
      disconnect() { device.gatt.connected = false; device.fire('gattserverdisconnected'); },
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { bluetooth: { async requestDevice() { return device; } } },
    configurable: true, writable: true,
  });
  return { device, characteristic };
}

test('a lost link removes the device and characteristic listeners', async () => {
  const { device, characteristic } = fakeBluetooth();
  const t = new LegoBLETransport();
  await t.connect({ attempts: 1, timeoutMs: 500 });

  assert.equal(device.liveCount('gattserverdisconnected'), 1, 'listener present while connected');
  assert.equal(characteristic.liveCount('characteristicvaluechanged'), 1);

  // A real drop: the browser clears the flag, then fires the event.
  device.gatt.connected = false;
  device.fire('gattserverdisconnected');

  assert.equal(device.liveCount('gattserverdisconnected'), 0,
    'the device listener must be removed, or the browser-retained device pins the transport graph');
  assert.equal(characteristic.liveCount('characteristicvaluechanged'), 0,
    'the characteristic listener pins the transport too, via device.gatt');
});

test('an app-initiated disconnect also releases the listeners', async () => {
  const { device, characteristic } = fakeBluetooth();
  const t = new LegoBLETransport();
  await t.connect({ attempts: 1, timeoutMs: 500 });

  t.disconnect();

  assert.equal(device.liveCount('gattserverdisconnected'), 0);
  assert.equal(characteristic.liveCount('characteristicvaluechanged'), 0);
});
