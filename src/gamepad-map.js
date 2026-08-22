// Pure gamepad mapping: W3C "standard mapping" indices and action bindings.
// No DOM, no BLE.

export const BUTTON_NAMES = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
  'Back', 'Start', 'L3', 'R3', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Guide',
];
export const AXIS_NAMES = ['L-Stick X', 'L-Stick Y', 'R-Stick X', 'R-Stick Y'];

// Every action the car exposes. `kind` decides how the raw source is read:
//   'axis'   -> continuous -1..1
//   'pair'   -> positive source minus negative source (triggers)
//   'button' -> boolean pressed
export const ACTIONS = [
  { id: 'steer', label: 'Steer', kind: 'axis' },
  { id: 'throttle', label: 'Throttle A (triggers)', kind: 'pair' },
  { id: 'throttleB', label: 'Throttle B (independent mode)', kind: 'axis' },
  { id: 'tankTurn', label: 'Tank turn (tracked mode)', kind: 'axis' },
  { id: 'tankThrottle', label: 'Tank throttle (tracked mode)', kind: 'axis' },
  { id: 'tankSteer', label: 'Steer motor — tracked mode (raw)', kind: 'axis' },
  { id: 'brake', label: 'Brake', kind: 'button' },
  { id: 'driveModeToggle', label: 'Toggle linked/independent drive', kind: 'button' },
  { id: 'steerModeToggle', label: 'Toggle raw/steer mode', kind: 'button' },
  { id: 'steerZero', label: 'Set steering zero', kind: 'button' },
  { id: 'ledCycle', label: 'Cycle RGB LED', kind: 'button' },
  { id: 'lightsToggle', label: 'All lights on/off', kind: 'button' },
  { id: 'lamp1', label: 'Lamp 1', kind: 'button' },
  { id: 'lamp2', label: 'Lamp 2', kind: 'button' },
  { id: 'lamp3', label: 'Lamp 3', kind: 'button' },
  { id: 'lamp4', label: 'Lamp 4', kind: 'button' },
  { id: 'lamp5', label: 'Lamp 5', kind: 'button' },
  { id: 'lamp6', label: 'Lamp 6', kind: 'button' },
  { id: 'trimLeft', label: 'Trim steer left', kind: 'button' },
  { id: 'trimRight', label: 'Trim steer right', kind: 'button' },
];

// See docs/DESIGN-NOTES.md § The default bindings follow driving-game convention
export const DEFAULT_MAP = {
  steer: { type: 'axis', index: 0 },
  throttle: { pos: { type: 'button', index: 7 }, neg: { type: 'button', index: 6 } },
  // Stick Y is negative-up in the standard mapping, so inverted for up = forward.
  throttleB: { type: 'axis', index: 3, invert: true },
  // Tracked mode: X counter-rotates the tracks, Y drives them. Deliberately NOT
  // inverted despite negative-up — tankMix and the mirrored-motor inversion
  // flip it back. See docs/DESIGN-NOTES.md § Tracked mode needs a mirrored drive motor to make sense
  tankTurn: { type: 'axis', index: 0 },
  tankThrottle: { type: 'axis', index: 1 },
  // RIGHT stick, and it must stay off the left one.
  // See docs/DESIGN-NOTES.md § The steering motor gets its own stick in tracked mode
  tankSteer: { type: 'axis', index: 2 },
  brake: { type: 'button', index: 0 },           // A — Forza handbrake slot
  steerModeToggle: { type: 'button', index: 1 }, // B
  driveModeToggle: { type: 'button', index: 9 }, // Start — mode switches
  steerZero: { type: 'button', index: 8 },       // Back — destructive, hold-guarded
  ledCycle: { type: 'button', index: 3 },        // Y — cosmetic
  lightsToggle: { type: 'button', index: 15 },   // D-Right — GTA headlights slot
  lamp1: { type: 'button', index: 12 },          // D-Up
  lamp2: { type: 'button', index: 13 },          // D-Down
  lamp3: { type: 'button', index: 14 },          // D-Left
  lamp4: { type: 'button', index: 2 },           // X
  lamp5: { type: 'button', index: 10 },          // L3
  lamp6: { type: 'button', index: 11 },          // R3
  trimLeft: { type: 'button', index: 4 },        // LB
  trimRight: { type: 'button', index: 5 },       // RB
};

// Actions destructive mid-drive: held, not tapped. Milliseconds.
export const HOLD_ACTIONS = { steerZero: 1000 };

export function readSource(gp, src) {
  if (!src) return 0;
  let v;
  if (src.type === 'axis') v = gp.axes[src.index] ?? 0;
  else v = gp.buttons[src.index]?.value ?? 0;
  return src.invert ? -v : v;
}

export function resolveActions(gp, map) {
  const out = {};
  for (const action of ACTIONS) {
    const binding = map[action.id];
    if (action.kind === 'pair') {
      out[action.id] = readSource(gp, binding?.pos) - readSource(gp, binding?.neg);
    } else if (action.kind === 'axis') {
      out[action.id] = readSource(gp, binding);
    } else {
      out[action.id] = readSource(gp, binding) > 0.5;
    }
  }
  return out;
}

export function learnBinding(gp, prev, threshold = 0.5) {
  for (let i = 0; i < gp.buttons.length; i++) {
    const now = gp.buttons[i].value;
    const was = prev?.buttons?.[i] ?? 0;
    if (now > 0.5 && was <= 0.5) return { type: 'button', index: i };
  }
  for (let i = 0; i < gp.axes.length; i++) {
    const now = gp.axes[i] ?? 0;
    const was = prev?.axes?.[i] ?? 0;
    if (Math.abs(now) > threshold && Math.abs(now - was) > threshold) return { type: 'axis', index: i };
  }
  return null;
}

export function sourceLabel(src) {
  if (!src) return '—';
  if (src.type === 'axis') return `${AXIS_NAMES[src.index] ?? 'Axis ' + src.index}${src.invert ? ' (inv)' : ''}`;
  return BUTTON_NAMES[src.index] ?? `Btn ${src.index}`;
}

// Tank / skid-steer mixing from a single stick, using WPILib's desaturation:
// inputs are scaled down BEFORE summing, not clipped after.
// See docs/DESIGN-NOTES.md § Tank mixing desaturates instead of clipping
export function tankMix(throttle, turn) {
  const t = Math.max(-100, Math.min(100, throttle)) / 100;
  const s = Math.max(-100, Math.min(100, turn)) / 100;
  const greater = Math.max(Math.abs(t), Math.abs(s));
  const lesser = Math.abs(t) + Math.abs(s) - greater;
  const saturated = greater > 0 ? (lesser / greater) + 1 : 1;
  const ts = t / saturated;
  const ss = s / saturated;
  return { left: Math.round((ts + ss) * 100), right: Math.round((ts - ss) * 100) };
}
