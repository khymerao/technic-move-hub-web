import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API, METHOD_NAMES, isUnsafe, pathOf } from '../src/macro/api-spec.js';

test('every unsafe method is named under the unsafe prefix, and vice versa', () => {
  for (const [name, def] of Object.entries(API)) {
    assert.equal(def.unsafe, name.startsWith('unsafe.'), `${name} disagrees with its prefix`);
  }
});

test('the PlayVM family and the raw family are disjoint', () => {
  const playvm = METHOD_NAMES.filter((n) => pathOf(n) === 'playvm');
  const raw = METHOD_NAMES.filter((n) => pathOf(n) === 'raw');
  assert.deepEqual(playvm.filter((n) => raw.includes(n)), []);
  assert.ok(playvm.includes('drive'));
  assert.ok(raw.includes('motorFor'));
});

test('there is no open-ended raw motion method', () => {
  for (const name of ['motor', 'throttle', 'tank']) {
    assert.equal(API[name], undefined, `${name} would be open-ended raw motion`);
  }
});

test('invert and resetEncoder are not in the API', () => {
  assert.equal(API.invert, undefined);
  assert.equal(API.resetEncoder, undefined);
});

test('isUnsafe', () => {
  assert.equal(isUnsafe('unsafe.raw'), true);
  assert.equal(isUnsafe('drive'), false);
});

test('every motion method belongs to a drive path', () => {
  for (const [name, def] of Object.entries(API)) {
    if (def.motion) assert.notEqual(def.path, 'any', `${name} is motion with no path`);
  }
});
