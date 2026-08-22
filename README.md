# LEGO Technic Move Hub controller — Web Bluetooth

Drive LEGO® Technic™ models built around the **Technic Move Hub** (88019) from a
browser tab, with an Xbox or PlayStation controller if you have one. No app, no
install, no account, no extra hardware, and the hub's firmware is never touched.

**→ [move-hub.site](https://move-hub.site)** ·
[Controls guide](https://move-hub.site/guide)

The page talks to the hub directly over Web Bluetooth. Vanilla ES modules — no
build step, no framework, no runtime dependencies, one stylesheet.

## What it drives

The **Technic Move Hub**, which advertises over Bluetooth as `Technic Move`. It
has no external ports: two drive motors, a steering motor, six lamp outputs, an
RGB status LED, an accelerometer, a gyroscope, a tilt sensor and a gesture
sensor are all inside the brick, and it charges over USB-C.

| Set | |
|---|---|
| **42214** Lamborghini Revuelto Super Sports Car | developed and tested against this one — the revised hub, currently shipping |
| **42176** Porsche GT4 e-Performance Race Car | the set the hub debuted in, original revision |

Models rebuilt from those parts work too, as should newer sets carrying the same
hub.

Pybricks cannot be installed on this hub — its firmware update needs a password
LEGO has not published — and BrickController 2 does not list it. Neither of
those is a problem here: nothing is flashed and nothing is replaced. The browser
speaks the protocol the stock firmware already answers.

## What it does

- **Macros.** A text editor for short JavaScript programs that drive the hub
  on their own — sequence, repetition and sensor reads without a human at the
  controls, saved locally with export/import. Runs in a Web Worker against a
  fixed API; every rule (unsafe gating, one drive path per run, command
  duration ceilings, a live link check) is enforced on the main thread, not
  trusted to the script. See the [Controls guide](https://move-hub.site/guide#g-macros-tab)
  for the full method reference.
- **Gamepad driving.** Any pad the browser exposes through the Gamepad API —
  Xbox and PlayStation, Bluetooth or USB. Every action is remappable and the
  mapping persists.
- **Four drive behaviours.** The hub's own combined frame (one write carries
  speed, steering and lights, and the hub holds the steering angle), both motors
  linked, the two motors split across separate controls, or counter-rotated for
  a tracked build.
- **Touch controls** per motor, with brake or coast on release, chosen per motor.
- **Steering two ways.** Straight stick-to-power, or a closed loop holding an
  angle against live position feedback, with auto-return and a runaway cut-out.
- **Lights.** Six lamps individually, brightness, brake-light behaviour, and the
  RGB status LED.
- **Telemetry.** Battery, tilt, accelerometer, and a crash guard that cuts the
  motors on a sharp impact.
- **A live protocol log** — every byte in and out.

## Requirements

Web Bluetooth: Chrome or Edge on **Android, macOS, Windows or ChromeOS**. Safari
and Firefox do not implement it; on iOS every browser uses Safari's engine, so
an iPhone needs a Web Bluetooth browser such as Bluefy.

A secure context — HTTPS or `http://localhost`. `file://` cannot use Web
Bluetooth.

## Run it yourself

```
python3 -m http.server 8000     # then open http://localhost:8000
```

Deploy anywhere that serves static files. `vercel.json` carries the host rules
for move-hub.site and is harmless elsewhere.

Two third-party tags sit in the HTML for the hosted site: a Ko-fi overlay and
Vercel's analytics script. Delete both `<script>` tags if you self-host.

## Tests

```
node --test test/*.test.js
```

493 tests over the pure layers: encoders, decoders, control maths, the write
queue, the drive and steering controllers, the gamepad loop, the macro host and
worker, and a DOM-stub smoke test that exercises every panel. BLE, real gamepads
and hardware behaviour cannot run headless and were verified on the car.

## How the protocol was worked out

From the wire. The hub speaks LEGO Wireless Protocol 3.0 over a single GATT
characteristic; ports are discovered at runtime from the hub's own Hub Attached
I/O messages rather than from a hardcoded table.

The combined drive frame is thirteen bytes:

```
0d 00 81 36 11 51 00 03 00 <speed> <steer> <lights> 00
```

Four attempts to find it by writing failed. What settled it was asking the hub
to describe its own port modes (`0x21` / `0x22`) — and then noticing that the
lights field also carries two initialisation commands the hub requires before it
will accept any drive frame at all. An earlier version of this code masked those
exact bytes out on safety grounds, which is precisely why nothing worked.

Reference: [DanieleBenedettelli/TechnicMoveHub](https://github.com/DanieleBenedettelli/TechnicMoveHub)
· [LEGO's protocol docs](https://lego.github.io/lego-ble-wireless-protocol-docs/)

## Licence

MIT, see [LICENSE](LICENSE).

## Disclaimer

Unofficial and independent. Provided **as is, with no warranty of any kind** —
you use it entirely at your own risk. A moving model can damage itself, its
surroundings, or someone in the way.

LEGO® and Technic™ are trademarks of the LEGO Group, which does not sponsor,
authorise or endorse this project. Set names and numbers identify compatible
products only.
