// Which controller is in the driver's hands, and where each control sits on the
// drawing of it. Pure: no DOM, no navigator, no BLE.
//
// The indices below are the W3C standard mapping and never vary — only the
// printing on the plastic does, which is the whole reason this module exists.
// See docs/DESIGN-NOTES.md § The mapping panel names controls, not indices

export const LAYOUTS = ['xbox', 'playstation'];

// The id string a pad reports is free-form vendor text. Match the vendor id
// first (stable), then the marketing names browsers put in front of it.
const PLAYSTATION = /054c|dualsense|dualshock|playstation|\bps[345]\b|wireless controller/i;
const XBOX = /045e|xbox|xinput/i;

// Anything unrecognised gets the Xbox drawing: it is the shape the standard
// mapping was written against, so the indices and the picture agree.
export function detectLayout(id = '') {
  // Xbox first: Chrome calls a DualShock "Wireless Controller", and Microsoft
  // calls its own pad an "Xbox Wireless Controller" — the generic half of that
  // name matches both, the Xbox half only one.
  if (XBOX.test(id)) return 'xbox';
  if (PLAYSTATION.test(id)) return 'playstation';
  return 'xbox';
}

// `side` places the slot column, `group` names the group in the drawing that
// lights up, `x`/`y` are the point the leader line lands on in that drawing's
// own viewBox. `invertY` is the stick's negative-up correction: it rides the
// binding, not the reader, so resolveActions stays a lookup.
// See docs/DESIGN-NOTES.md § The default bindings follow driving-game convention
const BASE = [
  { id: 'lt', source: { type: 'button', index: 6 }, side: 'left' },
  { id: 'lb', source: { type: 'button', index: 4 }, side: 'left' },
  { id: 'lx', source: { type: 'axis', index: 0 }, side: 'left' },
  { id: 'ly', source: { type: 'axis', index: 1 }, side: 'left', invertY: true },
  { id: 'l3', source: { type: 'button', index: 10 }, side: 'left' },
  { id: 'dup', source: { type: 'button', index: 12 }, side: 'left' },
  { id: 'ddn', source: { type: 'button', index: 13 }, side: 'left' },
  { id: 'dlf', source: { type: 'button', index: 14 }, side: 'left' },
  { id: 'drt', source: { type: 'button', index: 15 }, side: 'left' },
  { id: 'view', source: { type: 'button', index: 8 }, side: 'left' },
  { id: 'rt', source: { type: 'button', index: 7 }, side: 'right' },
  { id: 'rb', source: { type: 'button', index: 5 }, side: 'right' },
  { id: 'rx', source: { type: 'axis', index: 2 }, side: 'right' },
  { id: 'ry', source: { type: 'axis', index: 3 }, side: 'right', invertY: true },
  { id: 'r3', source: { type: 'button', index: 11 }, side: 'right' },
  { id: 'y', source: { type: 'button', index: 3 }, side: 'right' },
  { id: 'b', source: { type: 'button', index: 1 }, side: 'right' },
  { id: 'x', source: { type: 'button', index: 2 }, side: 'right' },
  { id: 'a', source: { type: 'button', index: 0 }, side: 'right' },
  { id: 'menu', source: { type: 'button', index: 9 }, side: 'right' },
];

// chip, name, group, x, y — per drawing. The chip is what is printed on the
// pad; the index stays in the debug log.
const FACE = {
  xbox: {
    lt: ['LT', 'left trigger', 'lt', 339, 142],
    lb: ['LB', 'left bumper', 'lb', 369, 154],
    lx: ['L↔', 'left stick, sideways', 'lstick', 352, 216],
    ly: ['L↕', 'left stick, up and down', 'lstick', 352, 235],
    l3: ['L3', 'left stick click', 'lstick', 352, 254],
    dup: ['D↑', 'D-pad up', 'dpad', 418, 296],
    ddn: ['D↓', 'D-pad down', 'dpad', 418, 348],
    dlf: ['D←', 'D-pad left', 'dpad', 392, 322],
    drt: ['D→', 'D-pad right', 'dpad', 444, 322],
    view: ['VIEW', 'View', 'view', 448, 234],
    rt: ['RT', 'right trigger', 'rt', 634, 142],
    rb: ['RB', 'right bumper', 'rb', 605, 154],
    rx: ['R↔', 'right stick, sideways', 'rstick', 556, 295],
    ry: ['R↕', 'right stick, up and down', 'rstick', 556, 314],
    r3: ['R3', 'right stick click', 'rstick', 556, 333],
    y: ['Y', 'Y', 'y', 622, 200],
    b: ['B', 'B', 'b', 659, 236],
    x: ['X', 'X', 'x', 585, 236],
    a: ['A', 'A', 'a', 622, 271],
    menu: ['MENU', 'Menu', 'menu', 526, 234],
  },
  playstation: {
    lt: ['L2', 'L2 trigger', 'lb', 250, 148],
    lb: ['L1', 'L1 bumper', 'lb', 280, 160],
    lx: ['L↔', 'left stick, sideways', 'lstick', 354, 308],
    ly: ['L↕', 'left stick, up and down', 'lstick', 354, 328],
    l3: ['L3', 'left stick click', 'lstick', 354, 348],
    dup: ['D↑', 'D-pad up', 'dpad', 266, 222],
    ddn: ['D↓', 'D-pad down', 'dpad', 266, 283],
    dlf: ['D←', 'D-pad left', 'dpad', 238, 253],
    drt: ['D→', 'D-pad right', 'dpad', 295, 253],
    view: ['CREATE', 'Create', 'create', 310, 191],
    rt: ['R2', 'R2 trigger', 'rb', 636, 148],
    rb: ['R1', 'R1 bumper', 'rb', 606, 160],
    rx: ['R↔', 'right stick, sideways', 'rstick', 532, 308],
    ry: ['R↕', 'right stick, up and down', 'rstick', 532, 328],
    r3: ['R3', 'right stick click', 'rstick', 532, 348],
    y: ['△', 'Triangle', 'y', 615, 210],
    b: ['○', 'Circle', 'b', 656, 252],
    x: ['□', 'Square', 'x', 574, 252],
    a: ['✕', 'Cross', 'a', 615, 292],
    menu: ['OPTIONS', 'Options', 'options', 571, 191],
  },
};

// The drawing's own coordinate system, and where it sits on the map stage.
export const ART = {
  xbox: { w: 954, h: 624, x: 230, y: 55, k: 0.671 },
  playstation: { w: 889, h: 620, x: 230, y: 42, k: 0.72 },
};

export function controlsFor(layout) {
  const face = FACE[layout] || FACE.xbox;
  return BASE.map((c) => {
    const [chip, name, group, x, y] = face[c.id];
    return { ...c, chip, name, group, x, y };
  });
}

export function controlById(layout, id) {
  return controlsFor(layout).find((c) => c.id === id) || null;
}

export function sameSource(a, b) {
  return !!a && !!b && a.type === b.type && a.index === b.index;
}
