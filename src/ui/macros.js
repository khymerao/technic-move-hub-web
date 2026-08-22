// The Macros tab: an editor over named slots in localStorage, and the
// controls to run one against hub.macro.
//
// See docs/superpowers/specs/2026-07-28-macro-system-design.md

import { $ } from './dom.js';
import { initMacroHelp } from './macro-help.js';
import { createMacroStore } from '../macro/store.js';
import { SOURCE_LINE_OFFSET } from '../macro/rpc.js';

const AUTOSAVE_DEBOUNCE_MS = 400;
const ELAPSED_TICK_MS = 100;

const formatElapsed = (ms) => (ms / 1000).toFixed(1) + 's';

// A runtime error's stack carries a frame in the eval'd source, reported as
// "<anonymous>:LINE:COL". A host-side refusal (unsafe, bad duration, …) is
// constructed away from that frame and carries no such line.
function lineFromStack(stack) {
  const m = /<anonymous>:(\d+):\d+/.exec(stack ?? '');
  if (!m) return null;
  const line = Number(m[1]) - SOURCE_LINE_OFFSET;
  return line > 0 ? line : null;
}

function formatFailure(detail) {
  const message = detail?.message ?? detail?.name ?? 'unknown error';
  const line = lineFromStack(detail?.stack);
  return line ? `error at line ${line}: ${message}` : `error: ${message}`;
}

// Only a clean finish reads as plain `idle`; anything else names what ended
// the run — a collision, a dying link, a disconnect. The host appends
// ` — drive mode left as …` to either form when the run changed the mode.
function formatEnd(reason) {
  if (!reason || reason === 'finished') return 'idle';
  const text = String(reason);
  if (text.startsWith('finished —')) return `idle${text.slice('finished'.length)}`;
  return `stopped: ${text}`;
}

export function initMacroPanel(hub) {
  const select = $('macro-select');
  const newBtn = $('macro-new');
  const deleteBtn = $('macro-delete');
  const source = $('macro-source');
  const runBtn = $('macro-run');
  const stopBtn = $('macro-stop');
  const unsafeBox = $('macro-unsafe');
  const elapsedOut = $('macro-elapsed');
  const statusEl = $('macro-status');
  const exportBtn = $('macro-export');
  const importBtn = $('macro-import');
  const importFile = $('macro-import-file');

  const store = createMacroStore(localStorage);

  let currentId = null;
  let autosaveTimer = 0;
  let running = false;
  let startedAt = 0;
  let lastResult = null; // the last run's formatted result, read by the following 'idle'

  function paintButtons() {
    runBtn.disabled = !hub.macro || running;
    stopBtn.disabled = !running;
    deleteBtn.disabled = !currentId;
  }

  function currentMacro() {
    return store.list().find((m) => m.id === currentId) ?? null;
  }

  function renderSelect() {
    const macros = [...store.list()].sort((a, b) => a.name.localeCompare(b.name));
    select.replaceChildren();
    for (const m of macros) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      select.append(opt);
    }
    if (currentId && macros.some((m) => m.id === currentId)) select.value = currentId;
    else currentId = macros[0]?.id ?? null;
    if (currentId) select.value = currentId;
  }

  let help = null;

  function loadCurrent() {
    const m = currentMacro();
    source.value = m?.source ?? '';
    // Reflects store.js's stored flag; an import already forces it to false
    // regardless of the file's claim.
    unsafeBox.checked = m?.allowUnsafe === true;
    paintButtons();
    help?.render();   // the checkbox moved without firing `change`
  }

  function persist() {
    if (!currentId) return;
    const existing = currentMacro();
    store.save({
      id: currentId,
      name: existing?.name ?? 'untitled',
      source: source.value,
      allowUnsafe: unsafeBox.checked,
      updatedAt: Date.now(),
    });
  }

  function scheduleAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => { autosaveTimer = 0; persist(); }, AUTOSAVE_DEBOUNCE_MS);
  }

  // Anything that changes which slot the editor shows writes the pending edit
  // out first: the debounced timer would otherwise fire against the new slot.
  function flushAutosave() {
    if (!autosaveTimer) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = 0;
    persist();
  }

  select.addEventListener('change', () => {
    flushAutosave();
    currentId = select.value;
    loadCurrent();
  });

  newBtn.addEventListener('click', () => {
    flushAutosave();
    const saved = store.save({
      name: `macro ${store.list().length + 1}`, source: '', allowUnsafe: false, updatedAt: Date.now(),
    });
    currentId = saved.id;
    renderSelect();
    loadCurrent();
  });

  deleteBtn.addEventListener('click', () => {
    if (!currentId) return;
    store.remove(currentId);
    currentId = null;
    renderSelect();
    loadCurrent();
  });

  source.addEventListener('input', scheduleAutosave);
  unsafeBox.addEventListener('change', persist);

  runBtn.addEventListener('click', () => {
    if (!hub.macro) return;
    flushAutosave();
    persist();
    lastResult = null;
    statusEl.textContent = 'starting…';
    // run() rejects on "already running" and on anything spawnWorker throws —
    // a blocked module worker, a CSP failure.
    hub.macro.run(source.value, { allowUnsafe: unsafeBox.checked })
      .catch((err) => { statusEl.textContent = `error: ${err?.message ?? err}`; });
  });

  // The reason is rendered as `stopped: …`, so it reads as the cause, not a sentence.
  stopBtn.addEventListener('click', () => { hub.macro?.abort('by the Stop button'); });

  exportBtn.addEventListener('click', () => {
    const blob = new Blob([store.exportAll()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lego-macros.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (!file) return;
    flushAutosave();
    try {
      const incoming = store.importFrom(await file.text());
      if (incoming.length) currentId = incoming[0].id;
      renderSelect();
      loadCurrent();
      statusEl.textContent = `imported ${incoming.length} macro(s)`;
    } catch (err) {
      statusEl.textContent = `import failed: ${err.message}`;
    }
  });

  // One persistent tick, matching initTelemetryPanel's queue-depth interval;
  // a no-op while no run is live.
  setInterval(() => { if (running) showElapsed(Date.now() - startedAt); }, ELAPSED_TICK_MS);

  function showElapsed(ms) { elapsedOut.textContent = formatElapsed(ms); }

  // A macro's own print() output — the status line's other tenant, alongside
  // the run-state text showState writes.
  function showPrint(args) { statusEl.textContent = args.map(String).join(' '); }

  // The host's word on what a call is doing mid-run — an arming switch. Shares
  // the status line with showPrint and showState; the run stays `running`.
  function showNotice(text) { statusEl.textContent = text; }

  function showState(state, detail) {
    running = state === 'arming' || state === 'running' || state === 'stopping';
    paintButtons();

    if (state === 'arming') { lastResult = null; startedAt = Date.now(); showElapsed(0); }
    if (state === 'running') statusEl.textContent = 'running';
    if (state === 'stopping') statusEl.textContent = 'stopping…';
    if (state === 'failed') lastResult = formatFailure(detail);
    if (state === 'idle') statusEl.textContent = lastResult ?? formatEnd(detail);
  }

  renderSelect();
  loadCurrent();
  paintButtons();

  // store.save() throws when localStorage is full; this origin's quota is
  // shared with the gamepad mapping.
  help = initMacroHelp({
    source, unsafeBox,
    onInsert: scheduleAutosave,
    onExample: (name, src) => {
      try {
        flushAutosave();
        const saved = store.save({ name, source: src, allowUnsafe: false, updatedAt: Date.now() });
        currentId = saved.id;
        renderSelect();
        loadCurrent();
      } catch (err) {
        statusEl.textContent = `could not save: ${err.message}`;
      }
    },
  });
  help.render();

  return { showState, showElapsed, showPrint, showNotice };
}
