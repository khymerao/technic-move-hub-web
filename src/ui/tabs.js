// Tab navigation. The chrome (link status, gamepad arm) lives outside the tabs
// on purpose.
//
// See docs/DESIGN-NOTES.md § Anything that cuts power lives outside the tabs

import { $ } from './dom.js';

export function initTabs() {
  const bar = $('tabbar');
  const panels = [...document.querySelectorAll('.tabpanel')];
  const listeners = [];
  let current = null;

  function show(name) {
    for (const p of panels) p.hidden = p.dataset.tab !== name;
    for (const b of bar.querySelectorAll('button')) {
      const here = b.dataset.go === name;
      b.classList.toggle('on', here);
      // The underline is the only visual marker, so state it as well as draw it.
      b.ariaCurrent = here ? 'true' : 'false';
    }
    if (name === current) return;
    current = name;
    for (const fn of listeners) fn(name);
  }

  bar.addEventListener('click', (e) => {
    const name = e.target.dataset?.go;
    if (name) show(name);
  });
  // The status chip is the shortcut to everything about the link.
  $('chrome-status').addEventListener('click', () => show('hub'));

  // Number keys jump between sections; ignored while typing.
  const order = [...bar.querySelectorAll('button')].map((b) => b.dataset.go);
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const index = Number(e.key) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= order.length) return;
    if (bar.hidden) return;   // no hub, no sections to move between
    show(order[index]);
  });

  return {
    show,
    onChange(fn) { listeners.push(fn); },
    current() { return current; },
    // The chrome bar is always present; only its contents change. Losing the
    // hub takes the dashboard with it, so no tab is current afterwards — and
    // the next connect announces the landing tab instead of being swallowed by
    // the repeat guard.
    setConnected(on) {
      if (!on) current = null;
      $('connect').hidden = on;
      $('chrome-status').hidden = !on;
      $('battery').hidden = !on;
      $('gp-enable').hidden = !on;
      $('tabbar').hidden = !on;
      $('dashboard').hidden = !on;
      if (on) show('drive');
    },
  };
}
