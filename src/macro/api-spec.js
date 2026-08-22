// The one list of what a macro can call. The worker builds its proxies from
// this; the host builds its dispatch table from it. Neither may define a
// method name of its own.
//
//   unsafe — documented in this project as a hub-killer. Refused by the host
//            unless the macro's stored allowUnsafe flag is set.
//   path   — which drive path the call belongs to. A run may use one, never
//            both. See docs/DESIGN-NOTES.md § Exactly one drive path may be
//            live at a time
//   motion — puts power into a motor.

const m = (path) => ({ unsafe: false, path, motion: true });
const plain = { unsafe: false, path: 'any', motion: false };
const danger = { unsafe: true, path: 'any', motion: false };

export const API = {
  // Driving — the combined frame. The hub's own watchdog sits under this path.
  drive: m('playvm'),
  driveFor: m('playvm'),
  stopDrive: { unsafe: false, path: 'playvm', motion: false },
  lights: { unsafe: false, path: 'playvm', motion: false },

  // Motors directly. No device-side failsafe.
  motorFor: m('raw'),
  throttleFor: m('raw'),
  tankFor: m('raw'),
  brake: { unsafe: false, path: 'raw', motion: false },
  brakeAll: { unsafe: false, path: 'raw', motion: false },
  coast: { unsafe: false, path: 'raw', motion: false },

  // Steering — the closed loop. Unavailable while PlayVM owns the steer motor.
  steer: m('raw'),
  steerZero: { unsafe: false, path: 'raw', motion: false },
  steerPos: plain,

  // Lights
  lamps: plain,
  led: plain,

  // Sensors
  tilt: plain,
  accel: plain,
  battery: plain,
  motorSpeed: plain,
  motorPos: plain,
  ports: plain,

  // Time and events
  wait: plain,
  waitUntil: plain,
  waitFor: plain,
  mode: plain,

  // Collision behaviour
  collision: plain,
  collisionThreshold: plain,

  // Output
  print: plain,

  // Everything this project's documentation records as a hub-killer.
  'unsafe.raw': danger,
  'unsafe.writeDirect': danger,
  'unsafe.subscribe': danger,
  'unsafe.unsubscribe': danger,
  'unsafe.gotoPosition': danger,
  'unsafe.speedForDegrees': danger,
  'unsafe.linkDriveMotors': danger,
  'unsafe.unlinkDriveMotors': danger,
};

export const METHOD_NAMES = Object.keys(API);
export const isUnsafe = (name) => API[name]?.unsafe === true;
export const pathOf = (name) => API[name]?.path ?? 'any';
