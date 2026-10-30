// AI driver: follows the racing line with pure-pursuit steering, tracks a physics-derived speed
// profile with look-ahead braking, and layers race-craft on top (overtaking, defending, avoiding,
// yielding to blue flags, safety-car queueing, pit lane driving, mistakes and recovery).
import { clamp, wrapAngle, lerp } from './util.js';
import { STEER_MAX } from './car.js';
import { wetnessGrip, tempGrip, wearGrip, COMPOUNDS } from './tyres.js';

const WB = 3.6;

export class AIDriver {
  constructor(entry, track, profile, rng) {
    this.entry = entry; // competitor entry (has .car, .driver)
    this.car = entry.car;
    this.track = track;
    this.profile = profile; // { v, limits }
    this.rng = rng;
    const d = entry.driver;
    this.skill = d.skill ?? 0.9; // 0..1
    this.aggression = d.aggression ?? 0.5;
    this.consistency = d.consistency ?? 0.8;
    this.wetSkill = d.wetSkill ?? 0.8;
    this.pace = 1;
    this.offset = 0; // lateral bias from racing line
    this.offsetTarget = 0;
    this.passTimer = 0;
    this.mistakeTimer = 0;
    this.mistakeMul = 1;
    this.stuckTimer = 0;
    this.decisionTimer = 0;
    this.input = { throttle: 0, brake: 0, steer: 0, drs: false, overtake: false };
    this.mode = 'race'; // race | pit | sc | grid | cooldown | recover
    this.pushLevel = 1; // strategy: 0.97 conserve .. 1.0 push
    this.lastCornerIdx = -1;
    this.defendSide = 0;
  }

  setDifficulty(diff) {
    // difficulty 0..110 -> pace multiplier on profile speeds
    const base = 0.86 + 0.14 * clamp(diff / 100, 0, 1.1);
    this.pace = base * (0.975 + 0.025 * this.skill);
  }

  gripScale() {
    const car = this.car, ty = car.tyres;
    const c = COMPOUNDS[ty.compound];
    const wetG = wetnessGrip(ty.compound, car.wetness);
    const tF = (tempGrip(c, ty.temp[0]) + tempGrip(c, ty.temp[1])) / 2;
    const tR = (tempGrip(c, ty.temp[2]) + tempGrip(c, ty.temp[3])) / 2;
    const wG = wearGrip(ty.maxWear());
    let g = (wetG * Math.min(tF, tR) * wG) / wetnessGrip('M', 0);
    // wet skill: less confident drivers leave more margin in the rain
    if (car.wetness > 0.05) g *= 1 - (1 - this.wetSkill) * 0.08 * car.wetness - 0.14 * car.wetness;
    return g;
  }

  /**
   * ctx: { dt, nearby: [{entry, ds, dd, dv}], speedCap, pit: {active, ps, stopAt, release}, flags, sc, blueFor }
   */
  update(dt, ctx) {
    const car = this.car, track = this.track, tp = car.trackPos;
    const v = Math.max(0, car.vx);
    const inp = this.input;
    const s = tp.s;
    const grip = this.gripScale();
    // dirty air and running off-line both cost cornering grip
    const offLine = Math.abs(this.offset);
    const traffic = 1 - 0.1 * car.dirtyAir - Math.min(0.08, offLine * 0.018);
    const speedScale = Math.sqrt(Math.max(0.3, grip * traffic)) * this.pace * this.mistakeMul * (0.94 + 0.06 * this.pushLevel);

    // --- lateral target ---
    let targetOff = track.sampleArr(track.lineOff, s + 10);
    let speedCapLocal = Infinity;
    let pitMode = ctx.pit?.active;
    if (pitMode) {
      const ps = ctx.pit.ps;
      targetOff = track.pitLaneOffset(Math.min(track.pit.length, ps + 15));
      if (ctx.pit.toBox) {
        // drift towards box lane near the box
        const dBox = ctx.pit.stopAt - ps;
        if (dBox < 40 && dBox > -10) targetOff = lerp(targetOff, track.pit.boxOffset, clamp(1 - dBox / 40, 0, 1));
      }
    } else if (ctx.pit?.approach) {
      // line up for the pit entry on the right
      const dist = track.wrapS(track.pit.entryS - s);
      const want = track.halfWidth - 2.5;
      targetOff = lerp(targetOff, want, clamp(1 - (dist - 60) / 300, 0, 1));
    }

    // racecraft
    this.passTimer = Math.max(0, this.passTimer - dt);
    let followCap = Infinity;
    if (!pitMode && this.mode !== 'grid') {
      this.racecraft(ctx, s, v);
      followCap = this.followCap;
    } else if (pitMode) {
      // queue in the pit lane
      for (const nb of ctx.nearby) {
        if (nb.ds > 0 && nb.ds < 45 && Math.abs(nb.d - tp.d) < 2.6) {
          const gap = nb.ds - 6;
          followCap = Math.min(followCap, Math.sqrt(Math.max(0, Math.max(0, nb.entry.car.vx) ** 2 + 2 * 6 * (gap - 2))));
        }
      }
    }
    const lineHere = targetOff;
    let offTarget = this.absTarget != null ? this.absTarget - lineHere : this.offsetTarget;
    if (this.absTarget == null) {
      // stay close to the line through corners unless fighting side by side
      const curvHere = Math.abs(track.sampleArr(track.lineCurv, s + 20)) + Math.abs(track.sampleArr(track.lineCurv, s + 60));
      offTarget *= clamp(1 - (curvHere - 0.003) / 0.012, 0.15, 1);
    }
    const rate = this.alongside ? 4.5 : 3;
    this.offset += clamp(offTarget - this.offset, -rate * dt, rate * dt);
    if (!pitMode) {
      targetOff = clamp(targetOff + this.offset, -track.halfWidth + 1.1, track.halfWidth - 1.1);
      if (ctx.pit?.approach) targetOff = Math.max(targetOff, track.halfWidth - 3.5 - (track.wrapS(track.pit.entryS - s) > 250 ? 6 : 0));
    } else this.offset = 0;

    // --- steering: pure pursuit at look-ahead on (s+L, targetOff) ---
    const look = clamp(8 + v * 0.36, 8, 42);
    const tgt = track.toWorld(s + look, targetOff, this._tmp || (this._tmp = {}));
    const dx = tgt.x - car.x, dz = tgt.z - car.z;
    const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
    const lf = dx * cy + dz * sy; // forward
    const lr = -dx * sy + dz * cy; // right
    const ld2 = lf * lf + lr * lr;
    let delta = Math.atan((2 * WB * lr) / Math.max(1, ld2)) * 1.15;
    // PD on lateral error compensates understeer vs the kinematic model without oscillating
    const dNow = tp.d;
    const dDot = this.lastD == null ? 0 : (dNow - this.lastD) / Math.max(dt, 1e-3);
    this.lastD = dNow;
    this.dDot = (this.dDot ?? 0) + (clamp(dDot, -30, 30) - (this.dDot ?? 0)) * Math.min(1, dt * 10);
    const errNow = track.sampleArr(track.lineOff, s) + (pitMode ? 0 : this.offset) - dNow;
    if (!pitMode) delta += clamp(errNow * 0.008, -0.04, 0.04) - clamp(this.dDot * 0.003, -0.03, 0.03) * (v > 15 ? 1 : 0);
    // never steer far beyond the slip angle that gives peak grip
    const vs = Math.max(v, 5);
    const useful = Math.atan((WB * this.profile.limits.latMax(vs) * grip) / (vs * vs)) + 0.07;
    delta = clamp(delta, -useful, useful);
    // counter-steer only for genuine slides (normal cornering has a few degrees of body slip)
    const beta = Math.atan2(car.vy, Math.max(4, Math.abs(car.vx)));
    if (Math.abs(beta) > 0.08) delta += (beta - Math.sign(beta) * 0.08) * 0.9;
    let steer = clamp(delta / STEER_MAX, -1, 1);
    if (lf < 0) steer = lr > 0 ? 1 : -1; // facing backwards: full lock towards target

    // --- speed target with braking look-ahead ---
    const prof = this.profile.vCurve;
    const lim = this.profile.limits;
    // corner speed limit here; braking for what is ahead comes from the look-ahead below
    let vTarget = Math.min(track.sampleArr(prof, s + 2), track.sampleArr(prof, s + 6)) * speedScale;
    const brakeCap = lim.brakeMax(v) * 0.9 * Math.min(1, grip);
    const horizon = (v * v) / (2 * Math.max(8, brakeCap)) + 25;
    let need = 0;
    for (let d = 8; d < horizon; d += 6) {
      const vt = track.sampleArr(prof, s + d) * speedScale;
      if (vt < v) {
        const req = (v * v - vt * vt) / (2 * d);
        if (req > need) need = req;
      }
    }
    if (ctx.speedCap) speedCapLocal = ctx.speedCap;
    if (pitMode) {
      const pt = track.pit;
      const ps = ctx.pit.ps;
      speedCapLocal = Math.min(speedCapLocal, ps < pt.limitStart - 30 ? 30 : pt.speedLimit - 0.3);
      if (ps > pt.limitEnd) speedCapLocal = Infinity;
      if (ctx.pit.toBox) {
        const dBox = ctx.pit.stopAt - ps;
        if (dBox > -1) {
          const vStop = Math.sqrt(Math.max(0, 2 * 7 * Math.max(0, dBox - 0.5)));
          speedCapLocal = Math.min(speedCapLocal, vStop);
        }
        if (ctx.pit.hold) speedCapLocal = 0;
      }
      if (ctx.pit.hold) speedCapLocal = 0;
    }
    vTarget = Math.min(vTarget, speedCapLocal, followCap);
    if (ctx.pit?.approach) {
      const dist = track.wrapS(track.pit.entryS - s);
      if (dist < 200) vTarget = Math.min(vTarget, Math.sqrt(25 * 25 + 2 * 20 * Math.max(0, dist - 20)));
    }
    let throttle = 0, brake = 0;
    if (need > brakeCap * 0.55 && !pitMode) {
      brake = clamp((need - brakeCap * 0.45) / (brakeCap * 0.3), 0, 1);
    } else {
      const err = vTarget - v;
      if (err > 0) throttle = clamp(0.25 + err * 0.6, 0, 1);
      else if (err < -0.4) brake = clamp(-err * 0.22, 0, 1);
      else throttle = 0.15;
    }
    // traction: ease throttle when rear sliding
    if (Math.abs(beta) > 0.12 && v > 8) throttle *= 0.4;
    if (car.wheelSpinning[2] || car.wheelSpinning[3]) throttle *= 0.7;
    if (this.mode === 'grid') { throttle = 0.5; brake = 0; steer = 0; }
    inp.steer = steer;
    inp.throttle = throttle;
    inp.brake = brake;

    // DRS / ERS
    inp.drs = car.drsAllowed && brake === 0 && Math.abs(steer) < 0.15;
    inp.overtake = false;
    if (this.attacking && car.batteryFrac > 0.3 && !pitMode) inp.overtake = true;
    if (!ctx.manageErs) {
      car.ersMode = car.batteryFrac > 0.7 ? 2 : car.batteryFrac > 0.25 ? 1 : 0;
      if (ctx.qualifying) car.ersMode = car.batteryFrac > 0.1 ? 2 : 1;
    }

    // stuck / spun detection
    const headingErr = Math.abs(wrapAngle(car.yaw - tp.heading));
    if ((v < 2 && !pitMode && this.mode !== 'grid' && !(ctx.pit?.hold)) || headingErr > 2.2) this.stuckTimer += dt;
    else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);

    // occasional mistakes
    this.mistakeTimer -= dt;
    if (this.mistakeTimer <= 0) {
      this.mistakeTimer = 2 + this.rng() * 4;
      const p = (1 - this.consistency) * 0.06 * (1 + 2 * car.wetness) * (ctx.qualifying ? 1.5 : 1);
      this.mistakeMul = this.rng() < p ? 1.03 + this.rng() * 0.05 : 1;
    }
    return inp;
  }

  racecraft(ctx, s, v) {
    const track = this.track;
    const hw = track.halfWidth;
    const myD = this.car.trackPos.d;
    const lineHere = track.sampleArr(track.lineOff, s + 10);
    const lim = hw - 1.1;
    this.followCap = Infinity;
    this.attacking = false;
    let absTarget = null;
    let desiredOff = 0;
    const curvAhead = Math.abs(track.sampleArr(track.lineCurv, s + 80)) + Math.abs(track.sampleArr(track.lineCurv, s + 40));
    const straight = curvAhead < 0.004;
    let alongside = null;
    let threatBehind = null;
    for (const nb of ctx.nearby) {
      const ds = nb.ds; // + ahead
      const dd = nb.d - myD;
      const other = nb.entry.car;
      const ov = Math.max(0, other.vx);
      if (nb.blue && ds < 0 && ds > -70) {
        // being lapped: move off the line and lift a touch
        const side = lineHere > 0 ? -1 : 1;
        absTarget = side * (hw - 2);
        if (straight) this.followCap = Math.min(this.followCap, v * 0.985);
        continue;
      }
      if (Math.abs(ds) < 6.4 && Math.abs(dd) < 3.4 && (!alongside || Math.abs(ds) < Math.abs(alongside.ds))) alongside = nb;
      if (ds < -2 && ds > -30 && Math.abs(dd) < 3 && !nb.blue) threatBehind = nb;
      if (ds > 0 && ds < 160 && Math.abs(dd) < 2.4) {
        const gap = ds - 5.7;
        const closing = v - ov;
        const minGap = 3 + v * 0.07;
        let cap = gap > minGap ? Math.sqrt(ov * ov + 2 * 15 * (gap - minGap)) : ov - (minGap - gap) * 1.2;
        let passing = false;
        if (!ctx.noOvertake && !nb.isSafetyCar && closing > 0.3 && gap < 45 && (straight || this.aggression > 0.72 || closing > 8)) {
          const nextTurn = Math.sign(track.sampleArr(track.lineCurv, s + 120)) || 1;
          const roomR = lim - (nb.d + 3.2), roomL = (nb.d - 3.2) + lim;
          let side = this.passTimer > 0 && this.passSide ? this.passSide : (nextTurn > 0 ? (roomR >= 0 ? 1 : -1) : (roomL >= 0 ? -1 : 1));
          if ((side > 0 ? roomR : roomL) < 0) side = -side;
          if ((side > 0 ? roomR : roomL) >= 0) {
            passing = true;
            this.passSide = side;
            this.passTimer = 2;
            absTarget = nb.d + side * 3.2;
            this.attacking = straight && closing > 0;
          }
        }
        // until we are clear laterally, never drive into the car ahead
        if (!passing || Math.abs(dd) < 2.2) this.followCap = Math.min(this.followCap, Math.max(0, cap));
      }
    }
    if (alongside) {
      // hold our side with a car's width of space
      const dd = alongside.d - myD;
      const side = dd > 0 ? -1 : 1;
      const want = alongside.d + side * 3.1;
      const base = absTarget ?? lineHere + this.offset;
      absTarget = side < 0 ? Math.min(base, want) : Math.max(base, want);
      // outside car concedes in the corner
      const turn = Math.sign(track.sampleArr(track.lineCurv, s + 30));
      const outside = (turn > 0 && side < 0) || (turn < 0 && side > 0);
      if (!straight && outside && alongside.ds > -2) this.followCap = Math.min(this.followCap, Math.max(0, alongside.entry.car.vx) * 0.97);
      if (Math.abs(absTarget) > lim) {
        // squeezed against the edge: back out
        absTarget = clamp(absTarget, -lim, lim);
        if (alongside.ds > 0) this.followCap = Math.min(this.followCap, Math.max(0, alongside.entry.car.vx) * 0.95);
      }
    }
    if (absTarget == null && threatBehind && straight && !ctx.sc && this.aggression > 0.3) {
      // defend: one move towards the inside of the next corner
      const nextTurn = Math.sign(track.sampleArr(track.lineCurv, s + 150)) || 1;
      if (!this.defendSide) this.defendSide = nextTurn;
      desiredOff = this.defendSide * 2.2 * this.aggression;
    } else this.defendSide = 0;
    if (!alongside && this.passTimer === 0) this.passSide = null;
    this.alongside = !!alongside;
    this.absTarget = absTarget != null ? clamp(absTarget, -lim, lim) : null;
    this.offsetTarget = desiredOff;
  }
}
