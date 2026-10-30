// Quasi-steady-state lap simulation: maximum speed profile along the racing line for given car params.
// Used by the AI (target speeds, braking points), the racing-line HUD assist and session simulation.
import { G, RHO_AIR, clamp } from './util.js';
import { powerShape } from './car.js';
import { COMPOUNDS } from './tyres.js';

const MU0 = 1.86, FZ_NOM = 3800;

export function carLimits(params, opts = {}) {
  const fuel = opts.fuel ?? 30;
  const m = params.mass + fuel;
  const grip = (opts.grip ?? 1) * (COMPOUNDS[opts.compound ?? 'M'].grip);
  const latGrip = (params.gripLatF + params.gripLatR) / 2;
  const lonGrip = (params.gripLonF + params.gripLonR) / 2;
  const ers = opts.ersPower ?? 60000;
  const muEff = (v) => {
    const down = 0.5 * RHO_AIR * params.ClA * v * v;
    const fzAvg = (m * G + down) / 4;
    return MU0 * grip * (1 - 0.085 * (fzAvg / FZ_NOM - 1));
  };
  // each axle must carry its share of the lateral force; with a rearward aero balance the
  // front axle saturates first in fast corners
  const WF = 0.465;
  const latMax = (v) => {
    const down = 0.5 * RHO_AIR * params.ClA * v * v;
    const mu = muEff(v);
    const front = (mu * params.gripLatF * (WF * m * G + params.aeroBalance * down)) / (WF * m);
    const rear = (mu * params.gripLatR * ((1 - WF) * m * G + (1 - params.aeroBalance) * down)) / ((1 - WF) * m);
    // calibrated against the physics skidpad (load transfer & sensitivity cost more at high load)
    return Math.min(front, rear) * 0.985 * (1 - 0.0028 * Math.max(0, v - 40));
  };
  const brakeMax = (v) => {
    const down = 0.5 * RHO_AIR * params.ClA * v * v;
    const drag = 0.5 * RHO_AIR * params.CdA * v * v;
    const tyre = muEff(v) * lonGrip * (m * G + down);
    return (Math.min(tyre, params.brakeForce + 3000) + drag) / m;
  };
  const accelMax = (v) => {
    const down = 0.5 * RHO_AIR * params.ClA * v * v;
    const drag = 0.5 * RHO_AIR * params.CdA * v * v;
    // rear-axle traction (~54% static + aero share + transfer)
    const rearLoad = m * G * 0.6 + down * (1 - params.aeroBalance);
    const traction = muEff(v) * lonGrip * rearLoad;
    const vv = Math.max(v, 3);
    // engine runs near the power peak thanks to 8 close ratios
    const P = params.maxPowerICE * 0.95 + ers;
    const drive = Math.min(traction, (P * 0.93) / vv);
    return (drive - drag - 0.012 * m * G) / m;
  };
  return { m, latMax, brakeMax, accelMax, muEff };
}

/**
 * Returns { v: Float32Array speed per track sample, lapTime }.
 * opts: { grip (multiplier), latMargin, brakeMargin, compound, fuel }
 */
export function speedProfile(track, params, opts = {}) {
  const n = track.n;
  const lim = carLimits(params, opts);
  const latMargin = opts.latMargin ?? 0.95;
  const brakeMargin = opts.brakeMargin ?? 0.88;
  const vmax = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(track.lineCurv[i]);
    let v = 100;
    if (k > 1e-5) {
      for (let it = 0; it < 12; it++) v = Math.min(100, Math.sqrt((lim.latMax(v) * latMargin) / k));
    }
    vmax[i] = v;
  }
  const v = Float64Array.from(vmax);
  const ds = track.lineDs;
  const ellipse = (vi, i, margin) => {
    const latUsed = vi * vi * Math.abs(track.lineCurv[i]);
    const latCap = lim.latMax(vi) * margin;
    return Math.sqrt(Math.max(0.05, 1 - (latUsed / latCap) ** 2));
  };
  // two laps of forward/backward passes to handle wrap-around
  for (let lap = 0; lap < 2; lap++) {
    for (let k = 0; k < n; k++) {
      const i = k, j = (k + 1) % n;
      const a = lim.accelMax(v[i]) * ellipse(v[i], i, latMargin);
      v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * Math.max(0, a) * ds[i]));
    }
    for (let k = n - 1; k >= 0; k--) {
      const i = k, j = (k + 1) % n;
      const d = lim.brakeMax(v[j]) * brakeMargin * ellipse(v[j], j, latMargin);
      v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * d * ds[i]));
    }
  }
  let t = 0;
  for (let i = 0; i < n; i++) t += ds[i] / Math.max(1, (v[i] + v[(i + 1) % n]) / 2);
  return { v: Float32Array.from(v), vCurve: Float32Array.from(vmax), lapTime: t, limits: lim };
}

export function sampleProfile(track, prof, s) {
  return track.sampleArr(prof, s);
}

export { clamp };
