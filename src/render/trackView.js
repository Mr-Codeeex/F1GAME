// Builds the 3D circuit: road, kerbs, run-off, barriers, pit complex, grandstands, gantry,
// marshal light panels, scenery and the racing-line assist ribbon.
import * as THREE from '../../vendor/three.module.min.js';
import { KERB_WIDTH } from '../sim/track.js';
import { makeRng, smoothstep } from '../sim/util.js';
import { TEAMS } from '../data/teams.js';

/** Build a ribbon between lateral offsets d1(i) and d2(i) over sample indices [i0, i1] (inclusive, wraps). */
function ribbon(track, i0, count, d1, d2, y, opts = {}) {
  const n = track.n;
  const pos = [], uv = [], idx = [];
  const vScale = opts.vScale ?? 0.1;
  const uSpan = opts.uSpan ?? null;
  for (let k = 0; k <= count; k++) {
    const i = (i0 + k) % n;
    const a = d1(i), b = d2(i);
    const yy = typeof y === 'function' ? y(i) : y;
    pos.push(track.px[i] + track.rx[i] * a, yy, track.pz[i] + track.rz[i] * a);
    pos.push(track.px[i] + track.rx[i] * b, yy, track.pz[i] + track.rz[i] * b);
    const v = (i0 + k) * track.step * vScale;
    if (uSpan) { uv.push(0, v, 1, v); } else { uv.push(a * vScale, v, b * vScale, v); }
    if (k < count) {
      const j = k * 2;
      idx.push(j, j + 1, j + 2, j + 1, j + 3, j + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // ensure normals point up for flat ribbons
  if (!opts.vertical) {
    const nrm = g.getAttribute('normal');
    for (let k = 0; k < nrm.count; k++) nrm.setXYZ(k, 0, 1, 0);
  }
  return g;
}

/** Vertical wall ribbon at lateral offset d(i). */
function wall(track, i0, count, d, h, opts = {}) {
  const n = track.n;
  const pos = [], uv = [], idx = [];
  let u = 0;
  for (let k = 0; k <= count; k++) {
    const i = (i0 + k) % n;
    const dd = d(i);
    const x = track.px[i] + track.rx[i] * dd, z = track.pz[i] + track.rz[i] * dd;
    if (k > 0) { const p = pos.length - 6; u += Math.hypot(x - pos[p], z - pos[p + 2]) / (opts.uLen ?? 8); }
    pos.push(x, 0, z, x, h, z);
    uv.push(u, 0, u, 1);
    if (k < count) { const j = k * 2; idx.push(j, j + 2, j + 1, j + 1, j + 2, j + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Split sample indices into contiguous runs where pred(i) is true. Returns [[start, count], ...] */
function runs(n, pred) {
  const out = [];
  let start = -1;
  // find a starting point where pred is false to handle wrap
  let off = 0;
  while (off < n && pred(off)) off++;
  if (off === n) return [[0, n]];
  for (let k = 0; k <= n; k++) {
    const i = (off + k) % n;
    const p = k < n && pred(i);
    if (p && start < 0) start = k;
    if (!p && start >= 0) { out.push([(off + start) % n, k - start]); start = -1; }
  }
  return out;
}

export class TrackView {
  constructor(track, textures, opts = {}) {
    this.track = track;
    this.T = textures;
    this.quality = opts.quality ?? 'high';
    this.group = new THREE.Group();
    this.theme = track.def.theme;
    this.rng = makeRng(track.id.length * 977 + 13);
    this.flagMats = [];
    this.build();
  }

  mat(map, opts = {}) {
    return new THREE.MeshStandardMaterial({ map, roughness: opts.roughness ?? 0.9, metalness: 0, color: opts.color ?? 0xffffff, side: opts.side ?? THREE.FrontSide, polygonOffset: opts.po != null, polygonOffsetFactor: opts.po ?? 0, polygonOffsetUnits: opts.po ?? 0, transparent: !!opts.transparent, alphaTest: opts.alphaTest ?? 0 });
  }

  add(geom, material, shadow = { cast: false, receive: true }) {
    const m = new THREE.Mesh(geom, material);
    m.castShadow = shadow.cast; m.receiveShadow = shadow.receive;
    this.group.add(m);
    return m;
  }

  build() {
    const t = this.track, T = this.T, n = t.n, hw = t.halfWidth;
    const b = t.bounds();
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 3000;
    this.center = new THREE.Vector3(cx, 0, cz);
    this.radius = size / 2;

    // ground
    const groundTex = T.grass.clone(); groundTex.needsUpdate = true;
    groundTex.repeat.set(size / 24, size / 24);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.mat(groundTex, { roughness: 1, po: 6 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(cx, -0.3, cz);
    ground.receiveShadow = true;
    this.group.add(ground);
    this.ground = ground;

    // water for coastal / tropical themes
    if (this.theme === 'coastal' || this.theme === 'tropical' || this.theme === 'city') {
      const wt = T.water.clone(); wt.needsUpdate = true; wt.repeat.set(60, 20);
      const water = new THREE.Mesh(new THREE.PlaneGeometry(size * 1.5, 1500), new THREE.MeshStandardMaterial({ map: wt, roughness: 0.15, metalness: 0.3 }));
      water.rotation.x = -Math.PI / 2;
      water.position.set(cx, -0.25, b.minZ - 400 - 750);
      this.group.add(water);
      this.water = water;
    }

    // road
    const road = ribbon(t, 0, n, () => -hw - 0.3, () => hw + 0.3, 0, { vScale: 0.08 });
    this.roadMat = this.mat(T.asphalt, { roughness: 0.82, po: -1 });
    this.add(road, this.roadMat);

    // edge lines
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.add(ribbon(t, 0, n, () => -hw + 0.1, () => -hw + 0.32, 0.03), lineMat);
    this.add(ribbon(t, 0, n, () => hw - 0.32, () => hw - 0.1, 0.03), lineMat);

    // kerbs
    const kerbMat = this.mat(T.kerb, { roughness: 0.7, po: -3 });
    for (const [i0, c] of runs(n, (i) => t.kerbL[i] === 1)) this.add(ribbon(t, i0, c, () => -hw - KERB_WIDTH, () => -hw + 0.05, 0.05, { vScale: 0.25, uSpan: true }), kerbMat);
    for (const [i0, c] of runs(n, (i) => t.kerbR[i] === 1)) this.add(ribbon(t, i0, c, () => hw - 0.05, () => hw + KERB_WIDTH, 0.05, { vScale: 0.25, uSpan: true }), kerbMat);

    // run-off surfaces (gravel / asphalt), grass is the ground
    const gravelMat = this.mat(T.gravel, { po: -1 });
    const runoffMat = this.mat(T.runoff, { roughness: 0.85, po: -1 });
    for (const side of [-1, 1]) {
      const type = side < 0 ? t.runTypeL : t.runTypeR;
      const kerb = side < 0 ? t.kerbL : t.kerbR;
      const inner = (i) => side * (hw + (kerb[i] ? KERB_WIDTH : 0.3));
      const outer = (i) => side * (hw + (side < 0 ? t.runL[i] : t.runR[i]));
      for (const tp of [1, 2]) {
        for (const [i0, c] of runs(n, (i) => type[i] === tp)) {
          const g = side < 0 ? ribbon(t, i0, c, outer, inner, -0.06, { vScale: 0.1 }) : ribbon(t, i0, c, inner, outer, -0.06, { vScale: 0.1 });
          this.add(g, tp === 1 ? gravelMat : runoffMat);
        }
      }
    }

    // barriers
    const street = t.def.runoff === 'street';
    const barrierMat = this.mat(street ? T.streetWall : T.barrier, { roughness: 0.8, side: THREE.DoubleSide, transparent: street, alphaTest: street ? 0.3 : 0 });
    const wallH = street ? 3.2 : 1.1;
    this.add(wall(t, 0, n, (i) => -(hw + t.runL[i] + 0.4), wallH, { uLen: street ? 6 : 12 }), barrierMat, { cast: true, receive: true });
    this.add(wall(t, 0, n, (i) => hw + t.runR[i] + 0.4, wallH, { uLen: street ? 6 : 12 }), barrierMat, { cast: true, receive: true });

    this.buildPit();
    this.buildStartLine();
    this.buildGantry();
    this.buildGrandstands();
    this.buildMarshals();
    this.buildBoards();
    this.buildScenery();
    this.buildRacingLine();
  }

  sIdx(s) { return this.track.sampleIndex(s); }

  buildPit() {
    const t = this.track, T = this.T, hw = t.halfWidth, pt = t.pit;
    const i0 = this.sIdx(pt.entryS);
    const count = Math.round(pt.length / t.step);
    const lane = (i) => t.pitLaneOffset(t.pitProgress(i * t.step));
    // pit lane surface
    const pitMat = this.mat(T.asphalt, { roughness: 0.75, color: 0xb8b8b8, po: -1 });
    this.add(ribbon(t, i0, count, () => hw + 0.3, (i) => Math.max(hw + 0.3, lane(i) + 4.8), -0.03, { vScale: 0.08 }), pitMat);
    // pit lane lines
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const limS = this.sIdx(pt.entryS + pt.limitStart), limCount = Math.round((pt.limitEnd - pt.limitStart) / t.step);
    this.add(ribbon(t, limS, limCount, (i) => lane(i) + 2.0, (i) => lane(i) + 2.2, 0.02), lineMat);
    // pit wall
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.6, side: THREE.DoubleSide });
    for (const [a, c] of runs(t.n, (i) => t.hasPitWall(i * t.step))) {
      this.add(wall(t, a, c, () => pt.wallOffset - 0.25, 1.05), wallMat, { cast: true, receive: true });
      this.add(wall(t, a, c, () => pt.wallOffset + 0.25, 1.05), wallMat, { cast: true, receive: true });
      // fence on top
      const fenceMat = new THREE.MeshStandardMaterial({ color: 0x777777, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
      const fg = wall(t, a, c, () => pt.wallOffset, 2.2);
      fg.translate(0, 1.05, 0);
      this.add(fg, fenceMat);
    }
    // team boxes
    for (let k = 0; k < TEAMS.length; k++) {
      const ps = t.boxProgress(k);
      const s = pt.entryS + ps;
      const p = t.toWorld(s, pt.boxOffset);
      const box = new THREE.Mesh(new THREE.PlaneGeometry(8, 4), new THREE.MeshStandardMaterial({ color: TEAMS[k].colors[0], roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, transparent: true, opacity: 0.55 }));
      box.rotation.x = -Math.PI / 2;
      box.rotation.z = -p.heading;
      box.position.set(p.x, 0.02, p.z);
      this.group.add(box);
    }
    // garage building beyond the pit lane
    const gStart = pt.entryS + pt.boxStart - 20, gEnd = pt.entryS + t.boxProgress(TEAMS.length - 1) + 25;
    const pa = t.toWorld(gStart, pt.laneOffset + 17), pb = t.toWorld(gEnd, pt.laneOffset + 17);
    const len = Math.hypot(pb.x - pa.x, pb.z - pa.z);
    const bld = new THREE.Mesh(new THREE.BoxGeometry(len, 9, 14), [
      new THREE.MeshStandardMaterial({ color: 0xdedede }), new THREE.MeshStandardMaterial({ color: 0xdedede }),
      new THREE.MeshStandardMaterial({ color: 0x9aa0a6 }), new THREE.MeshStandardMaterial({ color: 0xdedede }),
      new THREE.MeshStandardMaterial({ color: 0xcfd3d6 }), new THREE.MeshStandardMaterial({ color: 0xcfd3d6 }),
    ]);
    bld.position.set((pa.x + pb.x) / 2, 4.5, (pa.z + pb.z) / 2);
    bld.rotation.y = -Math.atan2(pb.z - pa.z, pb.x - pa.x);
    bld.castShadow = true; bld.receiveShadow = true;
    this.group.add(bld);
    // garage doors (team colours) facing the lane
    for (let k = 0; k < TEAMS.length; k++) {
      const s = pt.entryS + t.boxProgress(k);
      const p = t.toWorld(s, pt.laneOffset + 9.9);
      const door = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), new THREE.MeshStandardMaterial({ color: TEAMS[k].colors[0], roughness: 0.5, emissive: new THREE.Color(TEAMS[k].colors[0]), emissiveIntensity: 0.15 }));
      door.position.set(p.x, 2.6, p.z);
      door.rotation.y = -p.heading + Math.PI;
      door.lookAt(t.toWorld(s, 0).x, 2.6, t.toWorld(s, 0).z);
      this.group.add(door);
    }
    // pit roof hospitality block
    const roof = new THREE.Mesh(new THREE.BoxGeometry(len, 1.2, 18), new THREE.MeshStandardMaterial({ color: 0x23272b }));
    roof.position.set(bld.position.x, 9.6, bld.position.z);
    roof.rotation.y = bld.rotation.y;
    this.group.add(roof);
  }

  buildStartLine() {
    const t = this.track, hw = t.halfWidth;
    const i = this.sIdx(0);
    const g = ribbon(t, i, 1, () => -hw, () => hw, 0.035, { vScale: 0.5 });
    const ct = this.T.checker.clone(); ct.needsUpdate = true; ct.repeat.set(1, 1);
    this.add(g, new THREE.MeshStandardMaterial({ map: ct, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    // grid boxes
    const gm = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    for (let k = 0; k < 20; k++) {
      const slot = t.gridSlot(k);
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 2.2), gm);
      const f = t.toWorld(slot.s + 2.9, slot.d);
      bar.rotation.x = -Math.PI / 2;
      bar.rotation.z = -slot.heading;
      bar.position.set(f.x, 0.035, f.z);
      this.group.add(bar);
    }
    // DRS detection / activation lines
    for (const z of t.drsZones) {
      for (const s of [z.detect, z.start]) {
        const ii = this.sIdx(s);
        this.add(ribbon(t, ii, 1, () => -t.halfWidth, () => t.halfWidth, 0.035, { vScale: 0.1 }), new THREE.MeshStandardMaterial({ color: s === z.detect ? 0xffffff : 0x33ff66, transparent: true, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
      }
    }
  }

  buildGantry() {
    const t = this.track, hw = t.halfWidth;
    const s = 18;
    const L = t.toWorld(s, -hw - 3), R = t.toWorld(s, hw + 3), M = t.toWorld(s, 0);
    const metal = new THREE.MeshStandardMaterial({ color: 0x30343a, metalness: 0.6, roughness: 0.4 });
    const g = new THREE.Group();
    const span = Math.hypot(R.x - L.x, R.z - L.z);
    for (const P of [L, R]) {
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.6, 8, 0.6), metal);
      pole.position.set(P.x, 4, P.z);
      pole.castShadow = true;
      g.add(pole);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 1.6, 0.8), metal);
    beam.position.set(M.x, 7.3, M.z);
    beam.rotation.y = -Math.atan2(R.z - L.z, R.x - L.x);
    beam.castShadow = true;
    g.add(beam);
    // 5 light pairs facing the grid (towards -s)
    this.lightMats = [];
    const back = t.toWorld(s - 1, 0);
    const dirx = back.x - M.x, dirz = back.z - M.z;
    const dl = Math.hypot(dirx, dirz);
    for (let k = 0; k < 5; k++) {
      const m = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff0000, emissiveIntensity: 0 });
      this.lightMats.push(m);
      for (const row of [0, 1]) {
        const off = (k - 2) * 1.2;
        const P = t.toWorld(s, off);
        const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.32, 16), m);
        bulb.position.set(P.x + (dirx / dl) * 0.45, 7.7 - row * 0.8, P.z + (dirz / dl) * 0.45);
        bulb.lookAt(P.x + dirx * 10, 7.7 - row * 0.8, P.z + dirz * 10);
        g.add(bulb);
      }
    }
    this.group.add(g);
  }

  setLights(n) {
    if (!this.lightMats) return;
    this.lightMats.forEach((m, k) => { m.emissiveIntensity = k < n ? 3 : 0; m.color.set(k < n ? 0xff2020 : 0x220000); });
  }

  buildGrandstands() {
    const t = this.track, T = this.T;
    const crowdMat = new THREE.MeshStandardMaterial({ map: T.crowd, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.6, side: THREE.DoubleSide });
    const make = (s0, s1, side) => {
      const i0 = this.sIdx(s0), count = Math.round(t.wrapS(s1 - s0) / t.step);
      const run = (i) => t.halfWidth + (side < 0 ? t.runL[i] : t.runR[i]);
      const pos = [], uv = [], idx = [];
      for (let k = 0; k <= count; k++) {
        const i = (i0 + k) % t.n;
        const d0 = side * (run(i) + 3), d1 = side * (run(i) + 18);
        const x0 = t.px[i] + t.rx[i] * d0, z0 = t.pz[i] + t.rz[i] * d0;
        const x1 = t.px[i] + t.rx[i] * d1, z1 = t.pz[i] + t.rz[i] * d1;
        pos.push(x0, 1.5, z0, x1, 12, z1);
        const u = k * t.step / 12;
        uv.push(u, 0, u, 2);
        if (k < count) { const j = k * 2; if (side < 0) idx.push(j, j + 1, j + 2, j + 1, j + 3, j + 2); else idx.push(j, j + 2, j + 1, j + 1, j + 2, j + 3); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, crowdMat);
      m.receiveShadow = true;
      this.group.add(m);
      // back wall + roof
      const roof = wall(t, i0, count, (i) => side * (run(i) + 19), 15);
      this.add(roof, roofMat, { cast: true, receive: true });
      const top = ribbon(t, i0, count, (i) => side * (run(i) + 2), (i) => side * (run(i) + 19), 15.5);
      if (side > 0) this.add(top, roofMat, { cast: true, receive: false });
      else { const tp = ribbon(t, i0, count, (i) => side * (run(i) + 19), (i) => side * (run(i) + 2), 15.5); this.add(tp, roofMat, { cast: true, receive: false }); }
    };
    // main straight, opposite the pits
    make(-260, 180, -1);
    // a stand at the outside of the biggest braking zones
    const corners = [...t.corners].sort((a, b) => a.radius - b.radius).slice(0, 3);
    for (const c of corners) {
      const side = -c.dir; // outside of the corner
      const s0 = c.startS - 80, s1 = c.s + 40;
      const pitHit = t.pitProgress(s0) >= 0 || t.pitProgress(s1) >= 0;
      if (!pitHit) make(s0, s1, side);
    }
  }

  buildMarshals() {
    const t = this.track;
    this.flagMats = [0, 1, 2].map(() => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x00ff44, emissiveIntensity: 0 }));
    const postMat = new THREE.MeshStandardMaterial({ color: 0x555555 });
    const geomPost = new THREE.BoxGeometry(0.15, 2.4, 0.15);
    const geomPanel = new THREE.BoxGeometry(0.1, 0.8, 1.2);
    for (let s = 60; s < t.length; s += 190) {
      if (t.pitProgress(s) >= 0) continue;
      const side = -1;
      const d = side * (t.barrierAt(s, side) + 1.2);
      const p = t.toWorld(s, d);
      const post = new THREE.Mesh(geomPost, postMat);
      post.position.set(p.x, 1.2, p.z);
      this.group.add(post);
      const panel = new THREE.Mesh(geomPanel, this.flagMats[t.sectorOf(s)]);
      panel.position.set(p.x, 2.4, p.z);
      panel.rotation.y = -p.heading;
      this.group.add(panel);
    }
  }

  setFlags(flags) {
    for (let k = 0; k < 3; k++) {
      const m = this.flagMats[k];
      if (!m) continue;
      let col = null;
      if (flags.sc || flags.vsc) col = 0xffcc00;
      else if (flags.sector[k]) col = 0xffdd00;
      else if (flags.chequered) col = 0xffffff;
      if (col == null) { m.emissiveIntensity = 0.0; continue; }
      m.emissive.set(col);
      m.emissiveIntensity = flags.sector[k] === 'double' || flags.sc ? (Math.floor(performance.now() / 300) % 2 ? 2.5 : 0.2) : 2;
    }
  }

  buildBoards() {
    const t = this.track;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
    const geo = new THREE.BoxGeometry(0.1, 1.0, 0.9);
    for (const c of t.corners) {
      if (c.radius > 90) continue;
      for (const d of [150, 100, 50]) {
        const s = c.startS - d;
        if (t.pitProgress(s) >= 0) continue;
        const side = c.dir > 0 ? -1 : 1;
        const p = t.toWorld(s, side * (t.halfWidth + 3.5));
        const b = new THREE.Mesh(geo, mat);
        b.position.set(p.x, 0.9, p.z);
        b.rotation.y = -p.heading;
        this.group.add(b);
      }
    }
  }

  buildScenery() {
    const t = this.track, rng = this.rng;
    const b = t.bounds();
    // occupancy grid near the track to keep scenery away
    const cell = 20;
    const gx0 = b.minX - 700, gz0 = b.minZ - 700;
    const W = Math.ceil((b.maxX - b.minX + 1400) / cell), H = Math.ceil((b.maxZ - b.minZ + 1400) / cell);
    const occ = new Uint8Array(W * H);
    for (let i = 0; i < t.n; i += 2) {
      const r = Math.max(t.runL[i], t.runR[i]) + t.halfWidth + 28;
      const rc = Math.ceil(r / cell);
      const cx = Math.floor((t.px[i] - gx0) / cell), cz = Math.floor((t.pz[i] - gz0) / cell);
      for (let dz = -rc; dz <= rc; dz++) for (let dx = -rc; dx <= rc; dx++) {
        const x = cx + dx, z = cz + dz;
        if (x >= 0 && z >= 0 && x < W && z < H && dx * dx + dz * dz <= rc * rc) occ[z * W + x] = 1;
      }
    }
    // keep the pit building clear
    const free = (x, z) => {
      const cx = Math.floor((x - gx0) / cell), cz = Math.floor((z - gz0) / cell);
      if (cx < 0 || cz < 0 || cx >= W || cz >= H) return true;
      return !occ[cz * W + cx];
    };
    const q = this.quality === 'low' ? 0.35 : this.quality === 'medium' ? 0.65 : 1;
    const theme = this.theme;
    const kinds = {
      coastal: [['palm', 260], ['broad', 220]],
      desert: [['rock', 260], ['cactus', 160]],
      forest: [['pine', 1100], ['broad', 300]],
      city: [['building', 300], ['broad', 120]],
      alpine: [['pine', 800], ['rock', 120]],
      tropical: [['palm', 500], ['broad', 500]],
    }[theme] ?? [['broad', 400]];
    const place = (count, near = 900) => {
      const out = [];
      let tries = 0;
      while (out.length < count && tries < count * 20) {
        tries++;
        const x = b.minX - near + rng() * (b.maxX - b.minX + near * 2);
        const z = b.minZ - near + rng() * (b.maxZ - b.minZ + near * 2);
        if (!free(x, z)) continue;
        if (this.water && z < b.minZ - 400) continue;
        out.push([x, z]);
      }
      return out;
    };
    const dummy = new THREE.Object3D();
    const addInstanced = (geo, mat, pts, scaleFn, yFn = () => 0, rotRand = true) => {
      if (!pts.length) return;
      const im = new THREE.InstancedMesh(geo, mat, pts.length);
      pts.forEach(([x, z], k) => {
        const sc = scaleFn(k);
        dummy.position.set(x, yFn(sc), z);
        dummy.rotation.set(0, rotRand ? rng() * Math.PI * 2 : 0, 0);
        dummy.scale.set(sc[0], sc[1], sc[2]);
        dummy.updateMatrix();
        im.setMatrixAt(k, dummy.matrix);
      });
      im.castShadow = this.quality === 'high';
      im.receiveShadow = false;
      this.group.add(im);
    };
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 1 });
    for (const [kind, count0] of kinds) {
      const count = Math.round(count0 * q);
      const pts = place(count);
      const scales = pts.map(() => 0.7 + rng() * 0.8);
      if (kind === 'pine') {
        const green = new THREE.MeshStandardMaterial({ color: theme === 'alpine' ? 0x2c4a32 : 0x2f5a2c, roughness: 1, flatShading: true });
        addInstanced(new THREE.ConeGeometry(3.2, 13, 7).translate(0, 9, 0), green, pts, (k) => [scales[k], scales[k], scales[k]]);
        addInstanced(new THREE.CylinderGeometry(0.35, 0.45, 3, 5).translate(0, 1.5, 0), trunkMat, pts, (k) => [scales[k], scales[k], scales[k]]);
      } else if (kind === 'broad') {
        const green = new THREE.MeshStandardMaterial({ color: theme === 'tropical' ? 0x2e6b2a : 0x3f6e30, roughness: 1, flatShading: true });
        addInstanced(new THREE.IcosahedronGeometry(4, 0).translate(0, 7, 0), green, pts, (k) => [scales[k], scales[k] * 0.9, scales[k]]);
        addInstanced(new THREE.CylinderGeometry(0.4, 0.55, 4, 5).translate(0, 2, 0), trunkMat, pts, (k) => [scales[k], scales[k], scales[k]]);
      } else if (kind === 'palm') {
        const leaf = new THREE.MeshStandardMaterial({ color: 0x3d7a2c, roughness: 1, flatShading: true, side: THREE.DoubleSide });
        addInstanced(new THREE.ConeGeometry(4.5, 1.6, 8, 1, true).translate(0, 10.5, 0), leaf, pts, (k) => [scales[k], scales[k], scales[k]]);
        addInstanced(new THREE.CylinderGeometry(0.25, 0.4, 10, 5).translate(0, 5, 0), trunkMat, pts, (k) => [scales[k], scales[k], scales[k]]);
      } else if (kind === 'rock') {
        const rock = new THREE.MeshStandardMaterial({ color: theme === 'desert' ? 0x9b6b43 : 0x7d7d7d, roughness: 1, flatShading: true });
        addInstanced(new THREE.DodecahedronGeometry(3, 0), rock, pts, (k) => [scales[k] * 1.5, scales[k], scales[k] * 1.2], (sc) => sc[1] * 1.2);
      } else if (kind === 'cactus') {
        const cm = new THREE.MeshStandardMaterial({ color: 0x4b6b35, roughness: 1, flatShading: true });
        addInstanced(new THREE.CylinderGeometry(0.4, 0.45, 5, 6).translate(0, 2.5, 0), cm, pts, (k) => [scales[k], scales[k], scales[k]]);
      } else if (kind === 'building') {
        const bm = new THREE.MeshStandardMaterial({ map: this.T.windows, roughness: 0.6, metalness: 0.2 });
        addInstanced(new THREE.BoxGeometry(30, 1, 30).translate(0, 0.5, 0), bm, pts, () => [0.6 + rng() * 1.2, 20 + rng() * 90, 0.6 + rng() * 1.2], () => 0);
      }
    }
    // distant mountains / skyline ring
    if (theme === 'alpine' || theme === 'desert' || theme === 'forest' || theme === 'tropical') {
      const mm = new THREE.MeshStandardMaterial({ color: theme === 'desert' ? 0xb07a4f : theme === 'alpine' ? 0x6d7f8f : 0x3d5a40, roughness: 1, flatShading: true });
      const snow = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 1, flatShading: true });
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      const R = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 1700;
      for (let k = 0; k < 26; k++) {
        const a = (k / 26) * Math.PI * 2 + rng() * 0.2;
        const h = 250 + rng() * (theme === 'alpine' ? 700 : 350);
        const r = h * (1.2 + rng());
        const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 6), mm);
        m.position.set(cx + Math.cos(a) * R * (1 + rng() * 0.3), h / 2 - 5, cz + Math.sin(a) * R * (1 + rng() * 0.3));
        this.group.add(m);
        if (theme === 'alpine' && h > 500) {
          const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.3, h * 0.3, 6), snow);
          cap.position.set(m.position.x, h - h * 0.15 - 5, m.position.z);
          this.group.add(cap);
        }
      }
    }
  }

  buildRacingLine() {
    const t = this.track, n = t.n;
    const pos = new Float32Array(n * 2 * 3);
    const col = new Float32Array(n * 2 * 4);
    const idx = [];
    for (let i = 0; i < n; i++) {
      const o = t.lineOff[i];
      const a = o - 0.35, b2 = o + 0.35;
      pos.set([t.px[i] + t.rx[i] * a, 0.06, t.pz[i] + t.rz[i] * a, t.px[i] + t.rx[i] * b2, 0.06, t.pz[i] + t.rz[i] * b2], i * 6);
      const j = i * 2, k = ((i + 1) % n) * 2;
      idx.push(j, j + 1, k, j + 1, k + 1, k);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    g.setIndex(idx);
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
    this.lineMesh = new THREE.Mesh(g, m);
    this.lineMesh.renderOrder = 2;
    this.lineMesh.visible = false;
    this.group.add(this.lineMesh);
  }

  /** Update racing-line colours ahead of the player. mode: off | corners | full */
  updateRacingLine(mode, car, profile) {
    const lm = this.lineMesh;
    lm.visible = mode !== 'off' && !!profile;
    if (!lm.visible) return;
    const t = this.track, n = t.n;
    const col = lm.geometry.getAttribute('color');
    const arr = col.array;
    arr.fill(0);
    const i0 = t.sampleIndex(car.trackPos.s);
    const v = Math.max(0, car.vx);
    const ahead = Math.round(260 / t.step);
    for (let k = -4; k < ahead; k++) {
      const i = (i0 + k + n) % n;
      const target = profile.v[i];
      const brakeNeeded = v - target;
      // colour: green = accelerate, yellow = lift, red = brake
      let r, g, bb;
      if (brakeNeeded > 6) { r = 1; g = 0.1; bb = 0.1; }
      else if (brakeNeeded > 1) { r = 1; g = 0.85; bb = 0.1; }
      else { r = 0.15; g = 1; bb = 0.3; }
      const isCorner = profile.v[i] < 75 || brakeNeeded > 1;
      const alpha = mode === 'corners' && !isCorner ? 0 : 0.55 * smoothstep(0, 12, k + 4) * (1 - smoothstep(ahead - 30, ahead, k));
      arr.set([r, g, bb, alpha, r, g, bb, alpha], i * 8);
    }
    col.needsUpdate = true;
  }

  setWet(w) {
    this.roadMat.roughness = 0.82 - 0.62 * w;
    this.roadMat.color.setScalar(1 - 0.35 * w);
    if (this.ground) this.ground.material.color.setScalar(1 - 0.2 * w);
  }
}
