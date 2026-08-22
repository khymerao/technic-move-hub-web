// The macro editor's method list: search, and one click to insert a runnable
// call at the caret.
//
// The unsafe rows are shown only while the editor's unsafe checkbox is ticked.
// The checkbox is read at render time; this module keeps no copy of it.
// See docs/DESIGN-NOTES.md § The panel reads state it does not own

import { $ } from './dom.js';
import { DOCS, EXAMPLES } from '../macro/api-docs.js';
import { METHOD_NAMES, pathOf, isUnsafe } from '../macro/api-spec.js';

export function initMacroHelp({ source, unsafeBox, onInsert, onExample }) {
  const listHost = $('macro-method-list');
  const exampleHost = $('macro-examples');
  const search = $('macro-search');
  const hiddenOut = $('macro-hidden');

  function insert(snippet) {
    const at = source.selectionStart ?? source.value.length;
    const to = source.selectionEnd ?? at;
    source.value = source.value.slice(0, at) + snippet + source.value.slice(to);
    const caret = at + snippet.length;
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

  function render() {
    const allowUnsafe = unsafeBox.checked === true;
    const query = search.value ?? '';
    const shown = [];
    let hidden = 0;
    for (const name of METHOD_NAMES) {
      // Counted only when the query would have shown it: ticking unsafe adds
      // nothing the search excludes.
      if (!allowUnsafe && isUnsafe(name)) { if (matches(name, query)) hidden++; continue; }
      if (!matches(name, query)) continue;
      shown.push(row(name));
    }
    listHost.replaceChildren(...shown);
    hiddenOut.textContent = hidden
      ? `${hidden} unsafe ${hidden === 1 ? 'method' : 'methods'} hidden — tick unsafe to show them`
      : '';
  }

  const exampleButtons = EXAMPLES.map((example) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = example.name;
    btn.addEventListener('click', () => onExample(example.name, example.source));
    return btn;
  });
  exampleHost.replaceChildren(...exampleButtons);

  search.addEventListener('input', render);
  unsafeBox.addEventListener('change', render);

  return { render };
}
