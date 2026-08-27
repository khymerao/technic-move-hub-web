// End to end through the real guard, mixer and driver: in `notify` mode the
// only event a collision produces is `impact`, and it must still be felt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollisionGuard } from '../src/collision.js';
import { createHapticsMix } from '../src/haptics-mix.js';
import { createHapticsDriver } from '../src/haptics-driver.js';

function fakeProtocol() {
  const bus = new EventTarget();
  bus.setLights = async () => {};
  bus.subscribeToAccel = async () => {};
  bus.unsubscribeAccel = async () => {};
  return bus;
}

function fakeActuator() {
  return {
    played: [],
    playEffect(type, params) { this.played.push(params); return Promise.resolve('complete'); },
    reset() { return Promise.resolve('complete'); },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

test('notify mode: a collision still reaches the strong motor', async () => {
  const protocol = fakeProtocol();
  const guard = createCollisionGuard(protocol);
  guard.setMode('notify');
  await guard.arm();

  const actuator = fakeActuator();
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings({ enabled: true, transient: 1, bed: 1 });
  const driver = createHapticsDriver({ mix, intervalMs: 80, now: () => t });
  driver.tick({ vibrationActuator: actuator }, 0);
  await settle();

  guard.addEventListener('impact', (e) => {
    driver.hit('impact', Math.min(1, e.detail.magnitude / 3500));
  });

  protocol.dispatchEvent(new CustomEvent('accel', { detail: { x: 0, y: 0, z: 1000 } }));
  protocol.dispatchEvent(new CustomEvent('accel', { detail: { x: 0, y: 0, z: 3500 } }));
  await settle();

  const strongest = Math.max(...actuator.played.map((p) => p.strongMagnitude));
  assert.ok(strongest > 0, `nothing reached the motor: ${JSON.stringify(actuator.played)}`);
});
