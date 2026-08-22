// three.js attitude scene. WebGL-bound; all the maths lives in
// src/orientation.js. The CDN import is why this module is loaded lazily — a
// failure here has to leave the dashboard working.
//
// See docs/superpowers/specs/2026-07-30-motion-visualisation-design.md § The scene

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.185.1/build/three.module.min.js';
import { smoothingFactor } from './orientation.js';

const TAU_MS = 100;

function readToken(name, fallbackHex) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rgba = value.match(/rgba?\(([^)]+)\)/);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(',').map(Number);
    return { color: new THREE.Color(r / 255, g / 255, b / 255), alpha: a };
  }
  return { color: new THREE.Color(value || fallbackHex), alpha: 1 };
}

export function createMotionScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1.6, 0.1, 100);
  camera.position.set(2.4, 1.8, 3);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.5);
  key.position.set(3, 5, 4);
  scene.add(key);

  const line = readToken('--line', '#7f7f7f');
  const grid = new THREE.GridHelper(10, 10, line.color, line.color);
  grid.material.transparent = true;
  grid.material.opacity = line.alpha;
  scene.add(grid);

  const car = new THREE.Group();
  car.add(new THREE.Mesh(
    new THREE.BoxGeometry(2, 0.6, 1),
    new THREE.MeshStandardMaterial({ color: 0x4488cc })));
  const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 16);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
  for (const [x, z] of [[0.7, 0.6], [0.7, -0.6], [-0.7, 0.6], [-0.7, -0.6]]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(x, -0.3, z);
    car.add(wheel);
  }
  car.add(new THREE.AxesHelper(1.6));
  scene.add(car);

  const target = new THREE.Quaternion();
  let previous = 0;

  function resize() {
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 200;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return {
    start() {
      resize();
      previous = 0;
      renderer.setAnimationLoop((now) => {
        const dt = previous ? now - previous : 16;
        previous = now;
        car.quaternion.slerp(target, smoothingFactor(dt, TAU_MS));
        renderer.render(scene, camera);
      });
    },

    stop() { renderer.setAnimationLoop(null); },

    setOrientation(q) { if (q) target.set(q.x, q.y, q.z, q.w); },
  };
}
