// BLE connection layer for the LEGO hub. Owns the GATT link only — no LWP knowledge.

import { log } from './debug-log.js';
import { createCommandQueue } from './write-queue.js';

const SERVICE_UUID = '00001623-1212-efde-1623-785feabcd123';
const CHAR_UUID = '00001624-1212-efde-1623-785feabcd123';

export class LegoBLETransport extends EventTarget {
  #device = null;
  #char = null;
  #queue = createCommandQueue(async (payload) => {
    // A payload is either one byte array or a burst of them.
    const frames = Array.isArray(payload) ? payload : [payload];
    for (const bytes of frames) {
      try {
        await this.#char.writeValueWithoutResponse(bytes);
        log('sent', bytes);
      } catch (err) {
        log('send ERROR', err.message, 'for', bytes);
        throw err;
      }
    }
  });
  #dead = false;
  #connecting = false;
  #onGattDisconnect = null;
  #onCharValue = null;

  // At most one 'disconnected' per instance, and none while retrying.
  // See docs/DESIGN-NOTES.md § Disconnection is announced once, and never during a retry
  #notifyDisconnected(reason) {
    if (this.#dead || this.#connecting) return;
    this.#dead = true;
    this.#releaseLink();
    this.dispatchEvent(new CustomEvent('disconnected', { detail: { reason } }));
  }

  // The browser retains the BluetoothDevice for the document's lifetime, so the
  // device listener has to be removed by hand — otherwise it pins this whole
  // transport, one graph per connect/disconnect cycle. Runs once, on the
  // terminal disconnect the notify guard admits, never between retries.
  // See docs/DESIGN-NOTES.md § The device listener has to be removed, or every reconnect leaks a graph
  #releaseLink() {
    this.#device?.removeEventListener?.('gattserverdisconnected', this.#onGattDisconnect);
    this.#char?.removeEventListener?.('characteristicvaluechanged', this.#onCharValue);
    this.#onGattDisconnect = null;
    this.#onCharValue = null;
  }

  // Each attempt is bounded and retried rather than left to Chrome's own timeout.
  // See docs/DESIGN-NOTES.md § A wedged hub accepts the connect and then stalls forever
  async connect({ attempts = 4, timeoutMs = 7000 } = {}) {
    if (!navigator.bluetooth) {
      const reason = 'Web Bluetooth not supported in this browser';
      this.dispatchEvent(new CustomEvent('disconnected', { detail: { reason } }));
      throw new Error(reason);
    }

    log('connect: requesting device…');
    this.#device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    log('connect: device picked:', this.#device.name || this.#device.id);
    this.#onGattDisconnect = () => {
      log('EVENT gattserverdisconnected (signal lost)');
      this.#notifyDisconnected('signal lost');
    };
    this.#device.addEventListener('gattserverdisconnected', this.#onGattDisconnect);

    let lastErr;
    this.#connecting = true;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        log(`connect: attempt ${attempt}/${attempts}…`);
        await this.#withTimeout(this.#openLink(), timeoutMs, 'handshake timed out');
        this.#dead = false;
        this.#connecting = false;
        log('connect: connected ✓');
        this.dispatchEvent(new CustomEvent('connected'));
        return;
      } catch (err) {
        lastErr = err;
        log(`connect: attempt ${attempt} failed —`, err.message);
        this.#char?.removeEventListener?.('characteristicvaluechanged', this.#onCharValue);
        this.#char = null;
        try { this.#device.gatt.disconnect(); } catch { /* ignore */ }
        // Give the hub a moment to tear the stale link down before retrying.
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    this.#connecting = false;
    log('connect: giving up —', lastErr?.message);
    this.#notifyDisconnected(lastErr?.message ?? 'connect failed');
    throw lastErr ?? new Error('connect failed');
  }

  async #openLink() {
    log('connect: gatt.connect…');
    const server = await this.#device.gatt.connect();
    log('connect: getPrimaryService…');
    const service = await server.getPrimaryService(SERVICE_UUID);
    log('connect: getCharacteristic…');
    this.#char = await service.getCharacteristic(CHAR_UUID);
    log('connect: startNotifications…');
    this.#onCharValue = (e) => {
      const dv = e.target.value;
      this.dispatchEvent(new CustomEvent('data', { detail: new Uint8Array(dv.buffer) }));
    };
    this.#char.addEventListener('characteristicvaluechanged', this.#onCharValue);
    await this.#char.startNotifications();
  }

  #withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ]);
  }

  disconnect() {
    if (this.#device?.gatt?.connected) this.#device.gatt.disconnect();
  }

  // key: optional coalescing key. Writes are dropped silently once the link is gone.
  // See docs/DESIGN-NOTES.md § A dead link fails quietly
  sendPayload(bytes, key) {
    if (!this.#char || this.#dead || !this.#device?.gatt?.connected) return;
    this.#queue.send(bytes, key);
  }

  // Several payloads back-to-back inside one queue slot; nothing interleaves.
  // See docs/DESIGN-NOTES.md § Two motors stay in step through one queue slot, not a virtual port
  sendBurst(payloads, key) {
    if (!this.#char || this.#dead || !this.#device?.gatt?.connected) return;
    this.#queue.send(payloads, key);
  }

  get connected() { return !!this.#device?.gatt?.connected; }

  get queueDepth() { return this.#queue.depth; }
}
