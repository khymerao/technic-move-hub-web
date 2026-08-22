import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMacroStore, MACRO_STORE_KEY } from '../src/macro/store.js';

const fakeStorage = () => {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
};

test('an empty store lists nothing', () => {
  assert.deepEqual(createMacroStore(fakeStorage()).list(), []);
});

test('save then list round-trips', () => {
  const s = createMacroStore(fakeStorage());
  const saved = s.save({ name: 'donut', source: 'await drive(40, 100);' });
  assert.ok(saved.id);
  assert.equal(saved.allowUnsafe, false, 'unsafe is off unless asked for');
  assert.deepEqual(s.list().map((m) => m.name), ['donut']);
});

test('saving with an existing id replaces rather than duplicates', () => {
  const s = createMacroStore(fakeStorage());
  const a = s.save({ name: 'donut', source: 'x' });
  s.save({ ...a, source: 'y' });
  assert.equal(s.list().length, 1);
  assert.equal(s.list()[0].source, 'y');
});

test('a corrupt store reads as empty rather than throwing', () => {
  const storage = fakeStorage();
  storage.setItem(MACRO_STORE_KEY, '{not json');
  assert.deepEqual(createMacroStore(storage).list(), []);
});

test('export then import round-trips', () => {
  const a = createMacroStore(fakeStorage());
  a.save({ name: 'donut', source: 'x' });
  const b = createMacroStore(fakeStorage());
  b.importFrom(a.exportAll());
  assert.deepEqual(b.list().map((m) => m.name), ['donut']);
});

test('an import declaring allowUnsafe lands with it off', () => {
  const s = createMacroStore(fakeStorage());
  s.importFrom(JSON.stringify({
    version: 1,
    macros: [{ id: 'x', name: 'sneaky', source: 'unsafe.raw([1])', allowUnsafe: true }],
  }));
  assert.equal(s.list()[0].allowUnsafe, false,
    'a file must not choose its own privilege level');
});

test('an unrecognised version is refused outright', () => {
  const s = createMacroStore(fakeStorage());
  assert.throws(
    () => s.importFrom(JSON.stringify({ version: 99, macros: [] })),
    /version/i,
  );
  assert.deepEqual(s.list(), [], 'nothing partial was written');
});

test('a malformed import is refused', () => {
  const s = createMacroStore(fakeStorage());
  assert.throws(() => s.importFrom('{not json'), /could not be read/i);
  assert.throws(() => s.importFrom(JSON.stringify({ version: 1 })), /macros/i);
});

test('a storage failure is surfaced, not swallowed', () => {
  const storage = fakeStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const s = createMacroStore(storage);
  assert.throws(() => s.save({ name: 'x', source: 'y' }), /QuotaExceeded/);
});

test('a non-object entry in macros array is refused', () => {
  const s = createMacroStore(fakeStorage());
  // Refuse string entry
  assert.throws(
    () => s.importFrom(JSON.stringify({ version: 1, macros: [{ name: 'ok', source: 'x' }, 'garbage'] })),
    /non-object entry/i,
  );
  assert.deepEqual(s.list(), [], 'nothing partial was written after string refusal');

  // Refuse null entry
  assert.throws(
    () => s.importFrom(JSON.stringify({ version: 1, macros: [{ name: 'ok', source: 'x' }, null] })),
    /non-object entry/i,
  );
  assert.deepEqual(s.list(), [], 'nothing partial was written after null refusal');

  // Refuse array entry
  const jsonWithArray = JSON.parse(JSON.stringify({ version: 1, macros: [{ name: 'ok', source: 'x' }, []] }));
  assert.throws(
    () => s.importFrom(JSON.stringify(jsonWithArray)),
    /non-object entry/i,
  );
  assert.deepEqual(s.list(), [], 'nothing partial was written after array refusal');
});

test('removing a macro by id leaves others', () => {
  const s = createMacroStore(fakeStorage());
  const a = s.save({ name: 'first', source: 'x' });
  const b = s.save({ name: 'second', source: 'y' });
  s.remove(a.id);
  assert.deepEqual(s.list().map((m) => m.name), ['second']);
});

test('importing over a stored macro with allowUnsafe true forces it back to false', () => {
  const s = createMacroStore(fakeStorage());
  s.save({ id: 'x', name: 'trusted', source: 'y', allowUnsafe: true });
  assert.equal(s.list()[0].allowUnsafe, true, 'saved with unsafe on');
  s.importFrom(JSON.stringify({
    version: 1,
    macros: [{ id: 'x', name: 'from-file', source: 'z', allowUnsafe: true }],
  }));
  assert.equal(s.list()[0].allowUnsafe, false, 'import stripped unsafe even over existing unsafe:true');
});

test('a partial object entry (no id, no updatedAt) round-trips with generated id and defaults', () => {
  const s = createMacroStore(fakeStorage());
  s.importFrom(JSON.stringify({
    version: 1,
    macros: [{ name: 'partial', source: 'code' }],
  }));
  assert.equal(s.list().length, 1, 'import succeeded');
  assert.ok(s.list()[0].id, 'id was generated');
  assert.equal(s.list()[0].name, 'partial', 'name preserved');
  assert.equal(s.list()[0].source, 'code', 'source preserved');
  assert.equal(s.list()[0].allowUnsafe, false, 'allowUnsafe defaults to false');
  assert.equal(s.list()[0].updatedAt, 0, 'updatedAt defaults to 0');
});
