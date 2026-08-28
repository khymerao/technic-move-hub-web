// Signatures, one-line hints and runnable snippets for the macro editor's help
// panel. Read only by the UI: the worker and the host never import this.
//
// Every snippet is awaited. A call the host refuses reports nothing at all if
// the macro did not await it.
// See docs/DESIGN-NOTES.md § Nothing is enforced in the worker

export const DOCS = {
  drive: {
    sig: 'drive(speed, steer)',
    hint: 'hold a speed and steering angle on the combined frame',
    snippet: 'await drive(40, 0);',
  },
  driveFor: {
    sig: 'driveFor(speed, steer, ms)',
    hint: 'drive for a fixed time, then stop',
    snippet: 'await driveFor(40, 0, 1000);',
  },
  stopDrive: {
    sig: 'stopDrive()',
    hint: 'release the combined frame',
    snippet: 'await stopDrive();',
  },
  lights: {
    sig: 'lights(mode)',
    hint: "'both', 'off', 'brake' or 'front-off-brake'",
    snippet: "await lights('both');",
  },

  motorFor: {
    sig: 'motorFor(port, speed, ms)',
    hint: 'run one motor for a fixed time, then float it',
    snippet: 'await motorFor(0x32, 50, 500);',
  },
  throttleFor: {
    sig: 'throttleFor(speed, ms)',
    hint: 'both drive motors at one speed, for a fixed time',
    snippet: 'await throttleFor(50, 500);',
  },
  tankFor: {
    sig: 'tankFor(left, right, ms)',
    hint: 'drive motors at separate speeds, for a fixed time',
    snippet: 'await tankFor(50, -50, 500);',
  },
  brake: {
    sig: 'brake(port)',
    hint: 'stop one motor dead',
    snippet: 'await brake(0x32);',
  },
  brakeAll: {
    sig: 'brakeAll()',
    hint: 'stop the drive pair dead',
    snippet: 'await brakeAll();',
  },
  coast: {
    sig: 'coast(port)',
    hint: 'let one motor free-wheel',
    snippet: 'await coast(0x32);',
  },

  steer: {
    sig: 'steer(input)',
    hint: 'hold a steering angle, -100 to 100',
    snippet: 'await steer(50);',
  },
  steerZero: {
    sig: 'steerZero()',
    hint: 'take the current position as straight ahead',
    snippet: 'await steerZero();',
  },
  steerPos: {
    sig: 'steerPos()',
    hint: 'the steering angle right now',
    snippet: 'await steerPos();',
  },

  lamps: {
    sig: 'lamps(mask, brightness)',
    hint: 'the six lamps, as a bitmask and 0-100',
    snippet: 'await lamps(0x3f, 100);',
  },
  led: {
    sig: 'led(colour)',
    hint: 'the hub LED, 0-10',
    snippet: 'await led(3);',
  },

  tilt: {
    sig: 'tilt(timeoutMs)',
    hint: 'next tilt reading — a value that never changes never arrives',
    snippet: 'await tilt();',
  },
  accel: {
    sig: 'accel(timeoutMs)',
    hint: 'next accelerometer reading — silent while the car sits still',
    snippet: 'await accel();',
  },
  battery: {
    sig: 'battery(timeoutMs)',
    hint: 'battery percentage',
    snippet: 'await battery();',
  },
  motorSpeed: {
    sig: 'motorSpeed(port, timeoutMs)',
    hint: 'next speed reading — a motor that is not turning never reports',
    snippet: 'await motorSpeed(0x32);',
  },
  motorPos: {
    sig: 'motorPos(port, timeoutMs)',
    hint: 'next position reading — a motor that is not moving never reports',
    snippet: 'await motorPos(0x34);',
  },
  ports: {
    sig: 'ports()',
    hint: 'the port numbers: driveA, driveB, steer',
    snippet: 'await ports();',
  },

  wait: {
    sig: 'wait(ms)',
    hint: 'pause',
    snippet: 'await wait(500);',
  },
  waitUntil: {
    sig: 'waitUntil(predicate, timeoutMs, pollMs)',
    hint: 'poll until the predicate returns true',
    snippet: 'await waitUntil(async () => await battery() > 50, 5000);',
  },
  waitFor: {
    sig: 'waitFor(name, timeoutMs)',
    hint: "wait for an impact — needs collision('stop') or ('notify') first",
    snippet: "await waitFor('collision', 5000);",
  },

  mode: {
    sig: 'mode(name)',
    hint: "'playvm' arms the hub's own frame, 'raw' hands you the motors",
    snippet: "await mode('raw');",
  },

  collision: {
    sig: 'collision(mode)',
    hint: "'abort', 'stop', 'notify' or 'off' — what an impact does",
    snippet: "await collision('stop');",
  },
  collisionThreshold: {
    sig: 'collisionThreshold(mg)',
    hint: 'impact sensitivity in milli-g',
    snippet: 'await collisionThreshold(1800);',
  },

  print: {
    sig: 'print(...args)',
    hint: 'write a line to the debug log',
    snippet: "await print('here');",
  },

  'unsafe.raw': {
    sig: 'unsafe.raw(bytes, key)',
    hint: 'any frame at all — including the hub-killers listed below',
    snippet: 'await unsafe.raw([0x05, 0x00, 0x01, 0x02, 0x05]);',
  },
  'unsafe.writeDirect': {
    sig: 'unsafe.writeDirect(port, mode, values)',
    hint: 'write a direct mode payload to a port',
    snippet: 'await unsafe.writeDirect(0x32, 0x00, [0]);',
  },
  'unsafe.subscribe': {
    sig: 'unsafe.subscribe(port, mode, delta)',
    hint: 'subscribe to any port and mode',
    snippet: 'await unsafe.subscribe(0x32, 0x02, 2);',
  },
  'unsafe.unsubscribe': {
    sig: 'unsafe.unsubscribe(port, mode)',
    hint: 'drop a subscription made with unsafe.subscribe',
    snippet: 'await unsafe.unsubscribe(0x32, 0x02);',
  },
  'unsafe.gotoPosition': {
    sig: 'unsafe.gotoPosition(port, angle, speed, maxPower, endState)',
    hint: 'crashes the firmware on the steer motor',
    snippet: 'await unsafe.gotoPosition(0x34, 0, 30, 50, 0x7e);',
  },
  'unsafe.speedForDegrees': {
    sig: 'unsafe.speedForDegrees(port, degrees, speed, maxPower, endState)',
    hint: 'position-command family, suspect on this hub',
    snippet: 'await unsafe.speedForDegrees(0x32, 360, 40, 50, 0x7e);',
  },
  'unsafe.linkDriveMotors': {
    sig: 'unsafe.linkDriveMotors()',
    hint: 'this hub leaves the air within 0.1-1.1s',
    snippet: 'await unsafe.linkDriveMotors();',
  },
  'unsafe.unlinkDriveMotors': {
    sig: 'unsafe.unlinkDriveMotors()',
    hint: 'undo linkDriveMotors',
    snippet: 'await unsafe.unlinkDriveMotors();',
  },
};

export const EXAMPLES = [
  {
    name: 'donut',
    source: [
      '// Full lock, three seconds, then stop.',
      'await drive(40, 100);',
      'await wait(3000);',
      'await stopDrive();',
      '',
    ].join('\n'),
  },
  {
    name: 'bumper',
    source: [
      '// Drive until something is hit, back off, repeat.',
      "// mode('raw') hands you the motors, so tankFor can spin on the spot.",
      "// collision('stop') cuts the motion but leaves the macro running.",
      "await mode('raw');",
      "await collision('stop');",
      'for (let i = 0; i < 5; i++) {',
      '  await tankFor(40, 40, 4000);',
      "  await waitFor('collision', 10000);",
      '  await tankFor(-40, 40, 600);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'sweep',
    source: [
      '// Raw path: nudge the steer motor and read where it ended up.',
      '// Leave the hub drive mode before running this.',
      'const p = await ports();',
      'await motorFor(p.steer, 30, 400);',
      "await print('angle', await motorPos(p.steer));",
      '',
    ].join('\n'),
  },
];

// The order and the headings the method palette renders. Grouping is a
// property of the documentation, not of the API — the worker and the host read
// api-spec.js and neither of them cares what a call is filed under.
// See docs/DESIGN-NOTES.md § The macro palette is grouped, and sits beside the editor
export const GROUPS = [
  { id: 'driving', label: 'driving — combined frame', methods: ['drive', 'driveFor', 'stopDrive', 'lights'] },
  { id: 'motors', label: 'motors — raw', methods: ['motorFor', 'throttleFor', 'tankFor', 'brake', 'brakeAll', 'coast'] },
  { id: 'steering', label: 'steering', methods: ['steer', 'steerZero', 'steerPos'] },
  { id: 'lights', label: 'lights', methods: ['lamps', 'led'] },
  { id: 'sensors', label: 'sensors', methods: ['tilt', 'accel', 'battery', 'motorSpeed', 'motorPos', 'ports'] },
  { id: 'timing', label: 'time and events', methods: ['wait', 'waitUntil', 'waitFor', 'mode'] },
  { id: 'collision', label: 'collision', methods: ['collision', 'collisionThreshold'] },
  { id: 'output', label: 'output', methods: ['print'] },
  {
    id: 'unsafe',
    label: 'unsafe — documented hub-killers',
    methods: [
      'unsafe.raw', 'unsafe.writeDirect', 'unsafe.subscribe', 'unsafe.unsubscribe',
      'unsafe.gotoPosition', 'unsafe.speedForDegrees',
      'unsafe.linkDriveMotors', 'unsafe.unlinkDriveMotors',
    ],
  },
];
