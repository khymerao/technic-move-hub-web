// On-screen debug logger for mobile (no console access on the phone).
// Appends timestamped lines to #log and mirrors to console.

const t0 = performance.now();
const stamp = () => ((performance.now() - t0) / 1000).toFixed(3).padStart(7, ' ');

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function fmt(a) {
  if (a instanceof Uint8Array) return `[${hex(a)}]`;
  if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
  return String(a);
}

// Runs headless too: the same modules are used outside the browser (see mcp/),
// where there is no DOM to append to.
const headless = () => typeof document === 'undefined';
const logNode = () => (headless() ? null : document.getElementById('log'));

// Anything wanting a copy of the log stream registers here (the MCP log buffer).
// The browser panel does not use this; it appends to the DOM.
const sinks = new Set();
export function addLogSink(fn) { sinks.add(fn); return () => sinks.delete(fn); }

// The log is the busiest thing on the page: every frame out and every reply in,
// tens of lines a second while driving. Three properties keep that from eating
// the tab, and all three were learned from a session that reached 829 MB.
//
// Bounded. The panel holds the most recent MAX_LINES and drops the rest. A log
// nobody can scroll through is not more useful for being complete.
//
// Appended, never re-concatenated. `node.textContent += line` reads the whole
// accumulated string back out, allocates a new one and writes it in — quadratic
// in the number of lines. Measured on this page: 20,000 lines took 2.1 seconds
// and 40 MB of heap for 1.1 MB of actual text.
//
// Written once per frame, not once per line. Setting scrollTop forces a
// synchronous layout of the whole <pre>, so doing it per line meant a full
// layout per BLE frame.
const MAX_LINES = 1500;
let queued = [];
let flushHandle = 0;

function flush() {
  flushHandle = 0;
  const node = logNode();
  if (!node) { queued.length = 0; return; }
  for (const line of queued) node.appendChild(document.createTextNode(line + '\n'));
  queued.length = 0;
  while (node.childNodes.length > MAX_LINES) node.removeChild(node.firstChild);
  node.scrollTop = node.scrollHeight;
}

export function log(...args) {
  const line = `${stamp()}  ${args.map(fmt).join(' ')}`;
  // stderr when headless, because stdout is the MCP wire.
  // See docs/DESIGN-NOTES.md § Headless logging goes to stderr
  if (headless()) console.error(line); else console.log(line);
  // A broken sink must not take the logger down with it.
  for (const sink of sinks) { try { sink(line); } catch { /* ignore */ } }
  if (headless()) return;
  queued.push(line);
  // The queue needs the same ceiling as the panel, and for a sharper reason:
  // requestAnimationFrame does not run in a background tab, so a phone with the
  // page behind another app would accumulate here forever. Capping the panel
  // and leaving the queue unbounded just moves the leak.
  if (queued.length > MAX_LINES) queued.splice(0, queued.length - MAX_LINES);
  // rAF rather than a timer: it does not run while the tab is hidden, which is
  // exactly when nobody is reading the log. A DOM without it is a test stub,
  // and there the write may as well happen now.
  if (typeof requestAnimationFrame !== 'function') { flush(); return; }
  if (!flushHandle) flushHandle = requestAnimationFrame(flush);
}

// Remote log streaming used to live here; it is preserved at the rig/debug-tools tag.
// See docs/DESIGN-NOTES.md § Remote log streaming was removed, not lost

// Wire copy/clear buttons and catch uncaught errors. Call once at startup.
export function initDebugPanel() {
  document.getElementById('log-copy')?.addEventListener('click', async () => {
    const text = document.getElementById('log')?.textContent ?? '';
    try { await navigator.clipboard.writeText(text); log('(log copied to clipboard)'); }
    catch (e) { log('(clipboard failed:', e.message, ')'); }
  });
  document.getElementById('log-clear')?.addEventListener('click', () => {
    queued.length = 0;
    const n = document.getElementById('log'); if (n) n.textContent = '';
  });
  window.addEventListener('error', (e) => log('window.error:', e.message));
  window.addEventListener('unhandledrejection', (e) => log('unhandledrejection:', e.reason?.message ?? e.reason));
  log('debug panel ready');
}
