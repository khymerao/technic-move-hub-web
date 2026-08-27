import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHapticsMix } from '../src/haptics-mix.js';

const ON = { enabled: true, transient: 1, bed: 1 };

function mixAt() {
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings(ON);
  return { mix, at: (ms) => { t = ms; return mix.tick(ms); } };
}

test('a transient holds at full magnitude before it decays', () => {
  const { mix, at } = mixAt();
  mix.hit('impact', 0.8);
  assert.equal(at(0).strong, 0.8);
  assert.equal(at(50).strong, 0.8);
  assert.ok(at(120).strong < 0.8);
  assert.equal(at(400).strong, 0);
});

test('two transients take the louder, never the sum', () => {
  const { mix, at } = mixAt();
  mix.hit('impact', 0.6);
  mix.hit('brake', 0.5);
  assert.equal(at(0).strong, 0.6);
});

test('the bed follows drive and turn', () => {
  const { mix, at } = mixAt();
  mix.drive({ drive: 0, turn: 0, dtMs: 16 });
  const idle = at(0).weak;
  mix.drive({ drive: 1, turn: 0, dtMs: 16 });
  const fast = at(16).weak;
  assert.ok(fast > idle);
  mix.drive({ drive: 1, turn: 1, dtMs: 16 });
  assert.ok(at(32).weak > fast);
});

test('the bed rises with throttle change at the same speed', () => {
  const { mix, at } = mixAt();
  mix.drive({ drive: 0.5, turn: 0, dtMs: 16 });
  mix.drive({ drive: 0.5, turn: 0, dtMs: 16 });
  const steady = at(0).weak;
  mix.drive({ drive: 0.5, turn: 0, dtMs: 16 });
  mix.drive({ drive: 0.9, turn: 0, dtMs: 16 });
  mix.drive({ drive: 0.5, turn: 0, dtMs: 16 });
  const changing = at(16).weak;
  assert.ok(changing > steady);
});

test('the bed ducks to zero while a transient is live', () => {
  const { mix, at } = mixAt();
  mix.drive({ drive: 1, turn: 0, dtMs: 16 });
  assert.ok(at(0).weak > 0);
  mix.hit('impact', 1);
  const hit = at(1);
  assert.equal(hit.strong, 1);
  assert.equal(hit.weak, 0);
  mix.drive({ drive: 1, turn: 0, dtMs: 16 });
  assert.ok(at(800).weak > 0);
});

test('a stale bed decays to zero instead of latching', () => {
  const { mix, at } = mixAt();
  mix.drive({ drive: 1, turn: 0, dtMs: 16 });
  assert.ok(at(0).weak > 0);
  assert.equal(at(1000).weak, 0);
});

test('settings scale each motor and exact zero survives', () => {
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings({ enabled: true, transient: 0.5, bed: 0 });
  mix.hit('impact', 1);
  mix.drive({ drive: 1, turn: 0, dtMs: 16 });
  const out = mix.tick(0);
  assert.equal(out.strong, 0.5);
  assert.equal(out.weak, 0);
  assert.ok(Object.is(out.weak, 0));
});

test('disabled emits exact zero on both motors', () => {
  const { mix, at } = mixAt();
  mix.hit('impact', 1);
  mix.drive({ drive: 1, turn: 1, dtMs: 16 });
  mix.setSettings({ enabled: false, transient: 1, bed: 1 });
  assert.deepEqual(at(0), { strong: 0, weak: 0 });
});

test('output never exceeds one', () => {
  const { mix, at } = mixAt();
  mix.hit('impact', 5);
  mix.drive({ drive: 9, turn: 9, dtMs: 16 });
  const out = at(0);
  assert.ok(out.strong <= 1);
  assert.ok(out.weak <= 1);
});

test('silence clears everything', () => {
  const { mix, at } = mixAt();
  mix.hit('cut', 1);
  mix.drive({ drive: 1, turn: 1, dtMs: 16 });
  mix.silence();
  assert.deepEqual(at(0), { strong: 0, weak: 0 });
});

test('a non-finite magnitude never reaches the strong motor', () => {
  const { mix, at } = mixAt();
  mix.hit('impact');
  assert.deepEqual(at(0), { strong: 0, weak: 0 });
  mix.hit('impact', NaN);
  assert.deepEqual(at(0), { strong: 0, weak: 0 });
  mix.hit('impact', Infinity);
  assert.deepEqual(at(0), { strong: 0, weak: 0 });
  mix.hit('impact', '0.5');
  assert.deepEqual(at(0), { strong: 0, weak: 0 });
});

test('a non-finite drive input does not poison the bed', () => {
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings(ON);
  mix.drive({ drive: NaN, turn: NaN, dtMs: NaN });
  const poisoned = mix.tick(0);
  assert.ok(Object.is(poisoned.weak, 0));
  assert.ok(Object.is(poisoned.strong, 0));
  mix.drive({ drive: 1, turn: 0, dtMs: 16 });
  const recovered = mix.tick(0).weak;

  let u = 0;
  const clean = createHapticsMix({ now: () => u });
  clean.setSettings(ON);
  clean.drive({ drive: 1, turn: 0, dtMs: 16 });
  assert.equal(recovered, clean.tick(0).weak);
});

test('a non-finite tick time falls back to the clock', () => {
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings(ON);
  mix.hit('impact', 0.8);
  t = 50;
  assert.equal(mix.tick(NaN).strong, 0.8);
});

test('non-finite settings scale to silence, not to NaN', () => {
  const { mix, at } = mixAt();
  mix.setSettings({ enabled: true, transient: NaN, bed: NaN });
  mix.hit('impact', 1);
  mix.drive({ drive: 1, turn: 1, dtMs: 16 });
  const out = at(0);
  assert.ok(Object.is(out.strong, 0));
  assert.ok(Object.is(out.weak, 0));
});

test('a quiet re-hit never cuts a louder one short', () => {
  const { mix, at } = mixAt();
  mix.hit('impact', 1);
  at(61);
  mix.hit('impact', 0.1);
  assert.ok(at(61).strong > 0.9);
});

test('a louder re-hit retriggers the channel', () => {
  const { mix, at } = mixAt();
  mix.hit('impact', 0.5);
  assert.ok(at(100).strong < 0.5);
  mix.hit('impact', 0.9);
  assert.equal(at(100).strong, 0.9);
  assert.equal(at(150).strong, 0.9);
});

test('a transient the user cannot feel does not duck the bed', () => {
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings({ enabled: true, transient: 0, bed: 1 });
  mix.drive({ drive: 1, turn: 0, dtMs: 16 });
  mix.hit('impact', 1);
  const out = mix.tick(0);
  assert.ok(Object.is(out.strong, 0));
  assert.ok(out.weak > 0);
});

test('a saturating transient lands on exactly one', () => {
  const { mix, at } = mixAt();
  mix.hit('impact', 5);
  assert.equal(at(0).strong, 1);
});

test('a saturating bed lands on exactly one', () => {
  const { mix, at } = mixAt();
  mix.drive({ drive: 9, turn: 9, dtMs: 16 });
  assert.equal(at(0).weak, 1);
});

test('the stale bed fades through the middle of the fade window', () => {
  const { mix, at } = mixAt();
  mix.drive({ drive: 1, turn: 0, dtMs: 16 });
  const full = at(600).weak;
  const mid = at(800).weak;
  assert.ok(full > 0);
  assert.ok(mid > 0);
  assert.ok(mid < full);
  assert.equal(at(1000).weak, 0);
});

test('an unknown channel is ignored', () => {
  const { mix, at } = mixAt();
  mix.hit('boost', 1);
  assert.deepEqual(at(0), { strong: 0, weak: 0 });
});

test('a zero-magnitude hit is ignored', () => {
  const { mix, at } = mixAt();
  mix.hit('impact', 0);
  assert.deepEqual(at(0), { strong: 0, weak: 0 });
});

test('the envelope holds to the last millisecond and ends exactly at zero', () => {
  const { mix, at } = mixAt();
  mix.hit('impact', 0.8);
  assert.equal(at(60).strong, 0.8);
  assert.ok(at(100).strong < 0.8);
  assert.ok(at(270).strong > 0);
  assert.equal(at(280).strong, 0);
});

test('a clock that goes backwards holds instead of producing nonsense', () => {
  const { mix, at } = mixAt();
  mix.hit('impact', 0.8);
  assert.ok(at(200).strong < 0.8);
  const back = at(50);
  assert.equal(back.strong, 0.8);
  assert.ok(Number.isFinite(back.weak));
});

test('tick with no argument reads the injected clock', () => {
  let t = 0;
  const mix = createHapticsMix({ now: () => t });
  mix.setSettings(ON);
  mix.hit('impact', 0.8);
  t = 50;
  assert.equal(mix.tick().strong, 0.8);
});

test('silence clears the duck as well as the hits', () => {
  const { mix, at } = mixAt();
  mix.drive({ drive: 1, turn: 0, dtMs: 16 });
  mix.hit('impact', 1);
  assert.equal(at(0).weak, 0);
  mix.silence();
  mix.drive({ drive: 1, turn: 0, dtMs: 16 });
  assert.ok(at(1).weak > 0);
});
