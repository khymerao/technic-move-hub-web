// The highlight overlay is a second element painted under a transparent
// textarea, so the two have to agree about content and scroll on every frame.
// The highlighter itself is injected: these tests are about the sync, not
// about anyone's grammar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHighlighter } from '../src/ui/code-editor.js';

class El {
  constructor(props = {}) {
    this.value = ''; this.textContent = ''; this.innerHTML = '';
    this.scrollTop = 0; this.scrollLeft = 0;
    this._events = new Map();
    Object.assign(this, props);
  }
  addEventListener(type, fn) {
    if (!this._events.has(type)) this._events.set(type, []);
    this._events.get(type).push(fn);
  }
  fire(type) { for (const fn of this._events.get(type) ?? []) fn({ target: this }); }
}

const rig = (over = {}) => {
  const textarea = new El();
  const output = new El();
  const calls = [];
  const h = createHighlighter({
    textarea, output,
    highlight: (code) => { calls.push(code); return `<b>${code}</b>`; },
    ...over,
  });
  return { textarea, output, calls, h };
};

test('painting puts the highlighted source into the output', () => {
  const { textarea, output, h } = rig();
  textarea.value = 'await drive(40, 0);';
  h.paint();
  assert.equal(output.innerHTML, '<b>await drive(40, 0);</b>');
});

test('typing repaints', () => {
  const { textarea, output, h } = rig();
  h.attach();
  textarea.value = 'await wait(500);';
  textarea.fire('input');
  assert.equal(output.innerHTML, '<b>await wait(500);</b>');
});

test('a value ending in a newline is padded, or the last line has no height', () => {
  const { textarea, calls, h } = rig();
  textarea.value = 'await stopDrive();\n';
  h.paint();
  assert.equal(calls[0], 'await stopDrive();\n ');
});

test('a value not ending in a newline is passed through untouched', () => {
  const { textarea, calls, h } = rig();
  textarea.value = 'await stopDrive();';
  h.paint();
  assert.equal(calls[0], 'await stopDrive();');
});

test('an empty editor paints nothing rather than a stray highlight', () => {
  const { textarea, output, h } = rig();
  textarea.value = '';
  h.paint();
  assert.equal(output.innerHTML, '');
});

test('scrolling the textarea scrolls the overlay with it, both axes', () => {
  const { textarea, output, h } = rig();
  h.attach();
  textarea.scrollTop = 120;
  textarea.scrollLeft = 8;
  textarea.fire('scroll');
  assert.equal(output.scrollTop, 120);
  assert.equal(output.scrollLeft, 8);
});

// The element the colours are written into has to be the element that scrolls.
// Painting into a child and scrolling it moves nothing: the box with the
// overflow is the parent, and the overlay stands still while the text runs on.
test('the painted element is the one that scrolls', () => {
  const { textarea, output, h } = rig();
  h.attach();
  textarea.value = 'a\n'.repeat(80);
  h.paint();
  const painted = output.innerHTML;
  textarea.scrollTop = 240;
  textarea.fire('scroll');
  assert.equal(output.scrollTop, 240, 'the scrolled element is not the painted one');
  assert.ok(painted.length > 0);
});

test('a highlighter that throws leaves the editor usable and stops repainting', () => {
  const { textarea, output, h } = rig({
    highlight: () => { throw new Error('grammar exploded'); },
  });
  h.attach();
  textarea.value = 'await drive(40, 0);';
  textarea.fire('input');
  assert.equal(output.innerHTML, '');
  assert.equal(h.live, false);
  textarea.value = 'more typing';
  textarea.fire('input');
  assert.equal(output.innerHTML, '');
});

test('detaching stops the repaint and clears what was painted', () => {
  const { textarea, output, h } = rig();
  h.attach();
  textarea.value = 'await drive(40, 0);';
  textarea.fire('input');
  assert.notEqual(output.innerHTML, '');
  h.detach();
  textarea.value = 'await wait(10);';
  textarea.fire('input');
  assert.equal(output.innerHTML, '');
});

test('attaching twice does not double-paint or double-bind', () => {
  const { textarea, calls, h } = rig();
  h.attach();
  h.attach();
  textarea.value = 'await drive(1, 0);';
  textarea.fire('input');
  assert.equal(calls.length, 1);
});
