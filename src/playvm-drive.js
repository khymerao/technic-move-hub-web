// Arming port 0x36 so the hub will accept combined drive frames: COMMAND (0x10)
// then CALIBRATE_STEERING (0x08), both in the lights field with speed and
// steering at zero. The second sweeps the rack, so the wheels must be free.
//
// See docs/DESIGN-NOTES.md § The port must be armed with two init frames before it will drive

import { encodePlayVmFrame, PLAYVM_CMD } from './lwp-encoders.js';
import { PLAYVM_PORT } from './lwp-decoders.js';
import { log } from './debug-log.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A positive verdict means "well formed", not "did something": only an explicit
// Generic Error or silence counts as failure.
// See docs/DESIGN-NOTES.md § An acknowledgement from the drive port proves only that the frame was well formed
function awaitVerdict(protocol, timeoutMs = 900) {
  return new Promise((resolve) => {
    const done = (verdict) => {
      protocol.removeEventListener('port-feedback', onFeedback);
      protocol.removeEventListener('protocol-error', onError);
      clearTimeout(timer);
      resolve(verdict);
    };
    const onFeedback = (e) => { if (e.detail.port === PLAYVM_PORT) done({ ok: true }); };
    const onError = (e) => done({ ok: false, reason: `hub error ${e.detail.code}` });
    const timer = setTimeout(() => done({ ok: false, reason: 'no response' }), timeoutMs);
    protocol.addEventListener('port-feedback', onFeedback);
    protocol.addEventListener('protocol-error', onError);
  });
}

async function frame(protocol, port, label, speed, steer, lights) {
  log(`PLAYVM ${label}`);
  const verdict = awaitVerdict(protocol);
  await protocol.sendRaw(encodePlayVmFrame(port, speed, steer, lights));
  return verdict;
}

// Arms the port. Safe to repeat — the hub re-runs its calibration sweep.
export async function playVmInit(protocol, port = PLAYVM_PORT) {
  const cmd = await frame(protocol, port, 'init 1/2 COMMAND', 0, 0, PLAYVM_CMD.COMMAND);
  if (!cmd.ok) return cmd;
  await wait(300);
  const cal = await frame(protocol, port, 'init 2/2 CALIBRATE_STEERING', 0, 0, PLAYVM_CMD.CALIBRATE_STEERING);
  if (!cal.ok) return cal;
  // The rack sweeps end to end before it will accept a steering angle.
  await wait(2500);
  return { ok: true };
}
