// The window `blur` estop decision, extracted so it can be unit-tested without
// booting the composition root. A blur while the loop is armed and focus has
// genuinely left the page routes through emergencyStop; a spurious blur that
// keeps focus (a click within the page) does not, and a blur while nothing is
// running does not.
//
// See docs/DESIGN-NOTES.md § Blur is the focus loss visibilitychange never reports

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blurShouldStop } from '../src/focus-guard.js';

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
