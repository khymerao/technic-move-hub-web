// The macro editor's command palette: search, and one click to insert a
// runnable call at the caret.
//
// The unsafe rows are shown only while the editor's unsafe checkbox is ticked.
// The checkbox is read at render time; this module keeps no copy of it.
// See docs/DESIGN-NOTES.md § The panel reads state it does not own
// See docs/DESIGN-NOTES.md § The macro palette is grouped, and sits beside the editor

import { $ } from './dom.js';
import { DOCS, GROUPS } from '../macro/api-docs.js';
import { pathOf, isUnsafe } from '../macro/api-spec.js';

export function initMacroHelp({ source, unsafeBox, onInsert }) {
  const listHost = $('macro-method-list');
  const search = $('macro-search');
  const hiddenOut = $('macro-hidden');

  // A call is a statement, so it lands on a line of its own. Splicing it at the
  // caret put `await wait(500);` in the middle of the line the caret happened
  // to be on, and the first thing every insert needed was a hand-made newline.
  function insert(snippet) {
    const value = source.value ?? '';
    const at = source.selectionStart ?? value.length;
    const to = source.selectionEnd ?? at;
    const before = value.slice(0, at);
    const after = value.slice(to);
    const lead = before === '' || before.endsWith('\n') ? '' : '\n';
    const trail = after.startsWith('\n') || after === '' ? '\n' : '\n';
    const text = lead + snippet + trail;
    source.value = before + text + after;
    const caret = at + text.length;
    source.selectionStart = caret;
    source.selectionEnd = caret;
    // Focus otherwise stays on the row button, where Space re-fires it.
    source.focus?.();
    onInsert?.();
  }

  function matches(name, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return name.toLowerCase().includes(q) || DOCS[name].hint.toLowerCase().includes(q);
  }

  function row(name) {
    const d = DOCS[name];
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'macro-method';
    node.dataset.method = name;
    node.title = `insert ${d.snippet}`;

    const sig = document.createElement('code');
    sig.textContent = d.sig;
    node.append(sig);

    // An unsafe method carries path 'any'.
    const path = isUnsafe(name) ? 'unsafe' : pathOf(name);
    if (path !== 'any') {
      const badge = document.createElement('span');
      badge.className = isUnsafe(name) ? 'macro-path macro-danger' : 'macro-path';
      badge.textContent = path;
      node.append(badge);
    }

    const hint = document.createElement('span');
    hint.className = 'macro-hint';
    hint.textContent = d.hint;
    node.append(hint);

    node.addEventListener('click', () => insert(d.snippet));
    return node;
  }

  function heading(text) {
    const h = document.createElement('p');
    h.className = 'lights-head macro-group';
    h.textContent = text;
    return h;
  }

  function render() {
    const allowUnsafe = unsafeBox.checked === true;
    const query = search.value ?? '';
    const shown = [];
    let hidden = 0;
    for (const group of GROUPS) {
      const rows = [];
      for (const name of group.methods) {
        // Counted only when the query would have shown it: ticking unsafe adds
        // nothing the search excludes.
        if (!allowUnsafe && isUnsafe(name)) { if (matches(name, query)) hidden++; continue; }
        if (!matches(name, query)) continue;
        rows.push(row(name));
      }
      // A heading with nothing under it is a heading for the search's benefit
      // and nobody else's.
      if (!rows.length) continue;
      shown.push(heading(group.label), ...rows);
    }
    listHost.replaceChildren(...shown);
    hiddenOut.textContent = hidden
      ? `${hidden} unsafe ${hidden === 1 ? 'method' : 'methods'} hidden — tick unsafe to show them`
      : '';
  }

  search.addEventListener('input', render);
  unsafeBox.addEventListener('change', render);

  return { render };
}
