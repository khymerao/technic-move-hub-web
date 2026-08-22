// Regression test for the feedback-lost dial staying trustworthy: the runaway
// path resets #zeroed before the same-frame `pos` event goes out
// (src/steering-controller.js:126-127), but the feedback-lost path did not, so
// the dial kept showing a frozen angle as if the reading were still live. This
// drives a real SteeringController — no source-scanning — into the
// feedback-lost path and checks what the very next `pos` event says.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const STEER_PORT = 0x34;

// Enters steer mode with a target away from zero, then runs the real rAF loop
// on a fake clock with no incoming position updates at all — the scenario
// that trips the feedback-timeout cutout.
async function driveIntoFeedbackLost() {
  let clock = 0;
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock }, configurable: true, writable: true,
  });
  let pending = null;
  globalThis.requestAnimationFrame = (fn) => { pending = fn; return 1; };
  globalThis.cancelAnimationFrame = () => { pending = null; };

  const { SteeringController } = await import('../src/steering-controller.js');
  const protocol = {
    addEventListener() {}, // no 'position' events fire — that is the point
    setMotorSpeedRaw() {},
    subscribeToPosition: async () => {},
  };
  const sc = new SteeringController(protocol, STEER_PORT);
  await sc.enterSteerMode();
  sc.setInput(100); // target = +maxAngle, well past the deadband from pos 0

  const events = [];
  sc.addEventListener('feedback-lost', (e) => events.push(['feedback-lost', e.detail]));
  sc.addEventListener('pos', (e) => events.push(['pos', e.detail]));

  await sc.start();
  for (let i = 0; i < 20 && !events.some(([n]) => n === 'feedback-lost'); i++) {
    clock += 100;
    const tick = pending; pending = null; tick?.();
  }
  sc.stop();
  return { sc, events };
}

test('feedback-lost resets #zeroed so the next pos event is not stale', async () => {
  const { sc, events } = await driveIntoFeedbackLost();

  const lostAt = events.findIndex(([name]) => name === 'feedback-lost');
  assert.ok(lostAt !== -1, 'the loop must reach feedback-lost within the driven frames');

  const [name, detail] = events[lostAt + 1];
  assert.equal(name, 'pos', 'feedback-lost is followed by a pos event in the same frame');
  assert.equal(detail.mode, 'raw', 'feedback-lost must drop back to raw mode');
  assert.equal(detail.zeroed, false,
    'the pos event dispatched alongside feedback-lost must carry zeroed: false');
  assert.equal(sc.isZeroed, false, 'the controller must require a fresh zero before re-arming');
});
