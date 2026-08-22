import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCS, EXAMPLES } from '../src/macro/api-docs.js';
import { METHOD_NAMES } from '../src/macro/api-spec.js';

test('every method has an entry, and every entry is a method', () => {
  assert.deepEqual(Object.keys(DOCS).sort(), [...METHOD_NAMES].sort());
});

test('every entry has a signature, a hint and a snippet', () => {
  for (const [name, d] of Object.entries(DOCS)) {
    assert.ok(d.sig?.length, `${name} has no sig`);
    assert.ok(d.hint?.length, `${name} has no hint`);
    assert.ok(d.snippet?.length, `${name} has no snippet`);
  }
});

test('every snippet is awaited', () => {
  for (const [name, d] of Object.entries(DOCS)) {
    assert.ok(d.snippet.startsWith('await '),
      `${name}'s snippet must start with await — an un-awaited refusal is swallowed`);
  }
});

test('every snippet parses as JavaScript', () => {
  for (const [name, d] of Object.entries(DOCS)) {
    assert.doesNotThrow(() => new Function(`async () => { ${d.snippet} }`),
      `${name}'s snippet does not parse`);
  }
});

test('every signature names the method it belongs to', () => {
  for (const [name, d] of Object.entries(DOCS)) {
    assert.ok(d.sig.startsWith(name + '('), `${name}'s sig is ${d.sig}`);
  }
});

test('examples have a name and a source, and parse', () => {
  assert.ok(EXAMPLES.length >= 3);
  for (const e of EXAMPLES) {
    assert.ok(e.name?.length, 'an example has no name');
    assert.ok(e.source?.length, `${e.name} has no source`);
    assert.doesNotThrow(() => new Function(`async () => { ${e.source} }`),
      `${e.name} does not parse`);
  }
});

test('examples call only methods that exist', () => {
  const known = new Set(METHOD_NAMES);
  for (const e of EXAMPLES) {
    for (const [, called] of e.source.matchAll(/\bawait\s+([a-zA-Z][\w.]*)\s*\(/g)) {
      assert.ok(known.has(called), `${e.name} calls ${called}, which is not in the API`);
    }
  }
});

// A hint renders on one row beside the signature. Past roughly this length it
// wraps to a second line on a phone and the list stops being scannable.
test('hints stay short enough to sit beside the signature', () => {
  for (const [name, d] of Object.entries(DOCS)) {
    assert.ok(d.hint.length <= 72, `${name}'s hint is ${d.hint.length} chars: ${d.hint}`);
  }
});

// The delta-gated streams report nothing while their value is steady, so a
// read on a stationary car times out. Saying so is the difference between a
// confusing failure and an expected one.
test('the delta-gated sensor hints say the reading may never arrive', () => {
  for (const name of ['tilt', 'accel', 'motorSpeed', 'motorPos']) {
    assert.match(DOCS[name].hint, /never|silent/,
      `${name} times out on a still car and its hint does not say so`);
  }
});

// waitFor('collision') is refused outright while the collision mode is the
// default 'abort', so the snippet alone always throws.
test("waitFor's hint names the call that makes it work", () => {
  assert.match(DOCS.waitFor.hint, /collision\(/);
});
