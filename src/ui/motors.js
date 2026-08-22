// Motor controls, split by how often they are used: the drive rows live in the
// Drive tab, direction and the steer jog in Setup. The brake-vs-coast choice is
// shared with the gamepad via shouldBrake().
//
// See docs/DESIGN-NOTES.md § Motor direction is calibration, not a driving control

import { $, holdButton, setToggle } from './dom.js';

export function initMotorPanel(hub) {
  const host = $('motors');
  const dirHost = $('motor-dirs');
  const jogHost = $('steer-jog');
  const motorPorts = new Set();
  const speedOuts = new Map(); // port -> <span> live speed readout
  // Release behaviour is per motor: brake stops it dead, coast lets it free-wheel.
  const brakeMode = new Map(); // port -> true = brake on release, false = coast
  const shouldBrake = (port) => brakeMode.get(port) !== false;

  // The transport queue coalesces per motor port, so rapid taps collapse to
  // the latest speed on their own.
  function setMotor(port, speed) {
    const protocol = hub.protocol;
    if (!protocol) return;
    // Route both drive rows to the virtual port while one exists (in practice
    // never, now). See docs/DESIGN-NOTES.md § Motor direction is calibration, not a driving control
    const vp = protocol.drivePort;
    const target = (vp != null && (port === protocol.roles.driveA || port === protocol.roles.driveB))
      ? vp : port;
    if (speed === 0 && shouldBrake(target)) protocol.brakeMotor(target);
    else protocol.setMotorSpeedRaw(target, speed);
  }

  function motorRow(label, port) {
    const row = document.createElement('div');
    row.className = 'motor';

    const head = document.createElement('div');
    head.className = 'motor-head';
    const speedOut = document.createElement('span');
    speedOut.className = 'speed-out';
    speedOut.textContent = '0';
    speedOuts.set(port, speedOut);
    head.append(`${label} · 0x${port.toString(16)} — speed `, speedOut);

    const power = document.createElement('input');
    Object.assign(power, { type: 'range', min: 10, max: 100, value: 50 });
    const out = document.createElement('output');
    out.textContent = '50';
    power.addEventListener('input', () => { out.textContent = power.value; });
    const powerLabel = document.createElement('label');
    powerLabel.append('power ', power, out);

    const fwd = document.createElement('button');
    fwd.type = 'button'; fwd.textContent = 'FWD ▲';
    const rev = document.createElement('button');
    rev.type = 'button'; rev.textContent = 'REV ▼';
    holdButton(fwd, () => setMotor(port, +power.value), () => setMotor(port, 0));
    holdButton(rev, () => setMotor(port, -power.value), () => setMotor(port, 0));

    const btns = document.createElement('div');
    btns.className = 'motor-btns';
    btns.append(fwd, rev);

    row.append(head, powerLabel, btns);
    return row;
  }

  function directionToggle(label, port) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'release-btn';
    const key = `lego-invert-0x${port.toString(16)}`;
    let inverted = localStorage.getItem(key) === '1';
    hub.protocol?.setMotorInverted(port, inverted);
    const paint = () => {
      btn.textContent = `${label}: ${inverted ? 'REVERSED' : 'NORMAL'}`;
      setToggle(btn, inverted);
    };
    btn.addEventListener('click', () => {
      inverted = !inverted;
      hub.protocol?.setMotorInverted(port, inverted);
      try { localStorage.setItem(key, inverted ? '1' : '0'); } catch { /* ignore */ }
      paint();
      setMotor(port, 0);
    });
    paint();
    return btn;
  }

  // Duplicates the steering panel's jog buttons; kept in Setup for alignment.
  function steerJog(port) {
    const wrap = document.createElement('div');
    wrap.className = 'motor-btns';
    const mk = (text, dir) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = text;
      holdButton(b, () => setMotor(port, dir * 40), () => setMotor(port, 0));
      return b;
    };
    wrap.append(mk('jog \u25c0', -1), mk('jog \u25b6', 1));
    return wrap;
  }

  function build(roles) {
    host.replaceChildren();
    dirHost.replaceChildren();
    jogHost.replaceChildren();
    motorPorts.clear();
    speedOuts.clear();

    // Drive tab: only the motors you actually drive with.
    for (const [label, port] of [['Drive A', roles.driveA], ['Drive B', roles.driveB]]) {
      if (port == null) continue;
      motorPorts.add(port);
      host.append(motorRow(label, port));
    }
    // Setup tab: direction for every motor, plus the steer jog.
    for (const [label, port] of [['Drive A', roles.driveA], ['Drive B', roles.driveB], ['Steer', roles.steer]]) {
      if (port == null) continue;
      motorPorts.add(port);
      dirHost.append(directionToggle(label, port));
    }
    if (roles.steer != null) jogHost.append(steerJog(roles.steer));
  }

  const stopAll = () => { for (const port of motorPorts) setMotor(port, 0); };

  // Coast vs brake when a control returns to zero. Global switch: sets every
  // motor at once; per-motor buttons override it after.
  const releaseSel = $('release-mode');
  releaseSel.addEventListener('change', (e) => {
    const brake = e.target.value === 'brake';
    for (const port of motorPorts) brakeMode.set(port, brake);
    // Re-issue the stop so the new behaviour is felt now, not on next release.
    const drive = hub.protocol?.drivePort ?? hub.protocol?.roles?.driveA;
    if (drive != null) setMotor(drive, 0);
  });

  return {
    shouldBrake,
    setMotor,
    build,
    stopAll,
    showSpeed(port, speed) {
      const out = speedOuts.get(port);
      if (out) out.textContent = String(speed);
    },
  };
}
