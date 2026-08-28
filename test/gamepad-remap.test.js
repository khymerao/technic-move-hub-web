import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLayout, controlsFor, controlById, ART, LAYOUTS } from '../src/gamepad-layout.js';
import {
  DEFAULT_MAP, ACTIONS, DRIVE_MODES,
  assignable, bindingsOf, assignControl, unassign, clearControl, resolveActions,
  modifiersOf, setModifier,
} from '../src/gamepad-map.js';

const pad = (over = {}) => ({
  axes: over.axes ?? [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, (_, i) => ({
    value: over.buttons?.[i] ?? 0,
    pressed: (over.buttons?.[i] ?? 0) > 0.5,
  })),
});

test('detectLayout: PlayStation pads by vendor id and by name', () => {
  assert.equal(detectLayout('054c-0ce6-Wireless Controller'), 'playstation');
  assert.equal(detectLayout('DualSense Wireless Controller (STANDARD GAMEPAD)'), 'playstation');
  assert.equal(detectLayout('Sony DualShock 4'), 'playstation');
});

test('detectLayout: Xbox pads by vendor id and by name', () => {
  assert.equal(detectLayout('045e-02fd-Xbox Wireless Controller'), 'xbox');
  assert.equal(detectLayout('XInput STANDARD GAMEPAD'), 'xbox');
});

// The standard mapping was written against the Xbox shape, so an unknown pad
// gets the picture its indices agree with rather than a guess.
test('detectLayout: anything unrecognised falls back to the Xbox drawing', () => {
  assert.equal(detectLayout('8BitDo Pro 2'), 'xbox');
  assert.equal(detectLayout(''), 'xbox');
  assert.equal(detectLayout(), 'xbox');
});

test('every layout describes the same controls, and every control exactly once', () => {
  const ids = controlsFor('xbox').map((c) => c.id);
  for (const layout of LAYOUTS) {
    const controls = controlsFor(layout);
    assert.deepEqual(controls.map((c) => c.id), ids, `${layout} covers the same controls`);
    const seen = new Set();
    for (const c of controls) {
      const key = `${c.source.type}:${c.source.index}`;
      assert.ok(!seen.has(key), `${layout} ${c.id} does not share a source`);
      seen.add(key);
      assert.ok(c.chip && c.name && c.group, `${layout} ${c.id} is labelled`);
      assert.ok(c.x > 0 && c.x < ART[layout].w, `${layout} ${c.id} lands inside the drawing`);
      assert.ok(c.y > 0 && c.y < ART[layout].h, `${layout} ${c.id} lands inside the drawing`);
    }
  }
});

test('the chips are the lettering on the plastic, not one alphabet for both', () => {
  assert.equal(controlById('xbox', 'a').chip, 'A');
  assert.equal(controlById('playstation', 'a').chip, '✕');
  assert.equal(controlById('xbox', 'lb').chip, 'LB');
  assert.equal(controlById('playstation', 'lb').chip, 'L1');
  // Same index underneath, whatever it is called.
  assert.deepEqual(controlById('xbox', 'a').source, controlById('playstation', 'a').source);
});

test('every action is assignable, and every pair as two halves', () => {
  const entries = assignable();
  for (const a of ACTIONS) {
    const mine = entries.filter((e) => e.actionId === a.id);
    assert.equal(mine.length, a.kind === 'pair' ? 2 : 1, `${a.id} is offered`);
    for (const e of mine) assert.ok(e.label && e.group && e.modes.length, `${a.id} is described`);
  }
  const keys = entries.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
  assert.ok(keys.includes('throttle:pos') && keys.includes('throttle:neg'));
});

test('every action declares drive modes that exist', () => {
  for (const a of ACTIONS) {
    for (const m of a.modes) assert.ok(DRIVE_MODES.includes(m), `${a.id} -> ${m}`);
  }
});

test('bindingsOf reads the default map backwards', () => {
  const keys = (id) => bindingsOf(DEFAULT_MAP, controlById('xbox', id)).map((b) => b.key);
  assert.deepEqual(keys('a'), ['brake']);
  assert.deepEqual(keys('lb'), ['trimLeft']);
  assert.deepEqual(keys('rb'), ['trimRight']);
  assert.deepEqual(keys('l3'), ['lamp5']);
  // The sticks carry the wheeled action and its tracked-mode counterpart: one
  // axis, two modes, never both live at once.
  assert.deepEqual(keys('lx').sort(), ['steer', 'tankTurn']);
  assert.deepEqual(keys('ly'), ['tankThrottle']);
  // The triggers carry the throttle, one half each.
  assert.deepEqual(keys('rt'), ['throttle:pos']);
  assert.deepEqual(keys('lt'), ['throttle:neg']);
});

// Steer and tank turn share axis 0 on purpose — different drive modes, so the
// axis is spent once. A panel that showed one of them would erase the other.
test('a shared axis reports every action reading it', () => {
  const lx = controlById('xbox', 'lx');
  assert.deepEqual(
    bindingsOf(DEFAULT_MAP, lx).map((b) => b.key).sort(),
    ['steer', 'tankTurn'],
  );
});

test('assignControl moves an action off whatever held it', () => {
  const y = controlById('xbox', 'y');
  const a = controlById('xbox', 'a');
  const map = assignControl(DEFAULT_MAP, y, 'brake');
  assert.deepEqual(bindingsOf(map, y).map((b) => b.key).sort(), ['brake', 'ledCycle']);
  assert.deepEqual(bindingsOf(map, a), [], 'A gave the brake up');
  assert.deepEqual(DEFAULT_MAP.brake, { type: 'button', index: 0 }, 'the source map is untouched');
});

// An action lives on one control; a control may carry several. Adding one is
// not a reason to throw away what the control already did.
test('assignControl adds to a control without emptying it', () => {
  const a = controlById('xbox', 'a');
  const map = assignControl(DEFAULT_MAP, a, 'lamp5');
  assert.deepEqual(
    bindingsOf(map, a).map((b) => b.key).sort(),
    ['brake', 'lamp5'],
  );
});

test('unassign takes one action off and leaves the rest', () => {
  const lx = controlById('xbox', 'lx');
  const map = unassign(DEFAULT_MAP, 'tankTurn');
  assert.deepEqual(bindingsOf(map, lx).map((b) => b.key), ['steer']);
  assert.equal(map.tankTurn, null);
});

test('assignControl carries the stick inversion the reader has no policy for', () => {
  const ly = controlById('xbox', 'ly');
  const map = assignControl(DEFAULT_MAP, ly, 'throttle:pos');
  assert.deepEqual(map.throttle.pos, { type: 'axis', index: 1, invert: true });
  // Up is forward, which is the whole point of the inversion.
  assert.equal(resolveActions(pad({ axes: [0, -1, 0, 0] }), map).throttle, 1);
});

test('a pair half binds alone and leaves the other half where it was', () => {
  const x = controlById('xbox', 'x');
  const map = assignControl(DEFAULT_MAP, x, 'throttle:neg');
  assert.deepEqual(map.throttle.neg, { type: 'button', index: 2 });
  assert.deepEqual(map.throttle.pos, { type: 'button', index: 7 }, 'forward is still RT');
  assert.equal(resolveActions(pad({ buttons: { 2: 1 } }), map).throttle, -1);
});

test('clearControl frees the control and nothing else', () => {
  const rt = controlById('xbox', 'rt');
  const map = clearControl(DEFAULT_MAP, rt);
  assert.deepEqual(bindingsOf(map, rt), []);
  assert.equal(map.throttle.pos, null);
  assert.deepEqual(map.throttle.neg, { type: 'button', index: 6 }, 'reverse survives on LT');
});

// A pair with both halves gone is null, not { pos: null, neg: null } — the
// resolver reads either the same, but a stored husk would show up as a binding.
test('clearing both halves of a pair leaves no husk behind', () => {
  let map = clearControl(DEFAULT_MAP, controlById('xbox', 'rt'));
  map = clearControl(map, controlById('xbox', 'lt'));
  assert.equal(map.throttle, null);
  assert.equal(resolveActions(pad({ buttons: { 6: 1, 7: 1 } }), map).throttle, 0);
});

test('a map the panel wrote still resolves on the hot path', () => {
  const controls = controlsFor('playstation');
  let map = assignControl(DEFAULT_MAP, controls.find((c) => c.id === 'rt'), 'lamp5');
  map = assignControl(map, controls.find((c) => c.id === 'rx'), 'tankSteer');
  const out = resolveActions(pad({ axes: [0, 0, 0.5, 0], buttons: { 7: 1 } }), map);
  assert.equal(out.lamp5, true);
  assert.equal(out.tankSteer, 0.5);
});

// Modifiers: a held button gives every other control a second binding.
// See docs/DESIGN-NOTES.md § A modifier is a held button, not a mode
test('a modifier is a button, and turning it on empties that button', () => {
  const lb = controlById('xbox', 'lb');
  const map = setModifier(DEFAULT_MAP, lb, true);
  assert.deepEqual(modifiersOf(map), [4]);
  assert.deepEqual(bindingsOf(map, lb), [], 'a shift key commands nothing itself');
  assert.equal(map.trimLeft, null);
  assert.deepEqual(map.trimRight, { type: 'button', index: 5 }, 'the other trim is untouched');
});

test('an axis cannot be a modifier', () => {
  const map = setModifier(DEFAULT_MAP, controlById('xbox', 'lx'), true);
  assert.deepEqual(modifiersOf(map), []);
});

test('a modified binding only reads while its modifier is held', () => {
  const lb = controlById('xbox', 'lb');
  let map = setModifier(DEFAULT_MAP, lb, true);
  map = assignControl(map, controlById('xbox', 'a'), 'lamp5', 4);
  assert.equal(resolveActions(pad({ buttons: { 0: 1 } }), map).lamp5, false, 'A alone does not');
  assert.equal(resolveActions(pad({ buttons: { 0: 1, 4: 1 } }), map).lamp5, true, 'LB + A does');
});

test('the modified binding displaces the plain one on the same control', () => {
  const lb = controlById('xbox', 'lb');
  let map = setModifier(DEFAULT_MAP, lb, true);
  map = assignControl(map, controlById('xbox', 'a'), 'lamp5', 4);
  const both = resolveActions(pad({ buttons: { 0: 1, 4: 1 } }), map);
  assert.equal(both.lamp5, true);
  assert.equal(both.brake, false, 'A does not brake and light a lamp at once');
  assert.equal(resolveActions(pad({ buttons: { 0: 1 } }), map).brake, true, 'unheld, A brakes');
});

test('a held modifier commands nothing itself, and controls with no layer keep working', () => {
  const map = setModifier(DEFAULT_MAP, controlById('xbox', 'rb'), true);
  const out = resolveActions(pad({ buttons: { 5: 1, 3: 1 } }), map);
  assert.equal(out.trimRight, false, 'RB is the shift key now');
  assert.equal(out.ledCycle, true, 'Y is untouched by a layer it has nothing in');
});

test('a modifier and its plain layer keep their own axes apart', () => {
  const lb = controlById('xbox', 'lb');
  let map = setModifier(DEFAULT_MAP, lb, true);
  map = assignControl(map, controlById('xbox', 'lx'), 'tankSteer', 4);
  const held = resolveActions(pad({ axes: [0.5, 0, 0, 0], buttons: { 4: 1 } }), map);
  assert.equal(held.tankSteer, 0.5);
  assert.equal(held.steer, 0, 'steering is displaced while the layer is up');
  const free = resolveActions(pad({ axes: [0.5, 0, 0, 0] }), map);
  assert.equal(free.steer, 0.5);
  assert.equal(free.tankSteer, 0, 'and the layer reads nothing when nothing holds it');
});

test('bindingsOf answers per layer', () => {
  const a = controlById('xbox', 'a');
  let map = setModifier(DEFAULT_MAP, controlById('xbox', 'lb'), true);
  map = assignControl(map, a, 'lamp5', 4);
  assert.deepEqual(bindingsOf(map, a).map((b) => b.key), ['brake']);
  assert.deepEqual(bindingsOf(map, a, 4).map((b) => b.key), ['lamp5']);
});

test('turning a modifier off takes its layer with it', () => {
  const lb = controlById('xbox', 'lb');
  let map = setModifier(DEFAULT_MAP, lb, true);
  map = assignControl(map, controlById('xbox', 'a'), 'lamp5', 4);
  map = setModifier(map, lb, false);
  assert.deepEqual(modifiersOf(map), []);
  assert.equal(map.lamp5, null);
  assert.equal(resolveActions(pad({ buttons: { 0: 1 } }), map).brake, true, 'A is plain again');
});

// A map saved before modifiers existed has no `modifiers` key at all.
test('a map with no modifiers resolves exactly as it always did', () => {
  const g = pad({ axes: [-0.5, 0, 0, 0], buttons: { 0: 1, 7: 1 } });
  const out = resolveActions(g, DEFAULT_MAP);
  assert.equal(out.throttle, 1);
  assert.equal(out.steer, -0.5);
  assert.equal(out.brake, true);
});
