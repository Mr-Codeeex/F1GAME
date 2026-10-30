// Vehicle dynamics: planar 4-wheel model with load transfer, aero, combined-slip tyres,
// power unit (ICE + ERS), 8-speed gearbox, brakes, DRS, fuel, tyre thermals/wear and damage.
import { G, RHO_AIR, clamp, approach, wrapAngle } from './util.js';
import { COMPOUNDS, TyreSet, tempGrip, wearGrip, wetnessGrip } from './tyres.js';
import { computeCarParams, defaultSetup } from './setup.js';

export const CAR_LENGTH = 5.6;
export const CAR_WIDTH = 2.0;
const WHEELBASE = 3.6;
const TRACK_F = 1.6, TRACK_R = 1.55;
const CG_HEIGHT = 0.3;
const WHEEL_R = 0.36;
const IZ = 1150;
const MU0 = 1.86;
const FZ_NOM = 3800;
const STEER_MAX = 0.36; // rad at the wheels
export const RPM_MAX = 12400;
const RPM_IDLE = 4200;
const RPM_LAUNCH = 8800;
const BATTERY_MAX = 4e6;
const LAP_DEPLOY_MAX = 4e6;
const LAP_HARVEST_MAX = 2e6;
export const ERS_MODES = [
  { id: 0, name: 'NONE', deploy: 0, mguH: 26000 },
  { id: 1, name: 'MEDIUM', deploy: 42000, mguH: 14000 },
  { id: 2, name: 'HOTLAP', deploy: 120000, mguH: 4000 },
  { id: 3, name: 'OVERTAKE', deploy: 120000, mguH: 0 },
];
export const FUEL_MIXES = [
  { name: 'LEAN', flow: 0.86, power: 0.962 },
  { name: 'STANDARD', flow: 1.0, power: 1.0 },
  { name: 'RICH', flow: 1.1, power: 1.018 },
];

// surface: friction multiplier, rolling drag coefficient (fraction of weight)
export const SURFACES = [
  { name: 'track', grip: 1.0, roll: 0.012, wetGrip: 1 },
  { name: 'kerb', grip: 0.94, roll: 0.02, wetGrip: 0.8 },
  { name: 'grass', grip: 0.56, roll: 0.09, wetGrip: 0.6 },
  { name: 'gravel', grip: 0.5, roll: 0.42, wetGrip: 0.9 },
  { name: 'runoff', grip: 0.95, roll: 0.014, wetGrip: 0.95 },
  { name: 'pit', grip: 0.95, roll: 0.012, wetGrip: 0.95 },
];

export function gearRatios() {
  const first = 16.4, top = 4.72, n = 8;
  const r = [];
  // progressively closer ratios in the upper gears
  for (let i = 0; i < n; i++) {
    const t = Math.pow(i / (n - 1), 0.82);
    r.push(first * Math.pow(top / first, t));
  }
  return r;
}
const RATIOS = gearRatios();

export function powerShape(rpm) {
  const x = rpm / 11000;
  if (x <= 1) return Math.pow(Math.sin((clamp(x, 0, 1) * Math.PI) / 2), 1.5);
  return Math.max(0, 1 - 0.6 * (x - 1) * (x - 1) - (rpm > RPM_MAX ? 1 : 0));
}

// normalised lateral force curve (Pacejka-like), peak 1 around 6.5 degrees
function latCurve(alpha) {
  const B = 10.5, C = 1.62, E = 0.35;
  const x = B * alpha;
  return Math.sin(C * Math.atan(x - E * (x - Math.atan(x))));
}

export class CarPhysics {
  constructor(opts = {}) {
    this.track = opts.track ?? null;
    this.perf = opts.perf ?? { aero: 0.8, power: 0.8, chassis: 0.8, reliability: 0.9, ers: 0.8 };
    this.setSetup(opts.setup ?? defaultSetup());
    this.x = 0; this.z = 0; this.yaw = 0;
    this.vx = 0; this.vy = 0; this.r = 0;
    this.ax = 0; this.ay = 0; // filtered accelerations (car frame)
    this.steer = 0;
    this.gear = 1; this.rpm = RPM_IDLE; this.reverse = false;
    this.shiftTimer = 0;
    this.tyres = new TyreSet(opts.compound ?? 'M');
    this.fuel = opts.fuel ?? 60;
    this.fuelMix = 1;
    this.battery = BATTERY_MAX * 0.75;
    this.lapDeploy = 0; this.lapHarvest = 0;
    this.ersMode = 1;
    this.drsOpen = false;
    this.drsAllowed = false;
    this.tow = 0; this.dirtyAir = 0;
    this.damage = { frontWing: 0, rearWing: 0, floor: 0, engine: 0, gearbox: 0 };
    this.wetness = 0; this.trackTemp = 30; this.airTemp = 22;
    this.wearScale = 1;
    this.assists = { abs: true, tc: 2, autoGears: true };
    this.limiter = false; this.limiterSpeed = 80 / 3.6;
    this.frozen = false; // held on grid
    this.ignorePitWall = false;
    this.wheelSurf = [0, 0, 0, 0];
    this.wheelLoad = [0, 0, 0, 0];
    this.wheelLock = [0, 0, 0, 0];
    this.wheelSpinning = [0, 0, 0, 0];
    this.wheelSlip = [0, 0, 0, 0];
    this.fyState = [0, 0, 0, 0];
    this.wheelRot = 0;
    this.pitch = 0; this.roll = 0;
    this.trackPos = { i: -1, s: 0, d: 0, heading: 0 };
    this.events = []; // collisions etc, drained by session
    this.offTrackWheels = 0;
    this.onKerb = false;
    this.bottoming = 0;
    this.reverseHold = 0;
    this.distance = 0;
    this.throttleIn = 0; this.brakeIn = 0;
    this.stalled = false;
    this.input = { throttle: 0, brake: 0, steer: 0 };
  }

  setSetup(setup) {
    this.setup = { ...setup };
    this.params = computeCarParams(this.setup, this.perf);
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
  get speedKph() { return Math.abs(this.vx) * 3.6; }
  get mass() { return this.params.mass + this.fuel; }
  get batteryFrac() { return this.battery / BATTERY_MAX; }
  get lapDeployFrac() { return this.lapDeploy / LAP_DEPLOY_MAX; }

  placeAt(x, z, yaw) {
    this.x = x; this.z = z; this.yaw = yaw;
    this.vx = this.vy = this.r = 0;
    this.ax = this.ay = 0;
    this.fyState.fill(0);
    this.trackPos.i = -1;
    if (this.track) this.track.project(x, z, -1, this.trackPos);
  }

  newLap() {
    this.lapDeploy = 0;
    this.lapHarvest = 0;
  }

  aero(v) {
    const p = this.params, dmg = this.damage;
    let ClA = p.ClA * (1 - 0.14 * dmg.frontWing - 0.1 * dmg.rearWing - 0.16 * dmg.floor) * (1 - 0.13 * this.dirtyAir);
    let CdA = p.CdA * (1 + 0.04 * dmg.rearWing + 0.03 * dmg.frontWing);
    let bal = p.aeroBalance - 0.08 * dmg.frontWing + 0.04 * dmg.rearWing - 0.03 * this.dirtyAir;
    if (this.drsOpen) { CdA *= 0.84; ClA *= 0.9; bal += 0.03; }
    CdA *= 1 - 0.32 * this.tow;
    const q = 0.5 * RHO_AIR * v * v;
    return { down: q * ClA, drag: q * CdA, bal };
  }

  enginePower(rpm, throttle) {
    const p = this.params;
    const mix = FUEL_MIXES[this.fuelMix];
    return p.maxPowerICE * powerShape(rpm) * throttle * mix.power * (1 - 0.35 * this.damage.engine);
  }

  /**
   * Advance the car by dt seconds. input: { throttle, brake, steer (-1..1, right +), gearUp, gearDown, drs }
   */
  step(dt, input) {
    const p = this.params;
    const tyres = this.tyres;
    const comp = COMPOUNDS[tyres.compound];
    const m = this.mass;
    let throttle = clamp(input.throttle ?? 0, 0, 1);
    let brake = clamp(input.brake ?? 0, 0, 1);
    this.input = input;

    if (this.fuel <= 0) { throttle = 0; this.fuel = 0; }
    if (this.frozen) {
      // on the grid: allow revving, no motion
      this.rpm = approach(this.rpm, RPM_IDLE + throttle * (RPM_MAX - RPM_IDLE - 600), 30000 * dt);
      this.throttleIn = throttle; this.brakeIn = brake;
      return;
    }

    const vxAbs = Math.abs(this.vx);
    // ---- reverse gear handling (stationary + brake held) ----
    if (!this.reverse && vxAbs < 0.6 && brake > 0.5 && throttle < 0.05) {
      this.reverseHold += dt;
      if (this.reverseHold > 0.7) { this.reverse = true; }
    } else if (!this.reverse) this.reverseHold = 0;
    if (this.reverse) {
      if (throttle > 0.1 && this.vx > -0.6) { this.reverse = false; this.reverseHold = 0; }
      else { const t = throttle; throttle = brake; brake = t; }
    }

    // ---- steering ----
    const steerTarget = clamp(input.steer ?? 0, -1, 1) * STEER_MAX;
    this.steer = approach(this.steer, steerTarget, 3.2 * dt);
    const delta = this.steer;

    // ---- aero & loads ----
    const v = vxAbs;
    const aer = this.aero(v);
    const a = WHEELBASE * 0.535, b = WHEELBASE - a; // CG 46.5% front
    const W = m * G;
    let fzF = W * b / WHEELBASE + aer.down * aer.bal;
    let fzR = W * a / WHEELBASE + aer.down * (1 - aer.bal);
    const dLong = (m * this.ax * CG_HEIGHT) / WHEELBASE;
    fzF = Math.max(200, fzF - dLong);
    fzR = Math.max(200, fzR + dLong);
    const dLat = (m * this.ay * CG_HEIGHT);
    const dF = (dLat * p.rollFront) / TRACK_F;
    const dR = (dLat * (1 - p.rollFront)) / TRACK_R;
    const fz = this.wheelLoad;
    // ay > 0 => turning right => left wheels loaded
    fz[0] = Math.max(50, fzF / 2 + dF);
    fz[1] = Math.max(50, fzF / 2 - dF);
    fz[2] = Math.max(50, fzR / 2 + dR);
    fz[3] = Math.max(50, fzR / 2 - dR);

    // ---- surfaces per wheel ----
    const tp = this.trackPos;
    const track = this.track;
    const cosY = Math.cos(this.yaw), sinY = Math.sin(this.yaw);
    let offWheels = 0; let kerb = false;
    if (track) {
      const ti = tp.i >= 0 ? tp.i : 0;
      const trx = track.rx[ti], trz = track.rz[ti];
      // lateral offsets of wheels relative to car centre, mapped to track-right
      const fx = cosY, fzv = sinY, rx = -sinY, rz = cosY;
      const fDot = fx * trx + fzv * trz, rDot = rx * trx + rz * trz;
      const offs = [[a, -TRACK_F / 2], [a, TRACK_F / 2], [-b, -TRACK_R / 2], [-b, TRACK_R / 2]];
      for (let w = 0; w < 4; w++) {
        const wd = tp.d + offs[w][0] * fDot + offs[w][1] * rDot;
        const sf = track.surfaceAt(tp.s, wd, this.inPitLane);
        this.wheelSurf[w] = sf;
        if (Math.abs(wd) > track.halfWidth + (sf === 1 ? 1.6 : 0) && !this.inPitLane) offWheels++;
        if (sf === 1) kerb = true;
      }
    }
    this.offTrackWheels = offWheels;
    this.onKerb = kerb;

    // ---- drivetrain ----
    const ratio = RATIOS[this.gear - 1];
    const wheelOmega = v / WHEEL_R;
    let rpm = wheelOmega * ratio * 60 / (2 * Math.PI);
    let clutchSlip = false;
    if (this.reverse) rpm = Math.max(RPM_IDLE, v / WHEEL_R * RATIOS[0] * 9.55);
    else if (this.gear === 1 && rpm < RPM_LAUNCH) {
      const target = RPM_IDLE + (RPM_LAUNCH - RPM_IDLE) * throttle;
      if (rpm < target) { rpm = target; clutchSlip = true; }
    }
    rpm = Math.max(RPM_IDLE, rpm);
    this.rpm = this.rpm + (rpm - this.rpm) * Math.min(1, dt * 30);

    // auto/manual shifting
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    if (!this.reverse) {
      if (this.assists.autoGears) {
        if (this.rpm > 11950 && this.gear < 8 && this.shiftTimer <= 0) { this.gear++; this.shiftTimer = 0.12; }
        else if (this.gear > 1 && this.shiftTimer <= 0) {
          const lowerRpm = wheelOmega * RATIOS[this.gear - 2] * 9.549;
          if (lowerRpm < 11300 && (this.rpm < 8300 || (brake > 0.2 && lowerRpm < 10600))) { this.gear--; this.shiftTimer = 0.1; }
        }
      } else {
        if (input.gearUp && this.gear < 8) { this.gear++; this.shiftTimer = 0.05; }
        if (input.gearDown && this.gear > 1) {
          const lowerRpm = wheelOmega * RATIOS[this.gear - 2] * 9.549;
          if (lowerRpm < RPM_MAX + 400) this.gear--;
        }
      }
    }

    // limiter (pit lane)
    if (this.limiter && v > this.limiterSpeed) throttle = Math.min(throttle, clamp(1 - (v - this.limiterSpeed) * 2, 0, 1) * 0.3);
    const overRev = this.rpm > RPM_MAX;
    let iceP = overRev ? 0 : this.enginePower(this.rpm, throttle);

    // ---- ERS ----
    const mode = ERS_MODES[input.overtake ? 3 : this.ersMode];
    let ersP = 0;
    const deployLeft = LAP_DEPLOY_MAX - this.lapDeploy;
    if (throttle > 0.85 && v > 12 && this.battery > 0 && deployLeft > 0 && !overRev && !this.reverse) {
      ersP = Math.min(mode.deploy, p.ersPower) * throttle;
      const e = ersP * dt;
      if (e > this.battery || e > deployLeft) ersP = 0;
      else { this.battery -= e; this.lapDeploy += e; }
    }
    // MGU-H style harvest at full throttle
    if (throttle > 0.9 && v > 30) this.battery = Math.min(BATTERY_MAX, this.battery + mode.mguH * p.ersEfficiency * dt);

    // ---- drive & brake forces ----
    const engineOmega = Math.max(this.rpm, 1000) * 2 * Math.PI / 60;
    let driveF = 0;
    const shiftCut = this.shiftTimer > 0.08 ? 0.6 : 1;
    if (this.reverse) driveF = -throttle * 5000 * (v < 5.5 ? 1 : 0);
    else {
      const torque = (iceP + ersP) / engineOmega;
      driveF = (torque * ratio * 0.93) / WHEEL_R * shiftCut;
      if (this.gear >= 2 && this.shiftTimer <= 0 && !clutchSlip && v > 1) driveF = Math.min(driveF, (iceP + ersP) * 0.93 / v);
    }
    // engine braking
    if (throttle < 0.05 && !this.reverse && v > 2) driveF -= 900 + 1400 * (this.rpm / RPM_MAX);
    this.gearbox = { ratio };

    const bf = p.brakeForce * brake;
    const sx = this.vx >= 0 ? 1 : -1;
    // brake harvest
    if (bf > 0 && v > 5) {
      const hp = Math.min(p.ersPower, 0.3 * bf * v);
      const e = hp * dt * p.ersEfficiency;
      if (this.lapHarvest < LAP_HARVEST_MAX) { this.battery = Math.min(BATTERY_MAX, this.battery + e); this.lapHarvest += e; }
    }

    // ---- tyres ----
    const wet = this.wetness;
    const wetG = wetnessGrip(tyres.compound, wet);
    const gripLat = [p.gripLatF, p.gripLatF, p.gripLatR, p.gripLatR];
    const gripLon = [p.gripLonF, p.gripLonF, p.gripLonR, p.gripLonR];
    const tw = [TRACK_F, TRACK_F, TRACK_R, TRACK_R];
    const px = [a, a, -b, -b];
    const py = [-TRACK_F / 2, TRACK_F / 2, -TRACK_R / 2, TRACK_R / 2];
    let sumFx = 0, sumFy = 0, sumMz = 0;
    const vlong = Math.max(Math.abs(this.vx), 4.0);
    const relax = Math.min(1, (dt * Math.max(v, 6)) / 0.35);
    const diffLock = throttle > 0.3 ? p.diffOn : p.diffOff;
    let slipPowerTot = 0;

    for (let w = 0; w < 4; w++) {
      const front = w < 2;
      const sf = SURFACES[this.wheelSurf[w]];
      const surfGrip = sf.grip * (1 - (1 - sf.wetGrip) * wet) * (this.wheelSurf[w] === 1 ? 1 - p.kerbPenalty : 1);
      const flat = tyres.flatspot[w];
      const tG = tempGrip(comp, tyres.temp[w]);
      const wG = wearGrip(tyres.wear[w]);
      const loadSens = 1 - 0.085 * (fz[w] / FZ_NOM - 1);
      const mu = MU0 * comp.grip * wetG * tG * wG * surfGrip * loadSens * (1 - 0.04 * flat);
      const Fmax = mu * fz[w];
      // wheel velocity in car frame
      const wvx = this.vx - this.r * py[w];
      const wvy = this.vy + this.r * px[w];
      void tw;
      let alpha;
      if (front) alpha = Math.atan2(wvy, Math.max(Math.abs(wvx), 4.0)) - delta * sx;
      else alpha = Math.atan2(wvy, Math.max(Math.abs(wvx), 4.0));
      if (sx < 0) alpha = -alpha;

      // longitudinal request
      let fxReq = 0;
      if (!front) {
        // locked diff sends torque to the slower (inside) wheel
        const split = 0.5 + (w === 2 ? 1 : -1) * diffLock * clamp(this.r * 0.25 * sx, -0.12, 0.12);
        fxReq += driveF * split * 2 / 2;
      }
      const brakeShare = front ? p.brakeBias / 2 : (1 - p.brakeBias) / 2;
      let fb = bf * brakeShare;
      const FmaxLon = Fmax * gripLon[w];
      let locked = false, spinning = false;
      if (fb > 0 && v > 0.5) {
        if (this.assists.abs) fb = Math.min(fb, FmaxLon * 0.97);
        else if (fb > FmaxLon * 1.02) locked = true;
      }
      let fx;
      if (locked) fx = -sx * FmaxLon * 0.8;
      else {
        fx = fxReq - sx * fb;
        if (v < 0.5 && fxReq === 0) fx = -this.vx * m * 0.25; // hold
      }
      // traction limit
      if (!locked && fxReq !== 0) {
        const tc = this.assists.tc;
        // traction control keeps drive inside the friction circle left over by cornering
        const fyPrev = Math.abs(this.fyState[w]);
        const circle = Math.sqrt(Math.max(0, FmaxLon * FmaxLon - fyPrev * fyPrev * 0.95));
        if (tc >= 2 && Math.abs(fx) > circle * 0.96) fx = Math.sign(fx) * Math.max(circle * 0.96, FmaxLon * 0.25);
        else if (tc === 1 && Math.abs(fx) > Math.max(circle, FmaxLon * 0.5) * 1.02) {
          fx = Math.sign(fx) * Math.max(circle, FmaxLon * 0.5) * 1.02;
          spinning = Math.abs(fxReq) > FmaxLon * 1.25;
        } else if (Math.abs(fx) > FmaxLon) { spinning = true; fx = Math.sign(fx) * FmaxLon * 0.86; }
      }
      // lateral
      const fyCap = Math.sqrt(Math.max(0, Fmax * Fmax * gripLat[w] * gripLat[w] - fx * fx * 0.9));
      let fy = -Fmax * gripLat[w] * latCurve(alpha) * (sx < 0 ? -1 : 1);
      if (locked) fy *= 0.25;
      if (spinning) fy *= 0.45;
      fy = clamp(fy, -fyCap, fyCap);
      if (!front) fy *= p.rearStab > 1 ? 1 : 1;
      this.fyState[w] += (fy - this.fyState[w]) * relax;
      fy = this.fyState[w];
      // low-speed lateral damping keeps parked cars stable
      if (v < 3) fy += -wvy * m * 0.25 * (1 - v / 3);

      // rotate front forces by steer angle
      let cfx = fx, cfy = fy;
      if (front) {
        const c = Math.cos(delta), s = Math.sin(delta);
        cfx = fx * c - fy * s;
        cfy = fx * s + fy * c;
      }
      sumFx += cfx; sumFy += cfy;
      sumMz += px[w] * cfy - py[w] * cfx;

      // slip power for wear/temperature
      const latSlipV = Math.abs(Math.sin(alpha)) * vlong;
      const util = Fmax > 0 ? Math.min(1.5, Math.abs(fx) / Math.max(1, FmaxLon)) : 0;
      let lonSlipV = vlong * 0.06 * util * util * util;
      if (locked) lonSlipV = Math.max(lonSlipV, v * 0.6);
      if (spinning) lonSlipV = Math.max(lonSlipV, 8);
      const P = Math.abs(fy) * latSlipV + Math.abs(fx) * lonSlipV;
      slipPowerTot += P;
      this.wheelSlip[w] = Math.min(1, (latSlipV + lonSlipV) / 4);
      this.wheelLock[w] = locked ? 1 : 0;
      this.wheelSpinning[w] = spinning ? 1 : 0;

      // thermals
      const heatK = (front ? p.heatF : p.heatR) * comp.heat;
      const amb = this.trackTemp * (1 - wet * 0.35);
      const over = Math.max(0, tyres.temp[w] - comp.optTemp);
      const cool = (0.006 + 0.00025 * v) * (1 + 2.2 * wet * (comp.wet ? 0.3 : 1)) * (1 + over / 25);
      const surfaceHeat = (this.wheelSurf[w] >= 2 && this.wheelSurf[w] <= 3) ? 0.3 : 1;
      const flexHeat = 2.7e-6 * fz[w] * v;
      tyres.temp[w] += ((Math.min(P, 150000) * 8e-5 * surfaceHeat + flexHeat) * heatK - cool * (tyres.temp[w] - amb)) * dt;
      // wear
      const overheat = 1 + Math.max(0, tyres.temp[w] - comp.optTemp - 15) / 30;
      const wetsOnDry = comp.wet ? 1 + 3.5 * Math.max(0, 0.35 - wet) : 1;
      const wearK = (front ? p.wearF : p.wearR) * comp.wear * overheat * wetsOnDry * this.wearScale;
      tyres.wear[w] = Math.min(1, tyres.wear[w] + Math.min(P, 90000) * 3.4e-8 * wearK * dt * (1 - 0.5 * wet * (comp.wet ? 0 : 1)));
      if (locked && v > 15) tyres.flatspot[w] = Math.min(1, flat + dt * 0.05);
    }
    this.slipPower = slipPowerTot;

    // diff yaw damping & rear stability
    sumMz -= diffLock * 0.06 * this.r * (fz[2] + fz[3]) * TRACK_R;
    sumMz -= (p.rearStab - 1) * 2500 * this.r;

    // ---- resistances ----
    let rollK = 0;
    for (let w = 0; w < 4; w++) rollK += SURFACES[this.wheelSurf[w]].roll * fz[w];
    const resist = aer.drag + rollK + (this.bottoming > 0 ? 400 : 0);
    sumFx -= sx * resist * (v > 0.3 ? 1 : v / 0.3);

    // ---- integrate ----
    const axCar = sumFx / m;
    const ayCar = sumFy / m;
    this.vx += (axCar + this.vy * this.r) * dt;
    this.vy += (ayCar - this.vx * this.r) * dt;
    this.r += (sumMz / IZ) * dt;
    // stationary hold
    if (Math.abs(this.vx) < 0.3 && throttle < 0.05 && (brake > 0.05 || v < 0.05) && !this.reverse) {
      this.vx *= 0.8; this.vy *= 0.8; this.r *= 0.8;
    }
    if (!isFinite(this.vx) || !isFinite(this.vy) || !isFinite(this.r)) { this.vx = this.vy = this.r = 0; }
    this.r = clamp(this.r, -4, 4);
    const k = Math.min(1, dt * 12);
    this.ax += (axCar - this.ax) * k;
    this.ay += (ayCar - this.ay) * k;
    this.yaw = wrapAngle(this.yaw + this.r * dt);
    const c2 = Math.cos(this.yaw), s2 = Math.sin(this.yaw);
    const wx = this.vx * c2 - this.vy * s2;
    const wz = this.vx * s2 + this.vy * c2;
    this.x += wx * dt;
    this.z += wz * dt;
    this.distance += Math.abs(this.vx) * dt;
    this.wheelRot += (this.vx / WHEEL_R) * dt * (this.wheelLock[0] ? 0 : 1);

    // fuel
    const mixF = FUEL_MIXES[this.fuelMix].flow;
    this.fuel = Math.max(0, this.fuel - (0.0295 * Math.pow(throttle, 1.15) * mixF * powerShape(this.rpm) + 0.0012) * dt);

    // visual body motion
    this.pitch += (clamp(-this.ax / 40, -0.03, 0.03) - this.pitch) * Math.min(1, dt * 8);
    this.roll += (clamp(this.ay / 60, -0.04, 0.04) - this.roll) * Math.min(1, dt * 8);
    this.throttleIn = throttle; this.brakeIn = brake;

    if (track) {
      track.project(this.x, this.z, tp.i, tp);
      this.collideBarriers();
    }
    // bottoming on kerbs with low ride
    this.bottoming = kerb && v > 50 && this.setup.frontRide < 18 ? 1 : 0;
  }

  get inPitLane() { return this.ignorePitWall; }

  collideBarriers() {
    const track = this.track, tp = this.trackPos;
    const half = 1.0;
    const sideL = -track.barrierAt(tp.s, -1) + half;
    const sideR = track.barrierAt(tp.s, 1) - half;
    let limitHi = sideR, limitLo = sideL;
    if (!this.ignorePitWall && track.hasPitWall(tp.s) && tp.d < track.pit.wallOffset + 1.5) {
      limitHi = Math.min(limitHi, track.pit.wallOffset - half);
    }
    if (tp.d > limitHi || tp.d < limitLo) {
      const side = tp.d > limitHi ? 1 : -1;
      const target = side > 0 ? limitHi : limitLo;
      const push = target - tp.d;
      const i = tp.i;
      const nx = track.rx[i] * -side, nz = track.rz[i] * -side; // normal pointing back into track
      this.x += track.rx[i] * push;
      this.z += track.rz[i] * push;
      // world velocity
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      let wx = this.vx * c - this.vy * s;
      let wz = this.vx * s + this.vy * c;
      const vn = wx * nx + wz * nz; // negative => moving into wall
      if (vn < 0) {
        const impact = -vn;
        wx -= (1.25) * vn * nx;
        wz -= (1.25) * vn * nz;
        // scrub tangential speed
        const scrub = clamp(1 - impact * 0.03, 0.5, 0.98);
        wx *= scrub; wz *= scrub;
        this.vx = wx * c + wz * s;
        this.vy = -wx * s + wz * c;
        this.r *= 0.5;
        this.r += side * clamp(impact * 0.05, 0, 1.5) * (this.vx > 0 ? 1 : -1);
        if (impact > 2) this.events.push({ type: 'wall', impact, side, front: Math.abs(this.trackPos.heading - this.yaw) });
      }
      this.track.project(this.x, this.z, tp.i, tp);
    }
  }

  applyDamage(amount, where = 'front') {
    const d = this.damage;
    if (where === 'front') d.frontWing = Math.min(1, d.frontWing + amount);
    else if (where === 'rear') d.rearWing = Math.min(1, d.rearWing + amount);
    else d.floor = Math.min(1, d.floor + amount);
  }

  /** Snapshot for HUD/telemetry */
  telemetry() {
    return {
      speed: this.speedKph, rpm: this.rpm, gear: this.reverse ? 'R' : this.gear,
      throttle: this.throttleIn, brake: this.brakeIn,
      battery: this.batteryFrac, deploy: this.lapDeployFrac, ersMode: this.ersMode,
      fuel: this.fuel, drs: this.drsOpen, drsAllowed: this.drsAllowed,
      gLat: this.ay / G, gLon: this.ax / G,
    };
  }
}

export { RATIOS, WHEEL_R, STEER_MAX, BATTERY_MAX };
