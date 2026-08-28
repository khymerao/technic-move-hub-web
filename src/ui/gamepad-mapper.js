// The mapping panel: a picture of the pad in the driver's hands, with one slot
// per physical control. Pick the action for a control — not the control for an
// action, which is what the map itself stores.
// See docs/DESIGN-NOTES.md § The mapping panel names controls, not indices

import { setAttr, setClass, setText } from './dom.js';
import { PAD_ART } from './pad-art.js';
import { ART, controlsFor, detectLayout } from '../gamepad-layout.js';
import {
  DRIVE_MODES, assignable, bindingsOf, assignControl, unassign, clearControl, readSource,
  modifiersOf, setModifier,
} from '../gamepad-map.js';

// The wide stage, in CSS px. Slots stack in two columns either side of the
// drawing; the narrow layout ignores every one of these numbers.
const STAGE = { w: 1100, h: 560, col: 210, row: 54, top: 8, gapL: 222, gapR: 878 };

const MODE_LABELS = {
  playvm: 'Typical module behaviour — the hub drives itself',
  linked: 'Linked — both motors together',
  independent: 'Independent — A on left stick, B on right',
  tracked: 'Tracked — one stick, tank steering',
};
const GROUP_LABELS = { drive: 'drive', lights: 'lights', setup: 'setup' };
const BADGE = { xbox: 'xbox layout', playstation: 'playstation layout' };

// The same rule the control loop uses: filter on connected, never take the
// first non-null slot. See docs/DESIGN-NOTES.md § Chrome keeps dead pads in the gamepad array
function firstPad() {
  const pads = navigator.getGamepads?.() ?? [];
  for (let i = 0; i < pads.length; i++) {
    if (pads[i] && pads[i].connected !== false) return pads[i];
  }
  return null;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const svgEl = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);

// `getMap`/`setMap` keep the map where it already lives — on the controller,
// which saves it. This panel owns no copy.
export function initMapper(host, { getMap, setMap, getPad = firstPad, mode: startMode } = {}) {
  let layout = 'xbox';
  let mode = DRIVE_MODES.includes(startMode) ? startMode : 'playvm';
  let controls = controlsFor(layout);
  // null is the plain layer; a button index is "while that button is held".
  // See docs/DESIGN-NOTES.md § A modifier is a held button, not a mode
  let layer = null;
  let builtLayers = null;
  const slots = new Map();   // control id -> { node, action, kind }
  const wires = new Map();   // control id -> { line, dot }
  const arts = new Map();    // group name -> <g>
  let picking = null;

  host.className = 'pmap';
  const head = el('div', 'pmap-head');
  const padName = el('span', 'pmap-pad', 'no pad connected');
  const badge = el('span', 'pmap-badge', BADGE.xbox);
  head.append(padName, badge);

  const modeRow = el('label', 'pmap-mode');
  modeRow.append(el('span', 'lights-head', 'map for'));
  const modeSel = el('select');
  modeSel.id = 'gp-map-mode';
  for (const id of DRIVE_MODES) {
    const o = el('option', null, MODE_LABELS[id]);
    o.value = id;
    modeSel.append(o);
  }
  modeRow.append(modeSel);
  const modeHint = el('p', 'hint', 'One set of bindings for all four modes. A binding another mode uses stays put, dimmed.');

  const layerRow = el('label', 'pmap-mode');
  layerRow.append(el('span', 'lights-head', 'layer'));
  const layerSel = el('select');
  layerSel.id = 'gp-map-layer';
  layerRow.append(layerSel);

  const stage = el('div', 'pmap-stage');
  const artSvg = svgEl('svg');
  artSvg.setAttribute('class', 'pmap-art');
  artSvg.setAttribute('aria-hidden', 'true');
  const wireSvg = svgEl('svg');
  wireSvg.setAttribute('class', 'pmap-wires');
  wireSvg.setAttribute('viewBox', `0 0 ${STAGE.w} ${STAGE.h}`);
  wireSvg.setAttribute('aria-hidden', 'true');
  const slotBox = el('div', 'pmap-slots');
  stage.append(wireSvg, artSvg, slotBox);

  const dialog = el('dialog', 'pmap-picker');
  const pickHead = el('div', 'pmap-picker-head');
  const pickChip = el('span', 'chip');
  const pickTitle = el('span', 'pmap-picker-title');
  pickHead.append(pickChip, pickTitle);
  const pickList = el('div', 'pmap-picker-list');
  const pickFoot = el('div', 'pmap-picker-foot');
  const modBtn = el('button', 'pmap-mod', 'use as a modifier');
  modBtn.type = 'button';
  const clearBtn = el('button', 'pmap-clear', 'clear this control');
  clearBtn.type = 'button';
  const doneBtn = el('button', null, 'done');
  doneBtn.type = 'button';
  pickFoot.append(modBtn, clearBtn, doneBtn);
  dialog.append(pickHead, pickList, pickFoot);

  host.append(head, modeRow, modeHint, layerRow, stage, dialog);

  modeSel.value = mode;
  modeSel.addEventListener('change', () => { mode = modeSel.value; paint(); });
  layerSel.addEventListener('change', () => {
    layer = layerSel.value === '' ? null : Number(layerSel.value);
    paint();
  });
  doneBtn.addEventListener('click', () => dialog.close());
  clearBtn.addEventListener('click', () => {
    if (picking) setMap(clearControl(getMap(), picking, layer));
    dialog.close();
    paint();
  });
  modBtn.addEventListener('click', () => {
    if (!picking) return;
    const on = !modifiersOf(getMap()).includes(picking.source.index);
    setMap(setModifier(getMap(), picking, on));
    // Dropping a modifier drops the layer you might be looking at.
    if (!on && layer === picking.source.index) layer = null;
    dialog.close();
    paint();
  });
  dialog.addEventListener('close', () => { picking = null; paint(); });

  function openPicker(control) {
    picking = control;
    setText(pickChip, control.chip);
    const map = getMap();
    const isMod = modifiersOf(map).includes(control.source.index) && control.source.type === 'button';
    setText(pickTitle, isMod
      ? `${control.name} — held, it opens its own layer`
      : layer == null
        ? `${control.name} — pick what it does`
        : `${control.name} — pick what it does while ${chipOf(layer)} is held`);
    pickList.replaceChildren();
    // A modifier has no actions of its own to offer: it is the shift key.
    modBtn.hidden = control.source.type !== 'button' || (layer != null && !isMod);
    modBtn.textContent = isMod ? 'stop using as a modifier' : 'use as a modifier';
    setClass(modBtn, 'on', isMod);
    clearBtn.hidden = isMod;
    if (isMod) { dialog.showModal(); return; }
    const held = new Map();
    for (const c of controls) {
      for (const b of bindingsOf(map, c, layer)) held.set(b.key, c);
    }
    for (const group of Object.keys(GROUP_LABELS)) {
      const entries = assignable().filter((e) => e.group === group && e.modes.includes(mode));
      if (!entries.length) continue;
      pickList.append(el('p', 'lights-head', GROUP_LABELS[group]));
      for (const entry of entries) {
        const owner = held.get(entry.key);
        const mine = owner === control;
        const b = el('button', 'pmap-opt');
        b.type = 'button';
        b.append(el('span', null, entry.label));
        b.append(el('span', 'pmap-where', mine ? 'here — tap to remove' : owner ? `on ${owner.chip}` : entry.kind));
        if (mine) b.classList.add('on');
        else if (owner) b.classList.add('taken');
        // Tapping what this control already does takes it off, so a control can
        // be emptied one action at a time and not only all at once.
        b.addEventListener('click', () => {
          setMap(mine
            ? unassign(getMap(), entry.key)
            : assignControl(getMap(), control, entry.key, layer));
          dialog.close();
          paint();
        });
        pickList.append(b);
      }
    }
    dialog.showModal();
  }

  // Every control gets a slot and a wire, whatever the layout — only the chip,
  // the drawing and the point the wire lands on change.
  function build() {
    controls = controlsFor(layout);
    const art = ART[layout];
    artSvg.setAttribute('viewBox', `0 0 ${art.w} ${art.h}`);
    artSvg.innerHTML = PAD_ART[layout];
    host.style.setProperty('--art-x', `${art.x}px`);
    host.style.setProperty('--art-y', `${art.y}px`);
    host.style.setProperty('--art-w', `${Math.round(art.w * art.k)}px`);
    host.style.setProperty('--art-h', `${Math.round(art.h * art.k)}px`);
    arts.clear();
    for (const g of artSvg.querySelectorAll('[data-ctl]')) arts.set(g.dataset.ctl, g);

    slots.clear();
    wires.clear();
    slotBox.replaceChildren();
    wireSvg.replaceChildren();
    const rows = { left: 0, right: 0 };
    for (const control of controls) {
      const i = rows[control.side]++;
      const y = STAGE.top + i * STAGE.row;
      const cy = y + 24;
      const left = control.side === 'left' ? 0 : STAGE.w - STAGE.col;
      const edge = control.side === 'left' ? STAGE.col : STAGE.w - STAGE.col;
      const elbow = control.side === 'left' ? STAGE.gapL : STAGE.gapR;
      const tx = art.x + control.x * art.k;
      const ty = art.y + control.y * art.k;

      const line = svgEl('polyline');
      line.setAttribute('class', 'pmap-wire');
      line.setAttribute('points', `${edge},${cy} ${elbow},${cy} ${tx},${ty}`);
      const dot = svgEl('circle');
      dot.setAttribute('class', 'pmap-dot');
      dot.setAttribute('cx', tx);
      dot.setAttribute('cy', ty);
      dot.setAttribute('r', 3.5);
      wireSvg.append(line, dot);
      wires.set(control.id, { line, dot });

      const node = el('button', 'map-slot');
      node.type = 'button';
      node.style.setProperty('--sx', `${left}px`);
      node.style.setProperty('--sy', `${y}px`);
      const chip = el('span', 'chip', control.chip);
      const body = el('span', 'map-slot-body');
      const action = el('span', 'map-slot-action');
      const kind = el('span', 'map-slot-kind');
      body.append(action, kind);
      node.append(chip, body);
      node.addEventListener('click', () => openPicker(control));
      slotBox.append(node);
      slots.set(control.id, { node, action, kind });

      const g = arts.get(control.group);
      if (g && !g.dataset.wired) {
        g.dataset.wired = '1';
        g.addEventListener('click', () => openPicker(control));
      }
    }
  }

  // What each slot says. Value-keyed, so a repaint that changes nothing writes
  // nothing — this runs on every mode change and every assignment.
  const chipOf = (index) => {
    const c = controls.find((x) => x.source.type === 'button' && x.source.index === index);
    return c ? c.chip : `btn ${index}`;
  };

  // The layer select is rebuilt from the map, so adding a modifier adds its
  // layer and dropping one takes the layer with it.
  function paintLayers(map) {
    const mods = modifiersOf(map);
    if (layer != null && !mods.includes(layer)) layer = null;
    const want = mods.join(',');
    if (builtLayers !== want) {
      builtLayers = want;
      layerSel.replaceChildren();
      const base = el('option', null, 'plain — nothing held');
      base.value = '';
      layerSel.append(base);
      for (const m of mods) {
        const o = el('option', null, `while ${chipOf(m)} is held`);
        o.value = String(m);
        layerSel.append(o);
      }
    }
    layerSel.value = layer == null ? '' : String(layer);
    layerRow.hidden = !mods.length;
  }

  function paint() {
    const map = getMap();
    paintLayers(map);
    const mods = modifiersOf(map);
    for (const control of controls) {
      const slot = slots.get(control.id);
      const wire = wires.get(control.id);
      const isMod = control.source.type === 'button' && mods.includes(control.source.index);
      if (isMod) {
        setText(slot.action, 'modifier');
        setText(slot.kind, `hold for the ${control.chip} layer`);
        setAttr(slot.node, 'title', `${control.name}: modifier — hold it for a second set of bindings`);
        setClass(slot.node, 'mod', true);
        setClass(slot.node, 'empty', false);
        setClass(slot.node, 'idle', false);
        setClass(slot.node, 'picking', picking?.id === control.id);
        setClass(wire.line, 'empty', false);
        continue;
      }
      setClass(slot.node, 'mod', false);
      // A control can carry more than one action when the modes keep them
      // apart, so the slot says what it does HERE and lists the rest.
      // See docs/DESIGN-NOTES.md § A shared axis is spent once, not twice
      const bound = bindingsOf(map, control, layer);
      const live = bound.filter((b) => b.modes.includes(mode));
      const idle = bound.filter((b) => !b.modes.includes(mode));
      // On a layer, a control nobody has given anything keeps doing whatever it
      // does plainly — the layer displaces, it does not blank the pad.
      const passes = layer != null && !bound.length ? bindingsOf(map, control) : [];
      setText(slot.action, live.length
        ? live.map((b) => b.label).join(' + ')
        : bound[0]?.label ?? (passes.length ? passes[0].label : 'free'));
      setText(slot.kind, live.length
        ? (idle.length ? `${live[0].kind} — also ${idle.map((b) => b.label).join(', ')}` : live[0].kind)
        : bound.length ? `${bound[0].kind} — idle in this mode`
        : passes.length ? 'unchanged on this layer' : 'nothing bound');
      setAttr(slot.node, 'title', bound.length
        ? `${control.name}: ${bound.map((b) => b.label).join(', ')}`
        : `${control.name}: nothing bound`);
      setClass(slot.node, 'empty', !bound.length && !passes.length);
      setClass(slot.node, 'idle', (!!bound.length && !live.length) || !!passes.length);
      setClass(slot.node, 'picking', picking?.id === control.id);
      setClass(wire.line, 'empty', !bound.length && !passes.length);
    }
  }

  // The pad's own report, read here and nowhere else: this is a picture of what
  // the driver is pressing, so a dead pad has to stay visibly dead. It commands
  // nothing — the control loop is the only thing that may.
  let raf = 0;
  const lit = new Set();
  function frame() {
    raf = requestAnimationFrame(frame);
    // The panel lives in a closed <details> most of the time. Reading the pad
    // then costs a frame and paints nothing anyone can see.
    if (host.offsetParent === null && host.offsetWidth === 0) return;
    const pad = getPad?.();
    if (!pad) {
      if (lit.size) {
        for (const id of lit) paintPress(id, false);
        lit.clear();
      }
      return;
    }
    const id = pad.id || '';
    const want = detectLayout(id);
    if (want !== layout) {
      layout = want;
      setText(badge, BADGE[layout]);
      build();
      paint();
    }
    setText(padName, id);
    for (const control of controls) {
      const v = readSource(pad, control.source);
      const down = control.source.type === 'axis' ? Math.abs(v) > 0.5 : v > 0.5;
      if (down === lit.has(control.id)) continue;
      if (down) lit.add(control.id); else lit.delete(control.id);
      paintPress(control.id, down);
    }
  }

  function paintPress(controlId, down) {
    const control = controls.find((c) => c.id === controlId);
    if (!control) return;
    setClass(slots.get(controlId).node, 'live', down);
    setClass(wires.get(controlId).line, 'live', down);
    setClass(wires.get(controlId).dot, 'live', down);
    // One drawing group can carry two controls (a shoulder and the trigger
    // behind it), so it stays lit while either is down.
    const g = arts.get(control.group);
    if (!g) return;
    const still = controls.some((c) => c.group === control.group && lit.has(c.id));
    setClass(g, 'on', still);
  }

  build();
  paint();
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(frame);

  return {
    refresh() { build(); paint(); },
    setMode(next) {
      if (!DRIVE_MODES.includes(next)) return;
      mode = next;
      modeSel.value = next;
      paint();
    },
    stop() { cancelAnimationFrame(raf); raf = 0; },
  };
}
