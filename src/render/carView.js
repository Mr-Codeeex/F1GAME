// Procedural open-wheel race car model with team livery, steerable wheels, compound-coloured
// sidewalls, DRS flap, rain light, brake glow, and a safety car variant.
// Local frame: +X forward, +Y up, +Z right.
import * as THREE from '../../vendor/three.module.min.js';
import { COMPOUNDS } from '../sim/tyres.js';

function merge(parts) {
  // parts: [geometry with transform already applied]
  let total = 0;
  const geoms = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of geoms) total += g.getAttribute('position').count;
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of geoms) {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    pos.set(g.getAttribute('position').array, o * 3);
    nrm.set(g.getAttribute('normal').array, o * 3);
    o += g.getAttribute('position').count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return out;
}

function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/** tapered box: length along X, front (x+) width/height scaled */
function taper(len, w0, h0, w1, h1, x, y, z, yShift1 = 0) {
  const g = new THREE.BoxGeometry(len, 1, 1);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const front = p.getX(i) > 0;
    const w = front ? w1 : w0, h = front ? h1 : h0;
    p.setY(i, p.getY(i) * h + (front ? yShift1 : 0));
    p.setZ(i, p.getZ(i) * w);
  }
  g.computeVertexNormals();
  g.translate(x, y, z);
  return g;
}

let SHARED = null;
function sharedGeometry() {
  if (SHARED) return SHARED;
  // primary livery colour
  const body = merge([
    taper(2.3, 0.86, 0.55, 0.62, 0.42, 0.25, 0.42, 0), // tub
    taper(1.45, 0.5, 0.3, 0.16, 0.14, 2.05, 0.36, 0, -0.08), // nose
    taper(1.6, 0.56, 0.45, 0.62, 0.5, -0.05, 0.38, 0.62), // sidepod R
    taper(1.6, 0.56, 0.45, 0.62, 0.5, -0.05, 0.38, -0.62), // sidepod L
    taper(2.1, 0.28, 0.32, 0.62, 0.62, -1.15, 0.62, 0, 0.02), // engine cover
    box(0.3, 0.28, 0.3, -0.25, 0.98, 0), // airbox
  ]);
  // accent colour
  const accent = merge([
    box(0.32, 0.02, 1.9, 2.72, 0.13, 0), // front wing main plane
    box(0.2, 0.02, 1.8, 2.62, 0.2, 0, 0, 0, 0.35),
    box(0.4, 0.3, 0.03, 2.65, 0.22, 0.95), box(0.4, 0.3, 0.03, 2.65, 0.22, -0.95), // endplates
    box(0.45, 0.06, 0.96, -2.4, 0.92, 0), // rear wing main plane
    box(0.7, 0.75, 0.03, -2.35, 0.75, 0.48), box(0.7, 0.75, 0.03, -2.35, 0.75, -0.48), // rear endplates
    box(1.1, 0.3, 0.025, -1.45, 0.92, 0), // shark fin
    box(0.5, 0.06, 0.66, 0.85, 0.66, 0), // cockpit rim stripe
  ]);
  // carbon / black parts
  const carbon = merge([
    box(3.9, 0.05, 1.45, -0.15, 0.06, 0), // floor
    box(0.6, 0.18, 1.0, -2.05, 0.15, 0, 0, 0, -0.35), // diffuser
    box(0.1, 0.55, 0.12, -2.25, 0.5, 0), // wing pillar
    box(1.3, 0.04, 0.05, 1.85, 0.32, 0.55, 0, -0.35, 0), box(1.3, 0.04, 0.05, 1.85, 0.32, -0.55, 0, 0.35, 0), // front wishbones
    box(1.1, 0.04, 0.05, 1.85, 0.42, 0.55, 0, -0.35, 0.05), box(1.1, 0.04, 0.05, 1.85, 0.42, -0.55, 0, 0.35, 0.05),
    box(0.9, 0.04, 0.05, -1.75, 0.3, 0.45, 0, 0.5, 0), box(0.9, 0.04, 0.05, -1.75, 0.3, -0.45, 0, -0.5, 0), // rear arms
    box(0.9, 0.04, 0.05, -1.75, 0.45, 0.45, 0, 0.5, 0), box(0.9, 0.04, 0.05, -1.75, 0.45, -0.45, 0, -0.5, 0),
  ]);
  // halo
  const haloTorus = new THREE.TorusGeometry(0.42, 0.035, 6, 18, Math.PI);
  haloTorus.rotateX(Math.PI / 2);
  haloTorus.rotateY(Math.PI / 2);
  haloTorus.translate(0.15, 0.82, 0);
  const halo = merge([haloTorus, box(0.05, 0.36, 0.06, 0.62, 0.68, 0, 0, 0, -0.5)]);
  const helmet = new THREE.SphereGeometry(0.16, 14, 10);
  helmet.translate(0.18, 0.72, 0);
  const visor = new THREE.SphereGeometry(0.165, 14, 6, -Math.PI / 3, Math.PI * 2 / 3, Math.PI / 2.6, Math.PI / 5);
  visor.translate(0.18, 0.72, 0);
  const flap = box(0.22, 0.03, 0.94, 0, 0, 0);
  const tyreF = new THREE.CylinderGeometry(0.36, 0.36, 0.32, 22, 1);
  tyreF.rotateX(Math.PI / 2);
  const tyreR = new THREE.CylinderGeometry(0.36, 0.36, 0.42, 22, 1);
  tyreR.rotateX(Math.PI / 2);
  const ringF = new THREE.TorusGeometry(0.29, 0.012, 4, 24); ringF.translate(0, 0, 0.165);
  const ringR = new THREE.TorusGeometry(0.29, 0.012, 4, 24); ringR.translate(0, 0, 0.215);
  const rimF = new THREE.CylinderGeometry(0.22, 0.22, 0.34, 10); rimF.rotateX(Math.PI / 2);
  const rimR = new THREE.CylinderGeometry(0.22, 0.22, 0.44, 10); rimR.rotateX(Math.PI / 2);
  const disc = new THREE.CircleGeometry(0.16, 12); disc.translate(0, 0, -0.18);
  const rainLight = box(0.04, 0.08, 0.14, -2.6, 0.32, 0);
  const shadow = new THREE.PlaneGeometry(5.4, 2.1); shadow.rotateX(-Math.PI / 2); shadow.translate(-0.1, 0.07, 0);
  SHARED = { body, accent, carbon, halo, helmet, visor, flap, tyreF, tyreR, ringF, ringR, rimF, rimR, disc, rainLight, shadow };
  return SHARED;
}

const carbonMat = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.45, metalness: 0.3 });
const tyreMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 });
const rimMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.35, metalness: 0.8 });
const visorMat = new THREE.MeshStandardMaterial({ color: 0x111820, roughness: 0.1, metalness: 0.9 });
const compoundMats = {};
function compoundMat(c) {
  if (!compoundMats[c]) compoundMats[c] = new THREE.MeshStandardMaterial({ color: COMPOUNDS[c]?.color ?? '#ffffff', roughness: 0.5, emissive: COMPOUNDS[c]?.color ?? '#ffffff', emissiveIntensity: 0.15 });
  return compoundMats[c];
}

export class CarView {
  /** colors: [primary, secondary, tertiary] */
  constructor(colors, opts = {}) {
    const G = sharedGeometry();
    this.group = new THREE.Group();
    const envMap = opts.envMap ?? null;
    const paint = new THREE.MeshPhysicalMaterial({ color: colors[0], roughness: 0.28, metalness: 0.35, clearcoat: opts.lowDetail ? 0 : 0.8, clearcoatRoughness: 0.15, envMap, envMapIntensity: 0.9 });
    const accentM = new THREE.MeshStandardMaterial({ color: colors[1], roughness: 0.35, metalness: 0.25, envMap });
    const helmetM = new THREE.MeshStandardMaterial({ color: colors[2] ?? colors[1], roughness: 0.25, metalness: 0.2 });
    this.paint = paint;
    const add = (geo, mat, cast = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = cast; this.group.add(m); return m; };
    add(G.body, paint);
    add(G.accent, accentM);
    add(G.carbon, carbonMat);
    add(G.halo, carbonMat);
    add(G.helmet, helmetM);
    add(G.visor, visorMat, false);
    // DRS flap pivots at the leading edge
    this.flapPivot = new THREE.Group();
    this.flapPivot.position.set(-2.3, 1.03, 0);
    const flap = new THREE.Mesh(G.flap, accentM);
    flap.position.set(-0.1, 0, 0);
    flap.castShadow = true;
    this.flapPivot.add(flap);
    this.group.add(this.flapPivot);
    // rain light
    this.rainMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff0000, emissiveIntensity: 0 });
    add(G.rainLight, this.rainMat, false);
    // fake contact shadow for distant cars (cheap)
    if (opts.blobShadow !== false) {
      const sm = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
      const sh = new THREE.Mesh(G.shadow, sm);
      sh.renderOrder = 1;
      this.group.add(sh);
    }
    // wheels
    this.wheels = [];
    this.compound = 'M';
    this.discMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xff4400, emissiveIntensity: 0 });
    const spots = [[1.93, 0.36, -0.82, true], [1.93, 0.36, 0.82, true], [-1.67, 0.36, -0.78, false], [-1.67, 0.36, 0.78, false]];
    for (const [x, y, z, front] of spots) {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);
      const spin = new THREE.Group();
      const side = z > 0 ? 1 : -1;
      const tyre = new THREE.Mesh(front ? G.tyreF : G.tyreR, tyreMat);
      tyre.castShadow = true;
      const ring = new THREE.Mesh(front ? G.ringF : G.ringR, compoundMat('M'));
      ring.scale.z = side;
      const rim = new THREE.Mesh(front ? G.rimF : G.rimR, rimMat);
      const disc = new THREE.Mesh(G.disc, this.discMat);
      disc.scale.z = -side;
      spin.add(tyre, ring, rim, disc);
      pivot.add(spin);
      this.group.add(pivot);
      this.wheels.push({ pivot, spin, ring, front });
    }
    this.blinkT = 0;
  }

  setCompound(c) {
    if (c === this.compound) return;
    this.compound = c;
    for (const w of this.wheels) w.ring.material = compoundMat(c);
  }

  /** car: CarPhysics-like object */
  update(car, dt, opts = {}) {
    const g = this.group;
    g.position.set(car.x, 0, car.z);
    // yaw, then pitch about the local lateral axis, then roll about the local longitudinal axis
    g.rotation.set(-(car.roll ?? 0), -car.yaw, -(car.pitch ?? 0), 'YZX');
    g.position.y = opts.bounce ?? 0;
    const steer = car.steer ?? 0;
    for (const w of this.wheels) {
      w.pivot.rotation.y = w.front ? -steer : 0;
      w.spin.rotation.z = -(car.wheelRot ?? 0);
    }
    this.flapPivot.rotation.z = car.drsOpen ? 0.75 : 0;
    this.setCompound(car.tyres?.compound ?? 'M');
    // brake glow
    const glow = Math.min(1, (car.brakeIn ?? 0) * Math.max(0, car.vx - 20) / 50);
    this.discMat.emissiveIntensity += (glow * 3 - this.discMat.emissiveIntensity) * Math.min(1, dt * 3);
    // rain light blinks in the wet or in the pit lane (limiter)
    this.blinkT += dt;
    const on = (opts.wet || car.limiter || opts.sc) && Math.floor(this.blinkT * 4) % 2 === 0;
    this.rainMat.emissiveIntensity = on ? 4 : 0;
  }

  dispose() {
    this.paint.dispose();
  }
}

/** Safety car: a simple GT-style coupe with a light bar. */
export class SafetyCarView {
  constructor() {
    this.group = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.3, metalness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0b0f14, roughness: 0.1, metalness: 0.8 });
    const bodyG = merge([taper(4.6, 1.9, 0.75, 1.85, 0.55, 0, 0.55, 0), box(1.8, 0.5, 1.5, -0.4, 1.15, 0)]);
    const b = new THREE.Mesh(bodyG, paint); b.castShadow = true; this.group.add(b);
    const w = new THREE.Mesh(box(1.6, 0.45, 1.52, -0.35, 1.15, 0), glass); this.group.add(w);
    this.lightA = new THREE.MeshStandardMaterial({ color: 0x332200, emissive: 0xffaa00, emissiveIntensity: 0 });
    this.lightB = new THREE.MeshStandardMaterial({ color: 0x332200, emissive: 0xffaa00, emissiveIntensity: 0 });
    const la = new THREE.Mesh(box(0.25, 0.12, 0.5, -0.4, 1.46, -0.35), this.lightA);
    const lb = new THREE.Mesh(box(0.25, 0.12, 0.5, -0.4, 1.46, 0.35), this.lightB);
    this.group.add(la, lb);
    const tg = new THREE.CylinderGeometry(0.33, 0.33, 0.26, 16); tg.rotateX(Math.PI / 2);
    this.wheels = [];
    for (const [x, z] of [[1.45, -0.85], [1.45, 0.85], [-1.45, -0.85], [-1.45, 0.85]]) {
      const m = new THREE.Mesh(tg, tyreMat); m.position.set(x, 0.33, z); this.group.add(m); this.wheels.push(m);
    }
    this.t = 0;
  }
  update(car, dt) {
    this.t += dt;
    this.group.position.set(car.x, 0, car.z);
    this.group.rotation.set(0, -car.yaw, 0);
    const ph = Math.floor(this.t * 5) % 2;
    this.lightA.emissiveIntensity = ph ? 5 : 0;
    this.lightB.emissiveIntensity = ph ? 0 : 5;
    for (const w of this.wheels) w.rotation.z = -(car.wheelRot ?? 0);
  }
}
