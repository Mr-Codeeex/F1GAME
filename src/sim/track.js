// Track builder and spatial queries.
// Circuits are authored as "turtle" segments (straights + constant-radius arcs). The builder closes
// the loop exactly (one arc absorbs the heading error, two flagged straights absorb position error),
// smooths curvature transitions, resamples at a fixed step and pre-computes everything the physics,
// AI and renderer need: tangents, curvature, racing line, run-off, kerbs, pit lane, sectors, DRS.

import { clamp, smoothstep, TAU, wrapAngle } from './util.js';

export const SAMPLE_STEP = 2; // metres between samples
export const KERB_WIDTH = 1.6;

function walk(segments, startHeading = 0) {
  // returns end position/heading for given segments (no sampling)
  let x = 0, z = 0, h = startHeading;
  for (const seg of segments) {
    if (seg[0] === 'S') {
      x += Math.cos(h) * seg[1];
      z += Math.sin(h) * seg[1];
    } else {
      const dir = seg[0] === 'R' ? 1 : -1;
      const r = seg[1];
      const a = (seg[2] * Math.PI) / 180;
      // centre of the arc lies on the turning side
      const cx = x + -Math.sin(h) * r * dir;
      const cz = z + Math.cos(h) * r * dir;
      const h2 = h + a * dir;
      x = cx + Math.sin(h2) * r * dir;
      z = cz - Math.cos(h2) * r * dir;
      h = h2;
    }
  }
  return { x, z, h };
}

/**
 * Convert a polygon with filleted corners into turtle segments.
 * points: [[x, z, radius], ...] in order of travel. The lap starts at fraction `startT` along edge 0->1.
 * Returns { segments, edgeSeg } where edgeSeg[k] = index of the straight segment along edge k->k+1.
 */
export function polygonToSegments(points, startT = 0.5) {
  const n = points.length;
  const P = (k) => points[((k % n) + n) % n];
  const corner = (k) => {
    const [x0, z0] = P(k - 1), [x1, z1, r] = P(k), [x2, z2] = P(k + 1);
    const h1 = Math.atan2(z1 - z0, x1 - x0), h2 = Math.atan2(z2 - z1, x2 - x1);
    const turn = wrapAngle(h2 - h1);
    const tlen = r * Math.tan(Math.abs(turn) / 2);
    return { turn, tlen, r };
  };
  const C = points.map((_, k) => corner(k));
  const edgeLen = (k) => { const [x0, z0] = P(k), [x1, z1] = P(k + 1); return Math.hypot(x1 - x0, z1 - z0); };
  const segs = [];
  const edgeSeg = [];
  const straight = (k, from, to) => {
    const len = to - from;
    if (len < -0.5) throw new Error(`corner fillets overlap on edge ${k} (${len.toFixed(1)} m)`);
    segs.push(['S', Math.max(0.01, len)]);
  };
  const e0 = edgeLen(0);
  const startDist = e0 * startT;
  edgeSeg[0] = 0;
  straight(0, startDist, e0 - C[1 % n].tlen);
  for (let k = 1; k <= n; k++) {
    const c = C[k % n];
    segs.push([c.turn > 0 ? 'R' : 'L', c.r, (Math.abs(c.turn) * 180) / Math.PI]);
    if (k < n) {
      edgeSeg[k] = segs.length;
      straight(k, c.tlen, edgeLen(k) - C[(k + 1) % n].tlen);
    } else {
      straight(0, c.tlen, startDist);
    }
  }
  return { segments: segs, edgeSeg, startHeading: Math.atan2(P(1)[1] - P(0)[1], P(1)[0] - P(0)[0]) };
}

/** Close the loop: adjust the arc flagged 'close' for heading, and two straights flagged 'adj' for position. */
export function closeSegments(segments) {
  const segs = segments.map((s) => s.slice());
  // heading closure
  const total = segs.reduce((acc, s) => acc + (s[0] === 'R' ? s[2] : s[0] === 'L' ? -s[2] : 0), 0);
  const target = total >= 0 ? 360 : -360;
  let closeIdx = segs.findIndex((s) => s.includes('close'));
  if (closeIdx < 0) closeIdx = segs.findLastIndex((s) => s[0] !== 'S');
  const cs = segs[closeIdx];
  const delta = target - total;
  cs[2] += cs[0] === 'R' ? delta : -delta;
  // position closure: solve for length changes on two 'adj' straights
  const adj = [];
  segs.forEach((s, i) => { if (s[0] === 'S' && s.includes('adj')) adj.push(i); });
  if (adj.length >= 2) {
    const end0 = walk(segs);
    const probe = (i) => {
      const t = segs.map((s) => s.slice());
      t[i][1] += 1;
      const e = walk(t);
      return [e.x - end0.x, e.z - end0.z];
    };
    const [a, b] = [probe(adj[0]), probe(adj[1])];
    const det = a[0] * b[1] - a[1] * b[0];
    if (Math.abs(det) > 1e-6) {
      const ex = -end0.x, ez = -end0.z;
      const u = (ex * b[1] - ez * b[0]) / det;
      const v = (a[0] * ez - a[1] * ex) / det;
      segs[adj[0]][1] += u;
      segs[adj[1]][1] += v;
    }
  }
  return segs;
}

function sampleSegments(segs, step, x0 = 0, z0 = 0, h0 = 0) {
  const pts = [];
  const segStart = [];
  let x = x0, z = z0, h = h0, s = 0;
  for (const seg of segs) {
    segStart.push(s);
    if (seg[0] === 'S') {
      const n = Math.max(1, Math.round(seg[1] / step));
      for (let k = 0; k < n; k++) {
        pts.push([x + Math.cos(h) * (seg[1] * k) / n, z + Math.sin(h) * (seg[1] * k) / n]);
      }
      x += Math.cos(h) * seg[1];
      z += Math.sin(h) * seg[1];
      s += seg[1];
    } else {
      const dir = seg[0] === 'R' ? 1 : -1;
      const r = seg[1];
      const a = (seg[2] * Math.PI) / 180;
      const cx = x + -Math.sin(h) * r * dir;
      const cz = z + Math.cos(h) * r * dir;
      const len = r * a;
      const n = Math.max(2, Math.round(len / step));
      for (let k = 0; k < n; k++) {
        const hh = h + (a * dir * k) / n;
        pts.push([cx + Math.sin(hh) * r * dir, cz - Math.cos(hh) * r * dir]);
      }
      h += a * dir;
      x = cx + Math.sin(h) * r * dir;
      z = cz - Math.cos(h) * r * dir;
      s += len;
    }
  }
  return { pts, segStart, rawLength: s };
}

function circularSmooth(arr, radius, passes = 1) {
  const n = arr.length;
  let a = Float64Array.from(arr);
  for (let p = 0; p < passes; p++) {
    const out = new Float64Array(n);
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += a[(k + n) % n];
    for (let i = 0; i < n; i++) {
      out[i] = acc / (2 * radius + 1);
      acc += a[(i + radius + 1) % n] - a[(i - radius + n) % n];
    }
    a = out;
  }
  return a;
}

function circularMax(arr, radius) {
  const n = arr.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let k = -radius; k <= radius; k++) m = Math.max(m, arr[(i + k + n) % n]);
    out[i] = m;
  }
  return out;
}

export class Track {
  constructor(def) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.width = def.width ?? 13;
    this.halfWidth = this.width / 2;
    this.build();
  }

  build() {
    const def = this.def;
    let src = def.segments;
    this.edgeSeg = null;
    if (def.points) {
      const conv = polygonToSegments(def.points, def.startT ?? 0.5);
      src = conv.segments;
      this.edgeSeg = conv.edgeSeg;
      this.startHeading = conv.startHeading;
    }
    const segs = closeSegments(src);
    this.segments = segs;
    let x0 = 0, z0 = 0;
    if (def.points) {
      const t = def.startT ?? 0.5, [ax, az] = def.points[0], [bx, bz] = def.points[1];
      x0 = ax + (bx - ax) * t; z0 = az + (bz - az) * t;
    }
    const raw = sampleSegments(segs, 1, x0, z0, this.startHeading ?? 0);
    // smooth the raw polyline to get continuous curvature (approximate clothoids)
    const xs = circularSmooth(raw.pts.map((p) => p[0]), 6, 3);
    const zs = circularSmooth(raw.pts.map((p) => p[1]), 6, 3);
    // cumulative length
    const nr = xs.length;
    const cum = new Float64Array(nr + 1);
    for (let i = 0; i < nr; i++) {
      const j = (i + 1) % nr;
      cum[i + 1] = cum[i] + Math.hypot(xs[j] - xs[i], zs[j] - zs[i]);
    }
    const L = cum[nr];
    const n = Math.round(L / SAMPLE_STEP);
    this.length = L;
    this.n = n;
    this.step = L / n;
    const px = new Float64Array(n), pz = new Float64Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const s = i * this.step;
      while (cum[k + 1] < s) k++;
      const t = (s - cum[k]) / (cum[k + 1] - cum[k] || 1);
      const j = (k + 1) % nr;
      px[i] = xs[k] + (xs[j] - xs[k]) * t;
      pz[i] = zs[k] + (zs[j] - zs[k]) * t;
    }
    this.px = px; this.pz = pz;
    // map raw segment starts to resampled s
    const scale = L / raw.rawLength;
    this.segStart = raw.segStart.map((s) => s * scale);
    this.segLen = segs.map((sg, i) => ((raw.segStart[i + 1] ?? raw.rawLength) - raw.segStart[i]) * scale);

    // tangents, normals (right), heading, curvature
    const tx = new Float64Array(n), tz = new Float64Array(n), hd = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      const dx = px[b] - px[a], dz = pz[b] - pz[a];
      const l = Math.hypot(dx, dz) || 1;
      tx[i] = dx / l; tz[i] = dz / l;
      hd[i] = Math.atan2(tz[i], tx[i]);
    }
    const curv = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 2 + n) % n, b = (i + 2) % n;
      curv[i] = wrapAngle(hd[b] - hd[a]) / (4 * this.step);
    }
    this.tx = tx; this.tz = tz; this.heading = hd; this.curv = curv;
    // right vector = (-tz, tx)
    this.rx = Float64Array.from(tz, (v) => -v);
    this.rz = Float64Array.from(tx);

    this.buildRunoff();
    this.buildPit();
    this.buildRacingLine();
    this.buildMarkers();
  }

  idx(i) { return ((i % this.n) + this.n) % this.n; }
  wrapS(s) { const L = this.length; return ((s % L) + L) % L; }
  /** signed forward distance from a to b along the lap, in (-L/2, L/2] */
  deltaS(a, b) {
    let d = b - a;
    const L = this.length;
    if (d > L / 2) d -= L;
    if (d <= -L / 2) d += L;
    return d;
  }

  resolveRef(ref) {
    if (typeof ref === 'number') return this.wrapS(ref);
    const i = ref.edge != null ? this.edgeSeg[ref.edge] : ref.seg;
    return this.wrapS(this.segStart[i] + this.segLen[i] * (ref.t ?? 0) + (ref.off ?? 0));
  }

  buildRunoff() {
    const n = this.n;
    const style = this.def.runoff ?? 'mixed';
    const sm = circularSmooth(this.curv, 10, 2);
    const outerL = new Float64Array(n), outerR = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const k = sm[i];
      const street = style === 'street';
      const big = street ? 3 + 9 * smoothstep(0.005, 0.03, Math.abs(k)) : 9 + 26 * smoothstep(0.003, 0.02, Math.abs(k));
      const small = street ? 2.5 : 7 + 3 * smoothstep(0.003, 0.02, Math.abs(k));
      // turning right (k>0): outside is the left
      outerL[i] = k > 0 ? big : small;
      outerR[i] = k > 0 ? small : big;
    }
    // runoff starts before corners and extends after
    const spread = Math.round(70 / this.step);
    this.runL = circularSmooth(circularMax(outerL, spread), 8, 2);
    this.runR = circularSmooth(circularMax(outerR, spread), 8, 2);
    // surface type of runoff: 0 grass, 1 gravel, 2 asphalt
    this.runTypeL = new Uint8Array(n);
    this.runTypeR = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      for (const [run, type] of [[this.runL, this.runTypeL], [this.runR, this.runTypeR]]) {
        if (style === 'street') type[i] = 2;
        else if (style === 'asphalt') type[i] = 2;
        else if (style === 'gravel') type[i] = run[i] > 16 ? 1 : 0;
        else type[i] = run[i] > 22 ? 1 : run[i] > 14 ? 2 : 0;
      }
    }
    // kerbs where curvature is meaningful
    const ks = circularSmooth(this.curv.map(Math.abs), 4, 1);
    const kerb = new Uint8Array(n);
    for (let i = 0; i < n; i++) kerb[i] = ks[i] > 1 / 450 ? 1 : 0;
    const kerbSpread = circularMax(kerb, Math.round(14 / this.step));
    this.kerbL = Uint8Array.from(kerbSpread);
    this.kerbR = Uint8Array.from(kerbSpread);
  }

  buildPit() {
    const p = this.def.pit;
    this.pit = {
      entryS: this.resolveRef(p.entry),
      exitS: this.resolveRef(p.exit),
      laneOffset: this.halfWidth + 7,
      wallOffset: this.halfWidth + 3.5,
      boxOffset: this.halfWidth + 12,
      ramp: 140,
      speedLimit: (p.speedLimit ?? 80) / 3.6,
    };
    const pt = this.pit;
    pt.length = this.wrapS(pt.exitS - pt.entryS);
    pt.limitStart = pt.ramp; // pit-progress where limiter applies
    pt.limitEnd = pt.length - pt.ramp;
    pt.boxStart = pt.limitStart + 60;
    pt.boxSpacing = 16;
    // widen right barrier along the pit lane
    for (let i = 0; i < this.n; i++) {
      const ps = this.pitProgress(i * this.step);
      if (ps >= 0) {
        this.runR[i] = Math.max(this.runR[i], this.pitLaneOffset(ps) + 8.5 - this.halfWidth);
        this.runTypeR[i] = 2;
        this.kerbR[i] = 0;
      }
    }
  }

  /** progress along the pit lane, or -1 if s is not inside the pit zone */
  pitProgress(s) {
    const ps = this.wrapS(s - this.pit.entryS);
    return ps <= this.pit.length ? ps : -1;
  }

  /** lateral offset of the pit lane centre at pit progress ps */
  pitLaneOffset(ps) {
    const pt = this.pit;
    const inT = smoothstep(0, pt.ramp, ps);
    const outT = 1 - smoothstep(pt.length - pt.ramp, pt.length, ps);
    const t = Math.min(inT, outT);
    return (this.halfWidth - 2.5) + (pt.laneOffset - (this.halfWidth - 2.5)) * t;
  }

  boxProgress(teamIndex) {
    return this.pit.boxStart + teamIndex * this.pit.boxSpacing;
  }

  hasPitWall(s) {
    const ps = this.pitProgress(s);
    return ps > this.pit.ramp - 10 && ps < this.pit.length - this.pit.ramp + 10;
  }

  buildRacingLine() {
    const n = this.n;
    const hw = this.halfWidth;
    const margin = 1.6;
    const off = new Float64Array(n);
    const qx = new Float64Array(n), qz = new Float64Array(n);
    const { px, pz, rx, rz } = this;
    const lim = hw - margin;
    const schedule = [[24, 140], [12, 160], [6, 160], [3, 120]];
    for (const [kk, iters] of schedule) {
      for (let it = 0; it < iters; it++) {
        for (let i = 0; i < n; i++) { qx[i] = px[i] + rx[i] * off[i]; qz[i] = pz[i] + rz[i] * off[i]; }
        for (let i = 0; i < n; i++) {
          const a = (i - kk + n) % n, b = (i + kk) % n;
          const mx = (qx[a] + qx[b]) * 0.5, mz = (qz[a] + qz[b]) * 0.5;
          const target = (mx - px[i]) * rx[i] + (mz - pz[i]) * rz[i];
          off[i] = clamp(off[i] + (target - off[i]) * 0.55, -lim, lim);
        }
      }
    }
    // final light smoothing keeps the line drivable
    const sm = circularSmooth(off, 3, 2);
    for (let i = 0; i < n; i++) off[i] = clamp(sm[i], -lim, lim);
    this.lineOff = off;
    this.lx = new Float64Array(n); this.lz = new Float64Array(n);
    for (let i = 0; i < n; i++) { this.lx[i] = px[i] + rx[i] * off[i]; this.lz[i] = pz[i] + rz[i] * off[i]; }
    // racing line curvature
    const lh = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      lh[i] = Math.atan2(this.lz[b] - this.lz[a], this.lx[b] - this.lx[a]);
    }
    const lc = new Float64Array(n);
    const w = 3;
    for (let i = 0; i < n; i++) {
      const a = (i - w + n) % n, b = (i + w) % n;
      let len = 0;
      for (let k = -w; k < w; k++) {
        const c = (i + k + n) % n, d = (i + k + 1) % n;
        len += Math.hypot(this.lx[d] - this.lx[c], this.lz[d] - this.lz[c]);
      }
      lc[i] = wrapAngle(lh[b] - lh[a]) / (len || 1);
    }
    this.lineCurv = circularSmooth(lc, 2, 1);
    // distance along line per sample (for speed profile integration)
    this.lineDs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const b = (i + 1) % n;
      this.lineDs[i] = Math.hypot(this.lx[b] - this.lx[i], this.lz[b] - this.lz[i]);
    }
  }

  buildMarkers() {
    const def = this.def;
    this.sectors = [0, this.resolveRef(def.sectors[0]), this.resolveRef(def.sectors[1])];
    this.drsZones = (def.drs ?? []).map((z) => {
      const start = this.resolveRef(z.start);
      const end = this.resolveRef(z.end);
      return { start, end, detect: this.wrapS(start - (z.detectBefore ?? 250)) };
    });
    this.speedTrap = this.resolveRef(def.speedTrap ?? { seg: 0, t: 0.9 });
    // corners for HUD / engineer messages: local curvature peaks
    this.corners = [];
    const sm = circularSmooth(this.curv.map(Math.abs), 6, 2);
    let inCorner = false, peak = 0, peakI = 0, startI = 0;
    for (let i = 0; i < this.n; i++) {
      if (sm[i] > 1 / 250) {
        if (!inCorner) { inCorner = true; peak = 0; startI = i; }
        if (sm[i] > peak) { peak = sm[i]; peakI = i; }
      } else if (inCorner) {
        inCorner = false;
        if ((i - startI) * this.step > 15) this.corners.push({ s: peakI * this.step, startS: startI * this.step, radius: 1 / peak, dir: Math.sign(this.curv[peakI]) });
      }
    }
    this.corners.forEach((c, k) => { c.number = k + 1; });
    this.miniSectorLen = 100;
    this.miniSectors = Math.floor(this.length / this.miniSectorLen);
  }

  /** world position of track coordinate (s, d) */
  toWorld(s, d, out = {}) {
    s = this.wrapS(s);
    const f = s / this.step;
    const i = Math.floor(f) % this.n;
    const j = (i + 1) % this.n;
    const t = f - Math.floor(f);
    const x = this.px[i] + (this.px[j] - this.px[i]) * t;
    const z = this.pz[i] + (this.pz[j] - this.pz[i]) * t;
    const rx = this.rx[i] + (this.rx[j] - this.rx[i]) * t;
    const rz = this.rz[i] + (this.rz[j] - this.rz[i]) * t;
    out.x = x + rx * d;
    out.z = z + rz * d;
    out.heading = Math.atan2(this.tz[i] + (this.tz[j] - this.tz[i]) * t, this.tx[i] + (this.tx[j] - this.tx[i]) * t);
    return out;
  }

  /** Project world position to track coordinates. hint = previous sample index for local search. */
  project(x, z, hint = -1, out = {}) {
    const n = this.n;
    let best = -1, bestD = Infinity;
    if (hint >= 0) {
      for (let k = -25; k <= 25; k++) {
        const i = (hint + k + n) % n;
        const dx = x - this.px[i], dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    if (best < 0 || bestD > 40 * 40) {
      for (let i = 0; i < n; i++) {
        const dx = x - this.px[i], dz = z - this.pz[i];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    const i = best;
    const dx = x - this.px[i], dz = z - this.pz[i];
    const along = dx * this.tx[i] + dz * this.tz[i];
    out.i = i;
    out.s = this.wrapS(i * this.step + along);
    out.d = dx * this.rx[i] + dz * this.rz[i];
    out.heading = this.heading[i];
    return out;
  }

  sampleIndex(s) { return Math.floor(this.wrapS(s) / this.step) % this.n; }

  /** Interpolated sample of a per-sample array at distance s. */
  sampleArr(arr, s) {
    const f = this.wrapS(s) / this.step;
    const i = Math.floor(f) % this.n;
    const j = (i + 1) % this.n;
    const t = f - Math.floor(f);
    return arr[i] + (arr[j] - arr[i]) * t;
  }

  /**
   * Surface at track coordinates. Returns code:
   * 0 track, 1 kerb, 2 grass, 3 gravel, 4 asphalt runoff, 5 pit lane
   */
  surfaceAt(s, d, inPit = false) {
    const hw = this.halfWidth;
    if (inPit) return 5;
    const ad = Math.abs(d);
    if (ad <= hw) return 0;
    const i = this.sampleIndex(s);
    const left = d < 0;
    const kerb = left ? this.kerbL[i] : this.kerbR[i];
    if (kerb && ad <= hw + KERB_WIDTH) return 1;
    if (!left && this.pitProgress(s) >= 0) return 4;
    const type = left ? this.runTypeL[i] : this.runTypeR[i];
    return type === 0 ? 2 : type === 1 ? 3 : 4;
  }

  /** Distance from centreline to barrier on the given side at s. */
  barrierAt(s, side) {
    const i = this.sampleIndex(s);
    return this.halfWidth + (side < 0 ? this.runL[i] : this.runR[i]);
  }

  gridSlot(pos) {
    // pole is 12 m behind the line, staggered 8 m per slot
    const s = this.wrapS(-12 - pos * 8);
    const d = pos % 2 === 0 ? -2.6 : 2.6;
    return this.toWorld(s, d, { s, d });
  }

  inDrsZone(s) {
    for (let k = 0; k < this.drsZones.length; k++) {
      const z = this.drsZones[k];
      const len = this.wrapS(z.end - z.start);
      if (this.wrapS(s - z.start) <= len) return k;
    }
    return -1;
  }

  sectorOf(s) {
    s = this.wrapS(s);
    if (s < this.sectors[1]) return 0;
    if (s < this.sectors[2]) return 1;
    return 2;
  }

  bounds() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.n; i++) {
      minX = Math.min(minX, this.px[i]); maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]); maxZ = Math.max(maxZ, this.pz[i]);
    }
    return { minX, maxX, minZ, maxZ };
  }
}

export { TAU };
