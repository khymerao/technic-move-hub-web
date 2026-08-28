// styles.css sets geometry once, globally, and every dense row restates the two
// globals it has to escape: button's 44px min-height and its 1px border (see
// `.macro-bar button` and `.macro-bar label`). A list of 35 rows that forgets is
// 35 tap targets tall inside a 40vh box, each one a bordered card.
//
// There is no build step and no DOM here, so these read the stylesheet as text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Every rule as { selectors, body }. Nested at-rules leave a block whose
// selector list is the at-rule itself, which matches none of the names below.
function rules() {
  const out = [];
  for (const chunk of css.split('}')) {
    const at = chunk.indexOf('{');
    if (at === -1) continue;
    out.push({
      selectors: chunk.slice(0, at).split(',').map((s) => s.trim()).filter(Boolean),
      body: chunk.slice(at + 1),
    });
  }
  return out;
}

const bodyFor = (selector) => {
  const hits = rules().filter((r) => r.selectors.includes(selector));
  assert.ok(hits.length, `styles.css has no rule for \`${selector}\``);
  return hits.map((r) => r.body).join('\n');
};

test('the stylesheet parses into rules, so a passing result means something', () => {
  const found = rules();
  assert.ok(found.length > 50, `expected the whole stylesheet, found ${found.length} rules`);
  assert.ok(found.some((r) => r.selectors.includes('button')), 'sanity: the button rule is there');
});

test('a method row escapes the global button geometry', () => {
  const body = bodyFor('.macro-method');
  assert.match(body, /min-height:\s*0\s*;/,
    'without this every row is var(--tap) tall: 35 rows inside a 40vh box');
  assert.match(body, /border:\s*(0|none)\s*;/,
    'without this every row is a bordered box rather than a line in a list');
});

test('a method signature wraps, so the row list never scrolls sideways', () => {
  assert.match(bodyFor('.macro-method code'), /overflow-wrap:\s*anywhere/,
    'the list already scrolls vertically, which makes its overflow-x compute to auto');
});

test('the search field is styled by the app, not left to the browser', () => {
  const styled = rules()
    .filter((r) => r.selectors.includes('input[type="search"]') || r.selectors.includes('#macro-search'))
    .map((r) => r.body)
    .join('\n');
  assert.match(styled, /border:\s*1px solid var\(--line\)/,
    'type="search" is not covered by the text/number/select rule unless it is named');
  assert.match(styled, /appearance:\s*none/,
    'Safari draws a rounded native search field regardless of the border');
});

// The list is a column flex container. A flex item defaults to flex-shrink: 1,
// so once the rows exceed the list's max-height the browser squashes each one
// to a fraction of its content height and the text spills over its neighbours
// — a rendered-geometry bug that computed styles and behaviour tests both miss.
test('a method row is not shrunk by the column flex list', () => {
  const row = rules().filter((r) => r.selectors.includes('.macro-method')).map((r) => r.body).join('\n');
  assert.match(row, /flex-shrink:\s*0/,
    'without this the rows collapse to ~10px and their text overlaps');
});

// A sticky heading with `z-index: auto` is painted in document order, so every
// row after it draws on top: the signature vanishes behind the heading's fill
// while the badge and the hint print over the heading's letters. Another
// rendered-geometry bug that computed styles and behaviour tests both miss.
test('a sticky group heading is painted above the rows that scroll under it', () => {
  const body = bodyFor('.macro-group');
  assert.match(body, /position:\s*sticky/, 'the heading is meant to stick');
  assert.match(body, /background:\s*var\(--paper\)/,
    'a transparent heading shows the rows through its own letters');
  assert.match(body, /z-index:\s*[1-9]/,
    'without this the rows paint over the heading they scroll under');
});
