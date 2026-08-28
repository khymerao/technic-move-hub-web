// The window `blur` estop decision, extracted so it can be unit-tested without
// booting the composition root. A blur while the loop is armed and focus has
// genuinely left the page routes through emergencyStop; a spurious blur that
// keeps focus (a click within the page) does not, and a blur while nothing is
// running does not.
//
// See docs/DESIGN-NOTES.md § Blur is the focus loss visibilitychange never reports

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blurShouldStop, swallowKey } from '../src/focus-guard.js';

test('an armed loop that loses focus stops', () => {
  assert.equal(blurShouldStop({ running: true, hasFocus: () => false }), true);
});

test('a blur that keeps focus (a click within the page) does not stop', () => {
  assert.equal(blurShouldStop({ running: true, hasFocus: () => true }), false);
});

test('a blur while nothing is running does not stop', () => {
  assert.equal(blurShouldStop({ running: false, hasFocus: () => false }), false);
});

test('an absent hasFocus is treated as focus lost, so an armed loop stops', () => {
  assert.equal(blurShouldStop({ running: true, hasFocus: undefined }), true);
});

// The browser-swallowing decision, same shape and same reason: it has to be
// testable without booting the composition root.

const body = { tagName: 'BODY' };
const field = { tagName: 'TEXTAREA' };

test('an armed loop swallows the keys that would scroll or navigate the page', () => {
  for (const key of [' ', 'Enter', 'Backspace', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(swallowKey({ running: true, key, target: body }), true, key);
  }
});

test('a key nobody asked to swallow passes through', () => {
  assert.equal(swallowKey({ running: true, key: 'q', target: body }), false);
});

test('nothing is swallowed while the loop is not armed', () => {
  assert.equal(swallowKey({ running: false, key: 'Backspace', target: body }), false);
});

test('typing keeps every key, armed or not', () => {
  for (const tagName of ['TEXTAREA', 'INPUT']) {
    assert.equal(swallowKey({ running: true, key: 'Backspace', target: { tagName } }), false, tagName);
    assert.equal(swallowKey({ running: true, key: ' ', target: { tagName } }), false, tagName);
    assert.equal(swallowKey({ running: true, key: 'ArrowLeft', target: { tagName } }), false, tagName);
  }
  assert.equal(swallowKey({ running: true, key: 'Backspace', target: { isContentEditable: true } }), false);
});

test('an absent target is not a text field, so the swallow still applies', () => {
  assert.equal(swallowKey({ running: true, key: 'Backspace', target: null }), true);
});

test('the macro editor keeps Backspace while the pad is armed', () => {
  assert.equal(swallowKey({ running: true, key: 'Backspace', target: field }), false);
});
