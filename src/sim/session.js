// Session engine: practice, qualifying (knockout or single), race and time trial.
// Owns the fixed-step simulation loop, timing & scoring, race control (flags, SC, VSC, penalties,
// track limits, blue flags, DRS), pit stops, strategy, collisions and the engineer radio.
import { clamp, makeRng, wrapAngle, formatTime, ordinal } from './util.js';
import { CarPhysics, CAR_LENGTH } from './car.js';
import { AIDriver } from './ai.js';
import { speedProfile } from './profile.js';
import { Weather } from './weather.js';
import { TyreSet, COMPOUNDS, idealCompoundFor } from './tyres.js';
import { planRace, aiPitDecision, pickDry, stintLife, playerPitWindow } from './strategy.js';
import { applyPreset } from './setup.js';
import { TEAMS } from '../data/teams.js';

export const STEP = 1 / 240;
const AI_EVERY = 2;

export const DEFAULT_SETTINGS = {
  laps: 5,
  difficulty: 85,
  weather: 'dynamic',
  wearScale: 'auto',
  damage: 'full',
  safetyCar: 'on',
  failures: true,
  penalties: 'on',
  qualiFormat: 'short',
  sessionMinutes: 12,
  ghost: true,
  startCompound: 'auto',
  assists: { abs: true, tc: 2, autoGears: true, steering: true, braking: 0, line: 'corners', pit: true, drsAuto: false },
};

export class Session {
  /**
   * opts: { track, type, entries: [{driver, team, isPlayer, setup, gridPos}], settings, seed, timeOfDay }
   */
  constructor(opts) {
    this.track = opts.track;
    this.type = opts.type; // practice | qualifying | race | timetrial
    this.settings = { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) };
    this.settings.assists = { ...DEFAULT_SETTINGS.assists, ...(opts.settings?.assists ?? {}) };
    this.rng = makeRng(opts.seed ?? 12345);
    this.time = 0; // session clock (s)
    this.events = []; // UI events: {type, ...}
    this.radioQueue = [];
    this.stepCount = 0;
    this.acc = 0;
    this.timeScale = 1;
    this.paused = false;
    this.finished = false;
    this.flags = { sector: [null, null, null], sc: false, vsc: false, red: false, chequered: false, green: true };
    this.safetyCar = null;
    this.vsc = null;
    this.drsEnabledLap = 2;
    this.raceStartTime = null;
    this.phase = 'init';
    this.fastestLap = null;
    this.overallBestSectors = [Infinity, Infinity, Infinity];
    this.lightsOn = 0;

    const L = this.track.length;
    this.raceLaps = this.type === 'race' ? this.settings.laps : 0;
    const fullLaps = this.track.def.laps;
    const ws = this.settings.wearScale;
    this.wearScale = ws === 'auto' ? (this.type === 'race' ? clamp(fullLaps / Math.max(1, this.raceLaps) * 0.6, 1, 6) : 1) : +ws;
    this.mustUseTwo = this.type === 'race' && this.raceLaps >= 8;
    this.sessionLength = this.type === 'race' ? this.raceLaps * 95 : this.settings.sessionMinutes * 60;
    if (this.type === 'qualifying' && this.settings.qualiFormat === 'full') this.sessionLength = (7 + 6 + 5) * 60;

    const climate = this.track.def.climate;
    const weatherTimeScale = this.type === 'race' ? clamp(fullLaps / Math.max(1, this.raceLaps) * 0.35, 1, 5) : clamp(3600 / this.sessionLength * 0.3, 1, 4);
    this.weather = opts.weather ?? new Weather({ mode: this.settings.weather, climate, duration: this.sessionLength * 1.3, seed: (opts.seed ?? 1) * 7 + 3, timeScale: weatherTimeScale });

    this.comps = (opts.entries ?? []).map((e, i) => this.makeCompetitor(e, i));
    this.player = this.comps.find((c) => c.isPlayer) ?? null;
    this.profiles = new Map();
    for (const c of this.comps) this.attachAI(c);
    this.setupSession();
  }

  makeCompetitor(e, i) {
    const team = TEAMS.find((t) => t.id === e.team) ?? TEAMS[0];
    const teamIndex = TEAMS.indexOf(team);
    const perf = e.perf ?? team.perf;
    const setup = e.setup ?? applyPreset(this.track.def.runoff === 'street' ? 'highDf' : 'balanced');
    const car = new CarPhysics({ track: this.track, perf, setup, compound: 'M' });
    car.wearScale = this.wearScale;
    if (e.isPlayer) Object.assign(car.assists, { abs: this.settings.assists.abs, tc: this.settings.assists.tc, autoGears: this.settings.assists.autoGears });
    return {
      id: i, driver: e.driver, team, teamIndex, isPlayer: !!e.isPlayer, car, ai: null,
      status: 'garage', lap: -1, lapStart: 0, lapValid: false, outLap: true,
      sector: 0, sectorStart: 0, curSectors: [null, null, null], lastSectors: [null, null, null], bestSectors: [Infinity, Infinity, Infinity],
      lastLap: null, bestLap: null, laps: [], bestLapPhase: null,
      warnings: 0, penaltyPending: 0, penaltyTotal: 0, penaltiesServed: 0,
      cross: [], gIndex: -1, totalDist: 0, position: i + 1, gapLeader: 0, interval: 0, lappedBy: 0,
      pit: { requested: false, compound: null, phase: null, stopAt: 0, timer: 0, wantGarage: false, repairWing: false, service: 0 },
      stops: 0, tyreHistory: [], usedCompounds: new Set(), plan: null, tyreLaps: 0,
      finishTime: null, finishOrder: null, retired: null, dnfLap: null,
      drsEligible: [], offTrack: false, offTimer: 0, onTimer: 0,
      blueTimer: 0, blue: false, topSpeed: 0, lastS: 0, startDelay: 0,
      quali: { state: 'garage', nextOut: 0, pushLaps: 0, eliminated: false, phaseBest: null },
      scPassCheck: null, vscOver: 0, lastPos: i + 1, gridPos: e.gridPos ?? i,
      gripMsgT: 0, setupName: e.setupName ?? null,
    };
  }

  profileFor(c) {
    const key = c.team.id + '|' + JSON.stringify(c.car.setup) + '|' + c.car.tyres.compound;
    let p = this.profiles.get(key);
    if (!p) {
      p = speedProfile(this.track, c.car.params, { compound: 'M', fuel: 25 });
      this.profiles.set(key, p);
    }
    return p;
  }

  attachAI(c) {
    const prof = this.profileFor(c);
    c.ai = new AIDriver(c, this.track, prof, makeRng(this.rng.int(1, 1e9)));
    c.ai.setDifficulty(c.isPlayer ? 100 : this.settings.difficulty);
    c.ai.pushLevel = 1;
  }

  // ------------------------------------------------------------------ setup
  setupSession() {
    const t = this.track;
    if (this.type === 'race') {
      const order = [...this.comps].sort((a, b) => a.gridPos - b.gridPos);
      const lapLen = t.length;
      order.forEach((c, k) => {
        const slot = t.gridSlot(k);
        c.car.placeAt(slot.x, slot.z, slot.heading);
        c.status = 'running';
        c.lap = -1;
        c.gridPos = k;
        c.car.frozen = true;
        c.lapValid = true;
        const fuelLaps = this.raceLaps + 1.6;
        c.car.fuel = clamp(fuelLaps * this.fuelPerLap(), 5, 110);
        c.plan = planRace(this.raceLaps, this.wearScale, lapLen, c.ai.rng, { pitLoss: this.pitLoss(), mustUseTwo: this.mustUseTwo });
        const w = this.weather.wetness;
        let compound = idealCompoundFor(w) ?? c.plan.stints[0].compound;
        if (c.isPlayer && this.settings.startCompound !== 'auto') compound = this.settings.startCompound;
        this.fitTyres(c, compound, false);
        c.startDelay = c.isPlayer ? 0 : 0.18 + c.ai.rng() * 0.3 * (1.2 - c.driver.skill);
        c.car.battery = 4e6 * 0.95;
      });
      this.phase = 'grid';
      this.phaseTimer = 0;
      this.lightsOutAt = 5 + 0.4 + this.rng() * 2.2;
      this.say(`Grid is formed at ${this.track.name}. ${this.raceLaps} laps. Track is ${this.weather.wetness > 0.2 ? 'wet' : 'dry'}, ${Math.round(this.weather.trackTemp)}°C.`, 2);
      if (this.player) {
        const st = this.player.plan.stints.map((s) => `${COMPOUNDS[s.compound].name} (${s.laps})`).join(' → ');
        this.say(`Plan A: ${st}.`, 1);
      }
    } else if (this.type === 'timetrial') {
      const c = this.player;
      const st = t.toWorld(t.pit.exitS + 40, 0);
      c.car.placeAt(st.x, st.z, st.heading);
      const sd = t.toWorld(-60, 0);
      void sd;
      c.status = 'running';
      c.lap = -1;
      c.outLap = true;
      c.lapValid = false;
      c.car.fuel = 20;
      this.fitTyres(c, this.settings.startCompound === 'auto' ? 'S' : this.settings.startCompound, false);
      c.car.tyres.temp.fill(COMPOUNDS[c.car.tyres.compound].optTemp - 5);
      c.car.battery = 4e6;
      this.phase = 'running';
      this.weather.wetness = 0;
      this.say('Time trial. Track is yours — push when ready.', 1);
    } else {
      // practice / qualifying: everybody starts in the garage
      this.phase = 'running';
      this.qPhase = 0;
      this.qPhases = this.type === 'qualifying' ? this.buildQualiPhases() : [{ name: 'Practice', duration: this.sessionLength, cut: 0 }];
      this.phaseEndTime = this.qPhases[0].duration;
      for (const c of this.comps) {
        c.status = 'garage';
        if (!c.isPlayer) {
          c.quali.nextOut = this.aiRunSchedule(c, 0);
        }
      }
      if (this.type === 'qualifying') this.say(`${this.qPhases[0].name} is underway. ${this.qPhases.length > 1 ? 'Bottom five are eliminated.' : 'Set your best lap.'}`, 2);
      else this.say('Practice session is green. Use the time to dial in the setup.', 1);
    }
  }

  buildQualiPhases() {
    const f = this.settings.qualiFormat;
    if (f === 'full') {
      const n = this.comps.length;
      return [
        { name: 'Q1', duration: 7 * 60, cut: Math.max(0, n - 15) },
        { name: 'Q2', duration: 6 * 60, cut: Math.max(0, Math.min(5, n - 10)) },
        { name: 'Q3', duration: 5 * 60, cut: 0 },
      ];
    }
    if (f === 'oneshot') return [{ name: 'One-Shot Qualifying', duration: 6 * 60, cut: 0, oneShot: true }];
    return [{ name: 'Qualifying', duration: this.settings.sessionMinutes * 60, cut: 0 }];
  }

  aiRunSchedule(c, phaseStart) {
    const ph = this.qPhases[this.qPhase];
    const lapEst = this.profileFor(c).lapTime * 1.04;
    const dur = ph.duration;
    const r = c.ai.rng();
    if (this.type === 'qualifying') {
      // first run early, final run timed to start the push lap with a little margin
      if (!c.quali.didFirst && dur > lapEst * 6) return phaseStart + dur * (0.05 + 0.3 * r);
      return phaseStart + Math.max(0, dur - lapEst * (3.3 + r * 0.8));
    }
    return phaseStart + dur * 0.02 + r * Math.min(dur * 0.4, 240);
  }

  fuelPerLap() { return 2.05 * this.track.length / 5000; }
  pitLoss() { return 20 + this.track.pit.length / 30; }

  fitTyres(c, compound, used) {
    c.car.tyres = new TyreSet(compound, { startTemp: COMPOUNDS[compound].wet ? 45 : 72, used });
    c.tyreLaps = 0;
    c.tyreHistory.push({ compound, fromLap: Math.max(0, c.lap + 1) });
    if (!COMPOUNDS[compound].wet) c.usedCompounds.add(compound);
    else c.usedCompounds.add('WET');
  }

  // ------------------------------------------------------------------ public api
  setPlayerInput(inp) { this.playerInput = inp; }

  say(text, priority = 1, kind = 'radio') {
    this.events.push({ type: kind, text, priority, time: this.time });
  }

  /** Advance by real seconds (scaled by timeScale), returns number of steps */
  update(realDt) {
    if (this.paused || this.finished) return 0;
    this.acc += Math.min(realDt, 0.1) * this.timeScale;
    let n = 0;
    const maxSteps = Math.ceil(240 * 0.1 * Math.max(1, this.timeScale));
    while (this.acc >= STEP && n < maxSteps) {
      this.step();
      this.acc -= STEP;
      n++;
      if (this.finished) break;
    }
    if (n >= maxSteps) this.acc = 0;
    return n;
  }

  /** Fast-forward headlessly (used for "skip to end"). */
  simulate(seconds) {
    const steps = Math.round(seconds / STEP);
    for (let i = 0; i < steps && !this.finished; i++) this.step();
  }

  requestPit(c, compound, wantGarage = false) {
    if (!c || c.status !== 'running') return;
    c.pit.requested = true;
    c.pit.compound = compound ?? c.pit.compound ?? c.car.tyres.compound;
    c.pit.wantGarage = wantGarage;
    if (c.isPlayer) this.say(wantGarage ? 'Copy, come back to the garage.' : `Box, box. ${COMPOUNDS[c.pit.compound].name}s ready.`, 2);
  }

  cancelPit(c) {
    if (c.pit.phase === null || c.pit.phase === 'approach') { c.pit.requested = false; c.pit.phase = null; if (c.isPlayer) this.say('Pit stop cancelled. Stay out.', 1); }
  }

  /** Player leaves the garage (practice/qualifying). */
  leaveGarage(c, opts = {}) {
    if (c.status !== 'garage' || this.type === 'race') return false;
    if (this.type === 'qualifying' && (c.quali.eliminated || this.phaseOver)) return false;
    const t = this.track;
    if (opts.setup) c.car.setSetup(opts.setup);
    if (c.isPlayer) this.profiles.clear();
    const compound = opts.compound ?? (this.weather.wetness > 0.2 ? idealCompoundFor(this.weather.wetness) : 'S');
    this.fitTyres(c, compound, false);
    c.car.fuel = opts.fuel ?? (this.type === 'qualifying' ? 4 + this.fuelPerLap() * 3 : 30);
    c.car.damage = { frontWing: 0, rearWing: 0, floor: 0, engine: 0, gearbox: 0 };
    const ps = t.boxProgress(c.teamIndex) + (c.isPlayer ? 0 : 0);
    const s = t.wrapS(t.pit.entryS + ps);
    const pos = t.toWorld(s, t.pit.boxOffset);
    c.car.placeAt(pos.x, pos.z, pos.heading);
    c.car.ignorePitWall = true;
    c.car.limiter = true;
    c.car.battery = 4e6;
    c.status = 'running';
    c.pit = { requested: false, compound: null, phase: 'exit', stopAt: ps, timer: 0, wantGarage: false, repairWing: false, service: 0 };
    c.lap = -1;
    c.outLap = true;
    c.lapValid = false;
    c.cross = [];
    c.gIndex = -1;
    c.curSectors = [null, null, null];
    c.ai.offset = 0;
    c.ai.lastD = null;
    return true;
  }

  // ------------------------------------------------------------------ main step
  step() {
    const dt = STEP;
    this.time += dt;
    this.stepCount++;
    if (this.stepCount % 24 === 0) {
      this.weather.update(dt * 24);
      for (const c of this.comps) {
        c.car.wetness = this.weather.wetness;
        c.car.trackTemp = this.weather.trackTemp;
        c.car.airTemp = this.weather.airTemp;
      }
    }
    if (this.type === 'race' && this.phase === 'grid') this.updateStartLights(dt);
    if (this.type === 'practice' || this.type === 'qualifying') this.updateSessionClock();

    const running = this.comps.filter((c) => c.status === 'running');
    if (this.stepCount % 4 === 0) this.updateProximity(running);

    for (const c of running) {
      const doAI = (this.stepCount + c.id) % AI_EVERY === 0;
      let inp;
      const aiControl = !c.isPlayer || this.playerOnAutopilot(c);
      if (aiControl) {
        if (doAI || !c.ai.input) inp = c.ai.update(dt * AI_EVERY, this.aiContext(c));
        else inp = c.ai.input;
      } else {
        inp = this.playerControl(c);
      }
      this.applyDrs(c, inp);
      if (c.retired) inp = this.retiredInput(c);
      c.car.step(dt, inp);
      if (c.finishTime != null && c.car.fuel < 2) c.car.fuel = 2;
      for (const e of c.car.events.splice(0)) this.handleCarEvent(c, e);
      if (c.car.frozen || this.phase === 'grid') c.ai.stuckTimer = 0;
      else if (!c.isPlayer && !c.retired && c.ai.stuckTimer > 6 && !c.pit.phase) this.recoverCar(c);
      this.updateTiming(c);
      this.updatePit(c, dt);
    }
    if (this.stepCount % 2 === 0) this.collisions(running);
    if (this.safetyCar) this.updateSafetyCar(dt);
    if (this.vsc) this.updateVSC(dt);
    if (this.stepCount % 30 === 0) {
      this.updateClassification();
      this.raceControl();
      this.engineer();
    }
  }

  playerOnAutopilot(c) {
    if (c.retired) return true;
    if (c.finishTime != null) return true;
    if (this.settings.assists.pit && c.pit.phase && c.pit.phase !== 'approach') return true;
    if (this.settings.assists.pit && c.pit.phase === 'approach' && this.track.wrapS(this.track.pit.entryS - c.car.trackPos.s) < 160) return true;
    if (this.forceAutopilot) return true;
    return false;
  }

  playerControl(c) {
    const pin = this.playerInput ?? { throttle: 0, brake: 0, steer: 0 };
    const inp = { ...pin };
    const a = this.settings.assists;
    // braking assist: blend in the AI's braking demand
    if (a.braking > 0 && c.ai) {
      const aiIn = c.ai.update(STEP, this.aiContext(c));
      if (aiIn.brake > 0.05) {
        inp.brake = Math.max(inp.brake ?? 0, aiIn.brake * (a.braking >= 2 ? 1 : 0.6));
        if (a.braking >= 2) inp.throttle = Math.min(inp.throttle ?? 0, 0.2);
      }
    }
    if (a.drsAuto) inp.drs = c.car.drsAllowed;
    return inp;
  }

  retiredInput(c) {
    // pull off to the side and stop
    const car = c.car;
    const side = car.trackPos.d >= 0 ? 1 : -1;
    const v = car.vx;
    const want = side * (this.track.halfWidth + 5);
    const err = want - car.trackPos.d;
    const steer = clamp(err * 0.04 - wrapAngle(car.yaw - car.trackPos.heading) * 1.2, -1, 1);
    return { throttle: v < 10 && Math.abs(err) > 2 && c.retired.reason !== 'Accident' ? 0.3 : 0, brake: c.retired.reason === 'Accident' || Math.abs(err) < 2 || v > 25 ? 0.8 : 0.1, steer: c.retired.reason === 'Accident' ? 0 : steer };
  }

  aiContext(c) {
    const ctx = this._ctx || (this._ctx = {});
    ctx.nearby = c.nearby ?? [];
    ctx.speedCap = 0;
    ctx.sc = !!this.safetyCar;
    ctx.noOvertake = !!this.safetyCar || !!this.vsc || this.phase === 'grid' || this.yellowAt(c.car.trackPos.s) === 2;
    ctx.qualifying = this.type === 'qualifying' || this.type === 'timetrial';
    ctx.manageErs = false;
    const pit = c.pit;
    const t = this.track;
    ctx.pit = null;
    if (pit.phase === 'lane' || pit.phase === 'box' || pit.phase === 'exit' || pit.phase === 'hold') {
      const ps = t.pitProgress(c.car.trackPos.s);
      ctx.pit = { active: true, ps: ps < 0 ? t.pit.length + 1 : ps, stopAt: pit.stopAt, toBox: pit.phase === 'lane' || pit.phase === 'hold', hold: pit.phase === 'box' || (pit.phase === 'hold' && ps >= pit.stopAt - 16) };
    } else if (pit.requested) {
      ctx.pit = { approach: true };
    }
    let cap = Infinity;
    if (this.safetyCar) cap = Math.min(cap, this.scFollowCap(c));
    if (this.vsc) cap = Math.min(cap, this.vscSpeed(c));
    const y = this.yellowAt(c.car.trackPos.s);
    if (y) cap = Math.min(cap, this.track.sampleArr(c.ai.profile.v, c.car.trackPos.s) * (y === 2 ? 0.8 : 0.92));
    if (this.phase === 'grid') cap = 0;
    if (c.finishTime != null || this.cooldown(c)) cap = Math.min(cap, this.track.sampleArr(c.ai.profile.v, c.car.trackPos.s) * 0.7);
    // practice/quali pace modes
    if ((this.type === 'qualifying' || this.type === 'practice') && !c.isPlayer) {
      c.ai.pushLevel = c.quali.state === 'push' ? 1 : c.quali.state === 'out' ? 0.6 : 0.4;
      if (c.quali.state !== 'push') cap = Math.min(cap, this.track.sampleArr(c.ai.profile.v, c.car.trackPos.s) * (c.quali.state === 'out' ? 0.88 : 0.8));
    }
    ctx.speedCap = cap === Infinity ? 0 : cap;
    return ctx;
  }

  cooldown(c) { return this.type !== 'race' && c.pit.wantGarage && !c.isPlayer; }

  // ------------------------------------------------------------------ race start
  updateStartLights(dt) {
    this.phaseTimer += dt;
    const lights = Math.min(5, Math.floor(this.phaseTimer));
    if (lights !== this.lightsOn && this.phaseTimer < this.lightsOutAt) {
      this.lightsOn = lights;
      this.events.push({ type: 'lights', n: lights });
    }
    if (this.phaseTimer >= this.lightsOutAt) {
      this.phase = 'racing';
      this.lightsOn = 0;
      this.raceStartTime = this.time;
      this.events.push({ type: 'lights', n: 0, out: true });
      this.say('Lights out and away we go!', 3, 'banner');
      for (const c of this.comps) {
        c.releaseAt = this.time + c.startDelay;
      }
    }
  }

  // ------------------------------------------------------------------ proximity, slipstream, DRS
  updateProximity(running) {
    const t = this.track, L = t.length;
    const n = running.length;
    for (const c of running) {
      if (c.car.frozen && c.releaseAt != null && this.time >= c.releaseAt) c.car.frozen = false;
      c.nearby = [];
      let tow = 0, dirty = 0;
      for (let j = 0; j < n; j++) {
        const o = running[j];
        if (o === c) continue;
        let ds = o.car.trackPos.s - c.car.trackPos.s;
        if (ds > L / 2) ds -= L;
        if (ds < -L / 2) ds += L;
        if (Math.abs(ds) > 90) continue;
        const inPitO = o.pit.phase && o.pit.phase !== 'approach';
        const inPitC = c.pit.phase && c.pit.phase !== 'approach';
        if (inPitO !== inPitC) continue;
        const dd = o.car.trackPos.d - c.car.trackPos.d;
        const blue = this.type === 'race' && ds > 0 && false;
        c.nearby.push({ entry: o, ds, d: o.car.trackPos.d, blue: this.isBlueFor(o, c) && ds < 0 ? true : blue, isSafetyCar: false });
        if (ds > 4 && ds < 50 && Math.abs(dd) < 2.4) {
          tow = Math.max(tow, ds < 12 ? 0.6 + (ds - 4) * 0.05 : 1 - (ds - 12) / 38);
          if (ds < 28) dirty = Math.max(dirty, 1 - ds / 28);
        }
      }
      // reversed sense of 'blue': if c is being lapped by a car behind
      for (const nb of c.nearby) nb.blue = nb.ds < 0 && this.isBlueFor(c, nb.entry);
      if (this.safetyCar && c.position === 1) {
        let ds = this.safetyCar.s - c.car.trackPos.s;
        if (ds < -L / 2) ds += L;
        if (ds > L / 2) ds -= L;
        if (ds > -10 && ds < 90) c.nearby.push({ entry: { car: this.safetyCar.car }, ds, d: this.safetyCar.d, isSafetyCar: true });
      }
      c.car.tow = clamp(tow, 0, 1);
      c.car.dirtyAir = clamp(dirty, 0, 1) * (Math.abs(t.sampleArr(t.curv, c.car.trackPos.s)) > 0.004 ? 1 : 0.3);
    }
  }

  /** is `c` (slower) required to let `o` (behind, a lap up) through? */
  isBlueFor(c, o) {
    if (this.type !== 'race' || !o || c === o) return false;
    if (!o.car || o.status !== 'running') return false;
    return o.totalDist - c.totalDist > this.track.length * 0.5;
  }

  drsEnabled() {
    if (this.type !== 'race') return this.weather.wetness < 0.35;
    if (this.phase !== 'racing' || this.safetyCar || this.vsc) return false;
    const leader = this.comps.find((c) => c.position === 1);
    if (!leader || leader.lap < this.drsEnabledLap) return false;
    return this.weather.wetness < 0.35;
  }

  applyDrs(c, inp) {
    const car = c.car, t = this.track;
    const zone = t.inDrsZone(car.trackPos.s);
    let allowed = false;
    if (zone >= 0 && !c.pit.phase && this.drsEnabled() && !this.yellowAt(car.trackPos.s)) {
      allowed = this.type === 'race' ? !!c.drsEligible[zone] : true;
    }
    car.drsAllowed = allowed;
    if (!allowed || (inp.brake ?? 0) > 0.05) car.drsOpen = false;
    else if (inp.drs) car.drsOpen = true;
  }

  // ------------------------------------------------------------------ timing & scoring
  updateTiming(c) {
    const t = this.track, car = c.car, L = t.length;
    const s = car.trackPos.s;
    const prev = c.lastS;
    c.lastS = s;
    c.topSpeed = Math.max(c.topSpeed, car.speedKph);
    // distance & minisector crossings
    const dist = c.lap * L + s;
    if (Math.abs(dist - c.totalDist) < 200 || c.totalDist === 0) c.totalDist = dist;
    const g = Math.floor((c.totalDist + L) / t.miniSectorLen);
    if (g > c.gIndex) { c.cross[g] = this.time; c.gIndex = g; }

    // sector crossings
    const sec = t.sectorOf(s);
    if (sec !== c.sector && !(prev > L - 80 && s < 80)) {
      if (sec === (c.sector + 1) % 3 && c.lap >= 0) {
        const st = this.time - c.sectorStart;
        c.curSectors[c.sector] = st;
        this.sectorDone(c, c.sector, st);
      }
      c.sector = sec;
      c.sectorStart = this.time;
    }
    // line crossing
    if (prev > L - 80 && s < 80 && car.vx > 0) {
      this.lineCrossed(c);
    } else if (prev < 80 && s > L - 80 && car.vx < 0) {
      // reversed over the line
      c.lap -= 1;
    }
    // track limits
    const off = car.offTrackWheels >= 4 && !(c.pit.phase && c.pit.phase !== 'approach');
    if (off) {
      c.offTimer += STEP;
      c.onTimer = 0;
      if (!c.offTrack && c.offTimer > 0.15) {
        c.offTrack = true;
        this.trackLimitViolation(c);
      }
    } else {
      c.onTimer += STEP;
      c.offTimer = 0;
      if (c.onTimer > 1) c.offTrack = false;
    }
  }

  sectorDone(c, k, time) {
    if (!c.lapValid) return;
    if (time < c.bestSectors[k]) c.bestSectors[k] = time;
    if (time < this.overallBestSectors[k]) this.overallBestSectors[k] = time;
    if (c.isPlayer) this.events.push({ type: 'sector', sector: k, time, best: time <= c.bestSectors[k], overall: time <= this.overallBestSectors[k] });
  }

  lineCrossed(c) {
    const t = this.track;
    const now = this.time;
    if (c.finishTime != null) return; // cool-down lap
    if (c.lap >= 0) {
      // complete sector 3
      const st = now - c.sectorStart;
      c.curSectors[2] = st;
      this.sectorDone(c, 2, st);
      const lapTime = now - c.lapStart;
      const valid = c.lapValid && !c.outLap;
      c.lastLap = lapTime;
      c.lastSectors = [...c.curSectors];
      c.laps.push({ time: lapTime, valid, sectors: [...c.curSectors], compound: c.car.tyres.compound, lap: c.lap + 1 });
      if (valid && (c.bestLap == null || lapTime < c.bestLap)) {
        c.bestLap = lapTime;
        if (c.isPlayer) this.events.push({ type: 'personalBest', time: lapTime });
      }
      if (valid && (this.type !== 'qualifying' || !c.quali.eliminated)) {
        if (c.quali.phaseBest == null || lapTime < c.quali.phaseBest) c.quali.phaseBest = lapTime;
      }
      if (valid && (!this.fastestLap || lapTime < this.fastestLap.time)) {
        this.fastestLap = { time: lapTime, comp: c, lap: c.lap + 1 };
        if (this.type === 'race' && c.lap >= 1) this.say(`Fastest lap: ${c.driver.name} ${formatTime(lapTime)}`, 1, 'info');
      }
      if (c.isPlayer) this.events.push({ type: 'lap', time: lapTime, valid, lap: c.lap + 1 });
      c.tyreLaps++;
      c.car.tyres.laps++;
    }
    c.lap += 1;
    c.lapStart = now;
    c.sectorStart = now;
    c.sector = 0;
    c.curSectors = [null, null, null];
    c.lapValid = true;
    c.outLap = false;
    c.car.newLap();
    if (c.isPlayer) this.events.push({ type: 'newLap', lap: c.lap });

    if (this.type === 'race') this.raceLineCrossing(c);
    else if (this.type === 'qualifying' || this.type === 'practice') this.qualiLineCrossing(c);
    void t;
  }

  raceLineCrossing(c) {
    if (c.lap >= 1 && c.lap < this.raceLaps) {
      // reliability: tiny chance of failure per lap
      if (this.settings.failures && !c.retired && (!c.isPlayer || this.settings.failures === 'all')) {
        const p = (1 - c.team.perf.reliability) * 0.012 * (30 / Math.max(10, this.raceLaps)) ** 0.5;
        if (c.ai.rng() < p) this.retire(c, c.ai.rng() < 0.5 ? 'Power Unit' : c.ai.rng() < 0.5 ? 'Gearbox' : 'Hydraulics');
      }
    }
    // chequered flag
    if (!this.flags.chequered) {
      const leader = this.comps.find((x) => x.position === 1);
      if (c.lap >= this.raceLaps && (c === leader || c.totalDist >= (leader?.totalDist ?? 0) - 1)) {
        this.flags.chequered = true;
        this.say(`Chequered flag! ${c.driver.name} wins the ${this.track.def.short ?? this.track.name} Grand Prix!`, 3, 'banner');
      }
    }
    if (this.flags.chequered && c.finishTime == null && !c.retired && c.lap >= 1) {
      c.finishTime = this.time - this.raceStartTime;
      c.finishOrder = this.comps.filter((x) => x.finishTime != null).length;
      if (c.isPlayer) {
        const pos = this.comps.filter((x) => x.finishTime != null).length;
        this.say(`That's the flag. P${pos}${pos <= 3 ? ' — podium!' : ''} Great job.`, 3);
        this.events.push({ type: 'finished', position: pos });
      }
    }
    if (c.lap === this.raceLaps - 1 && c.isPlayer && !this.flags.chequered) this.say('Final lap! Bring it home.', 2, 'banner');
    if (c.lap === this.raceLaps - 1 && c.position === 1) this.events.push({ type: 'flag', flag: 'white' });
    // pit decision for AI at the start of each lap
    if (!c.isPlayer && !c.retired && c.finishTime == null && c.lap >= 1 && !c.pit.requested) {
      const comp = aiPitDecision({
        lap: c.lap, totalLaps: this.raceLaps, wear: c.car.tyres.maxWear(), compound: c.car.tyres.compound,
        wetness: this.weather.wetness, rainSoon: this.weather.rainEta(300) < 200, sc: !!this.safetyCar, vsc: !!this.vsc,
        plan: c.plan, stops: c.stops, usedCompounds: c.usedCompounds, damage: c.car.damage.frontWing, wearScale: this.wearScale,
        lapLen: this.track.length, tyreLaps: c.tyreLaps, mustUseTwo: this.mustUseTwo,
      }, c.ai.rng);
      if (comp) this.requestPit(c, comp);
    }
    // DRS detection happens at detection points; also clear on line
    this.checkFinish();
  }

  qualiLineCrossing(c) {
    const ph = this.qPhases[this.qPhase];
    if (this.phaseOver && c.lap >= 1) {
      // chequered flag: back to the pits
      if (!c.isPlayer) this.requestPit(c, null, true);
      c.quali.state = 'in';
      if (c.isPlayer && !c.pit.requested) this.say('Chequered flag. Bring it back to the garage.', 2);
      return;
    }
    if (c.isPlayer) {
      if (ph.oneShot && c.lap >= 2) { this.requestPit(c, null, true); this.say('That was your one shot. Box.', 2); }
      return;
    }
    const st = c.quali;
    if (st.state === 'out') { st.state = 'push'; st.pushLaps = this.type === 'qualifying' ? (ph.oneShot ? 1 : 2) : 3 + Math.floor(c.ai.rng() * 5); }
    else if (st.state === 'push') {
      st.pushLaps--;
      if (st.pushLaps <= 0) { st.state = 'in'; this.requestPit(c, null, true); }
    }
  }

  checkFinish() {
    if (!this.flags.chequered) return;
    const active = this.comps.filter((c) => c.status === 'running' && !c.retired && c.finishTime == null);
    if (!active.length && !this.finished) this.endSession();
  }

  trackLimitViolation(c) {
    if (c.retired) return;
    // any lap with all four wheels off is deleted outside the race
    c.lapValid = false;
    if (this.type !== 'race') {
      if (c.isPlayer) this.say('Track limits — lap time deleted.', 1, 'warning');
      return;
    }
    if (this.settings.penalties === 'off' || this.phase !== 'racing') return;
    c.warnings++;
    if (c.warnings < 3) {
      if (c.isPlayer) this.say(`Track limits warning ${c.warnings}.`, 1, 'warning');
    } else if (c.warnings === 3) {
      if (c.isPlayer) { this.say('Black and white flag — one more and it is a penalty.', 2, 'warning'); this.events.push({ type: 'flag', flag: 'blackwhite' }); }
    } else {
      this.givePenalty(c, 5, 'Track limits');
    }
  }

  givePenalty(c, sec, reason) {
    if (this.settings.penalties === 'off') return;
    c.penaltyPending += sec;
    c.penaltyTotal += sec;
    this.say(`${c.isPlayer ? 'You have' : c.driver.name + ' has'} a ${sec} second time penalty — ${reason}.`, c.isPlayer ? 3 : 1, c.isPlayer ? 'penalty' : 'info');
  }

  /** Put a car back on the racing line (AI recovery, player "reset to track"). */
  recoverCar(c) {
    const t = this.track, car = c.car;
    const oldS = car.trackPos.s;
    let s = t.wrapS(oldS - 5);
    // find a gap in traffic
    for (let tries = 0; tries < 20; tries++) {
      const busy = this.comps.some((o) => o !== c && o.status === 'running' && Math.abs(t.deltaS(o.car.trackPos.s, s)) < 25);
      if (!busy) break;
      s = t.wrapS(s - 15);
    }
    const d = t.sampleArr(t.lineOff, s);
    const p = t.toWorld(s, d);
    car.placeAt(p.x, p.z, p.heading);
    car.gear = 1;
    car.reverse = false;
    c.ai.stuckTimer = 0;
    c.ai.lastD = null;
    c.ai.offset = 0;
    if (oldS + t.deltaS(oldS, car.trackPos.s) < 0) c.lap -= 1;
    c.lastS = car.trackPos.s;
    c.totalDist = c.lap * t.length + car.trackPos.s;
    if (c.isPlayer) this.events.push({ type: 'reset' });
  }

  // ------------------------------------------------------------------ pit stops
  updatePit(c, dt) {
    const t = this.track, car = c.car, p = c.pit;
    const s = car.trackPos.s;
    const ps = t.pitProgress(s);
    switch (p.phase) {
      case null:
        if (p.requested && c.status === 'running') {
          const dist = t.wrapS(t.pit.entryS - s);
          if (dist < 450 && dist > 20) p.phase = 'approach';
        }
        break;
      case 'approach': {
        if (ps >= 0 && ps < 40) {
          if (car.trackPos.d > t.halfWidth - 6) {
            p.phase = 'lane';
            car.ignorePitWall = true;
            car.limiter = true;
            car.drsOpen = false;
            p.stopAt = t.boxProgress(c.teamIndex);
            // stack behind a team-mate already in the box
            const mate = this.comps.find((o) => o !== c && o.team === c.team && (o.pit.phase === 'box' || o.pit.phase === 'hold' || (o.pit.phase === 'lane' && t.pitProgress(o.car.trackPos.s) < p.stopAt)));
            if (mate && mate.pit.phase !== 'lane') p.phase = 'hold';
            if (c.isPlayer) this.events.push({ type: 'pitEntry' });
          } else if (ps > 10) {
            p.phase = null; // missed it
            if (c.isPlayer) this.say('You missed the pit entry! We will try next lap.', 2, 'warning');
          }
        } else if (t.wrapS(t.pit.entryS - s) > 600) p.phase = null;
        break;
      }
      case 'hold': {
        const mate = this.comps.find((o) => o !== c && o.team === c.team && o.pit.phase === 'box');
        if (!mate) p.phase = 'lane';
        break;
      }
      case 'lane':
        if (ps >= 0 && Math.abs(ps - p.stopAt) < 1.5 && car.speed < 1.2) {
          p.phase = 'box';
          car.vx = car.vy = car.r = 0;
          p.timer = this.serviceTime(c);
          p.service = p.timer;
          if (c.penaltyPending > 0 && this.type === 'race') { c.penaltiesServed += c.penaltyPending; c.penaltyTotal -= c.penaltyPending; c.penaltyPending = 0; }
          this.events.push({ type: 'pitStop', comp: c.id, duration: p.timer });
        } else if (ps >= 0 && ps > p.stopAt + 5) {
          // overshot the box: carry on (no stop)
          p.phase = 'exit';
        }
        break;
      case 'box':
        car.vx = car.vy = car.r = 0;
        car.frozen = false;
        p.timer -= dt;
        if (p.timer <= 0) {
          if (p.wantGarage && this.type !== 'race') {
            this.toGarage(c);
            return;
          }
          if (p.compound) this.fitTyres(c, p.compound, false);
          if (p.repairWing) { car.damage.frontWing = 0; car.damage.rearWing = 0; }
          c.stops++;
          p.phase = 'exit';
          p.requested = false;
          if (c.isPlayer) this.say(`Go, go, go! ${p.service.toFixed(1)}s stop.`, 2);
        }
        break;
      case 'exit':
        if (ps < 0 || ps > t.pit.length - 2) {
          p.phase = null;
          p.requested = false;
          car.ignorePitWall = false;
          car.limiter = false;
          if (c.isPlayer) this.events.push({ type: 'pitExit' });
        } else if (ps > t.pit.limitEnd) car.limiter = false;
        break;
    }
  }

  serviceTime(c) {
    const p = c.pit;
    let t = 0;
    const rng = c.ai.rng;
    if (p.compound || !p.wantGarage) t += 2.0 + (1 - c.team.pitCrew) * 3 + rng() * 0.5;
    if (rng() < 0.04) t += 1.5 + rng() * 4; // slow stop
    p.repairWing = c.car.damage.frontWing > 0.15 || c.car.damage.rearWing > 0.2;
    if (p.repairWing) t += 6.5;
    if (this.type === 'race') t += c.penaltyPending;
    if (p.wantGarage) t = 0.5;
    return t;
  }

  toGarage(c) {
    c.status = 'garage';
    c.pit = { requested: false, compound: null, phase: null, stopAt: 0, timer: 0, wantGarage: false, repairWing: false, service: 0 };
    c.car.ignorePitWall = false;
    c.car.limiter = false;
    c.car.vx = c.car.vy = c.car.r = 0;
    c.car.placeAt(1e6, 1e6, 0);
    if (!c.isPlayer) {
      c.quali.state = 'garage';
      c.quali.didFirst = true;
      const ph = this.qPhases[this.qPhase];
      const phaseStart = this.phaseStartTime ?? 0;
      const next = this.aiRunSchedule(c, phaseStart);
      c.quali.nextOut = next > this.time + 30 ? next : (this.type === 'practice' ? this.time + 60 + c.ai.rng() * 120 : Infinity);
      if (this.type === 'qualifying' && this.time > phaseStart + ph.duration - 60) c.quali.nextOut = Infinity;
    } else {
      this.events.push({ type: 'garage' });
    }
  }

  // ------------------------------------------------------------------ practice / qualifying clock
  updateSessionClock() {
    const ph = this.qPhases[this.qPhase];
    if (this.phaseStartTime == null) this.phaseStartTime = 0;
    const elapsed = this.time - this.phaseStartTime;
    this.phaseRemaining = Math.max(0, ph.duration - elapsed);
    if (!this.phaseOver && elapsed >= ph.duration) {
      this.phaseOver = true;
      this.phaseOverAt = this.time;
      this.say(`Chequered flag — ${ph.name} is over. Finish your lap.`, 2, 'banner');
      for (const c of this.comps) {
        if (c.status === 'running' && (c.lap < 0 || c.quali.state !== 'push') && !c.isPlayer) this.requestPit(c, null, true);
      }
    }
    // AI leaves garage
    if (!this.phaseOver && this.stepCount % 60 === 0) {
      for (const c of this.comps) {
        if (c.isPlayer || c.status !== 'garage' || c.quali.eliminated) continue;
        if (this.time >= c.quali.nextOut) {
          if (this.leaveGarage(c, { compound: this.weather.wetness > 0.2 ? idealCompoundFor(this.weather.wetness) : (this.type === 'qualifying' ? 'S' : ['S', 'M', 'H'][Math.floor(c.ai.rng() * 3)]), fuel: this.type === 'qualifying' ? undefined : 15 + c.ai.rng() * 40 })) {
            c.quali.state = 'out';
            c.quali.nextOut = Infinity;
          }
        }
      }
    }
    if (this.phaseOver) {
      const onTrack = this.comps.filter((c) => c.status === 'running');
      const timeout = this.time - this.phaseOverAt > 150;
      const playerDone = !this.player || this.player.status === 'garage';
      if ((!onTrack.length || timeout) && (playerDone || timeout)) this.endPhase();
    }
  }

  endPhase() {
    const ph = this.qPhases[this.qPhase];
    for (const c of this.comps) if (c.status === 'running') this.toGarage(c);
    const order = this.qualiOrder();
    if (ph.cut > 0 && this.qPhase < this.qPhases.length - 1) {
      const active = order.filter((c) => !c.quali.eliminated);
      const out = active.slice(active.length - ph.cut);
      out.forEach((c, k) => { c.quali.eliminated = true; c.quali.elimPhase = this.qPhase; c.quali.elimPos = active.length - ph.cut + k; });
      if (this.player && out.includes(this.player)) this.say(`We're out in ${ph.name}. P${this.qualiOrder().indexOf(this.player) + 1}.`, 3);
      else this.say(`${ph.name} complete. Eliminated: ${out.map((c) => c.driver.short).join(', ')}.`, 2);
      this.qPhase++;
      for (const c of this.comps) { c.quali.phaseBest = null; c.quali.didFirst = false; }
      this.phaseStartTime = this.time;
      this.phaseOver = false;
      for (const c of this.comps) if (!c.isPlayer && !c.quali.eliminated) { c.quali.nextOut = this.aiRunSchedule(c, this.time); c.quali.state = 'garage'; }
      this.say(`${this.qPhases[this.qPhase].name} is green.`, 2, 'banner');
      this.events.push({ type: 'phase', name: this.qPhases[this.qPhase].name });
    } else {
      this.endSession();
    }
  }

  qualiOrder() {
    // eliminated drivers keep their elimination position; active ones by phase best time
    const active = this.comps.filter((c) => !c.quali.eliminated);
    active.sort((a, b) => (a.quali.phaseBest ?? 1e9) - (b.quali.phaseBest ?? 1e9) || (a.bestLap ?? 1e9) - (b.bestLap ?? 1e9) || a.gridPos - b.gridPos);
    const out = this.comps.filter((c) => c.quali.eliminated).sort((a, b) => a.quali.elimPos - b.quali.elimPos);
    return [...active, ...out];
  }

  // ------------------------------------------------------------------ classification
  updateClassification() {
    let order;
    if (this.type === 'race') {
      order = [...this.comps].sort((a, b) => {
        const fa = a.finishTime != null, fb = b.finishTime != null;
        if (fa && fb) return a.finishOrder - b.finishOrder;
        if (fa !== fb) {
          // a finisher is ahead of anyone on the same or fewer laps
          return fa ? -1 : 1;
        }
        const ra = !!a.retired, rb = !!b.retired;
        if (ra !== rb) return ra ? 1 : -1;
        return b.totalDist - a.totalDist;
      });
    } else if (this.type === 'qualifying') {
      order = this.qualiOrder();
    } else {
      order = [...this.comps].sort((a, b) => (a.bestLap ?? 1e9) - (b.bestLap ?? 1e9) || a.id - b.id);
    }
    const leader = order[0];
    order.forEach((c, k) => {
      c.lastPos = c.position;
      c.position = k + 1;
      if (this.type === 'race') {
        const g = c.gIndex;
        const tl = leader.cross[g];
        c.gapLeader = tl != null && c.cross[g] != null ? c.cross[g] - tl : null;
        c.lappedBy = Math.floor((leader.totalDist - c.totalDist) / this.track.length + 0.0001);
        if (k > 0) {
          const ahead = order[k - 1];
          const ta = ahead.cross[g];
          c.interval = ta != null && c.cross[g] != null ? c.cross[g] - ta : null;
        } else c.interval = 0;
      } else {
        const best = leader.bestLap ?? leader.quali.phaseBest;
        const mine = this.type === 'qualifying' ? c.quali.phaseBest ?? c.bestLap : c.bestLap;
        c.gapLeader = best != null && mine != null ? mine - (this.type === 'qualifying' ? (leader.quali.phaseBest ?? best) : best) : null;
        c.interval = c.gapLeader;
      }
    });
    this.order = order;
    // DRS eligibility at detection points: gap to car ahead < 1 s
    if (this.type === 'race') {
      const t = this.track;
      for (const c of order) {
        for (let z = 0; z < t.drsZones.length; z++) {
          const det = t.drsZones[z].detect;
          const ds = t.wrapS(c.car.trackPos.s - det);
          if (ds < 40) c.drsEligible[z] = c.interval != null && c.interval > 0 && c.interval < 1.0 && c.position > 1;
        }
      }
      // SC overtaking check for player
      const p = this.player;
      if (p && (this.safetyCar || this.vsc) && p.lastPos && p.position < p.lastPos && !p.pit.phase) {
        const passed = order[p.position];
        if (passed && !passed.retired && !passed.pit.phase && passed.status === 'running') {
          this.givePenalty(p, 5, `overtaking under ${this.safetyCar ? 'the Safety Car' : 'VSC'}`);
        }
      }
      if (p && this.player.position !== this.player.lastPos && this.phase === 'racing') this.events.push({ type: 'position', from: p.lastPos, to: p.position });
    }
  }

  // ------------------------------------------------------------------ race control
  yellowAt(s) {
    const sec = this.track.sectorOf(s);
    return this.flags.sector[sec] === 'double' ? 2 : this.flags.sector[sec] === 'yellow' ? 1 : 0;
  }

  raceControl() {
    if (this.type === 'timetrial') return;
    const t = this.track;
    const flags = [null, null, null];
    for (const c of this.comps) {
      if (c.status !== 'running' || c.pit.phase) continue;
      const car = c.car;
      const stopped = car.speed < 8 && (this.phase !== 'grid') && !car.frozen;
      const spun = Math.abs(wrapAngle(car.yaw - car.trackPos.heading)) > 1.6;
      if (stopped || spun || c.retired) {
        const sec = t.sectorOf(car.trackPos.s);
        const onTrack = Math.abs(car.trackPos.d) < t.halfWidth + 1.5;
        if (Math.abs(car.trackPos.d) < t.halfWidth + 12) flags[sec] = onTrack ? 'double' : (flags[sec] ?? 'yellow');
      }
    }
    for (let k = 0; k < 3; k++) {
      if (flags[k] !== this.flags.sector[k]) {
        this.flags.sector[k] = flags[k];
        if (flags[k]) this.events.push({ type: 'flag', flag: flags[k] === 'double' ? 'doubleyellow' : 'yellow', sector: k });
      }
    }
    // player blue flags
    const p = this.player;
    if (p && this.type === 'race' && p.status === 'running') {
      const blue = (p.nearby ?? []).some((nb) => nb.ds < 0 && nb.ds > -60 && this.isBlueFor(p, nb.entry));
      if (blue && !p.blue) this.events.push({ type: 'flag', flag: 'blue' });
      p.blue = blue;
      if (blue) {
        p.blueTimer += 0.125;
        if (p.blueTimer > 20) { this.givePenalty(p, 5, 'ignoring blue flags'); p.blueTimer = 0; }
      } else p.blueTimer = Math.max(0, p.blueTimer - 0.25);
      // VSC compliance
      if (this.vsc && !p.pit.phase) {
        const lim = this.vscSpeed(p);
        if (p.car.vx > lim * 1.08 + 2) {
          p.vscOver += 0.125;
          if (p.vscOver > 1 && p.vscOver < 1.2) this.say('Watch the VSC delta!', 2, 'warning');
          if (p.vscOver > 4) { this.givePenalty(p, 5, 'VSC delta'); p.vscOver = 0; }
        } else p.vscOver = Math.max(0, p.vscOver - 0.0625);
      }
    }
  }

  retire(c, reason) {
    if (c.retired) return;
    c.retired = { reason, lap: c.lap + 1, time: this.time };
    c.dnfLap = c.lap;
    c.pit.requested = false;
    this.say(`${c.isPlayer ? 'We are out' : c.driver.name + ' is out'} — ${reason}.`, c.isPlayer ? 3 : 2, c.isPlayer ? 'banner' : 'info');
    if (this.type !== 'race') return;
    // decide on neutralisation
    if (this.settings.safetyCar === 'off' || this.flags.chequered || this.phase !== 'racing') return;
    const leader = this.order?.[0];
    if (leader && leader.lap >= this.raceLaps - 1) return;
    setTimeout0(() => {
      const t = this.track;
      const onTrack = Math.abs(c.car.trackPos.d) < t.halfWidth + 4;
      const r = this.rng();
      const scale = this.settings.safetyCar === 'reduced' ? 0.5 : 1;
      if (this.safetyCar || this.vsc) return;
      if (reason === 'Accident' && onTrack && r < 0.85 * scale) this.deploySafetyCar();
      else if (r < 0.55 * scale) this.deployVSC();
    }, this);
  }

  handleCarEvent(c, e) {
    if (e.type !== 'wall') return;
    const dmg = this.settings.damage;
    if (c.isPlayer) this.events.push({ type: 'impact', strength: e.impact });
    if (dmg === 'off') return;
    const mul = dmg === 'reduced' ? 0.5 : 1;
    if (e.impact > 9) {
      const front = e.front < 1.0;
      c.car.applyDamage((e.impact - 9) * 0.05 * mul, front ? 'front' : 'rear');
      if (c.isPlayer && c.car.damage.frontWing > 0.3) this.say(`Front wing damage ${Math.round(c.car.damage.frontWing * 100)}%. ${c.car.damage.frontWing > 0.5 ? 'Box this lap for a new nose.' : 'We can continue.'}`, 2, 'warning');
    }
    if (e.impact > 26 && dmg === 'full' && this.type !== 'timetrial') this.retire(c, 'Accident');
  }

  // ------------------------------------------------------------------ safety car / VSC
  deploySafetyCar() {
    const leader = this.order?.find((c) => !c.retired && c.status === 'running');
    if (!leader) return;
    const t = this.track;
    const sc = { s: t.wrapS(leader.car.trackPos.s + 180), d: 0, v: 30, lapsLeft: 2 + Math.floor(this.rng() * 2), lapsDone: 0, inThisLap: false, car: null };
    sc.car = { x: 0, z: 0, yaw: 0, vx: 30, vy: 0, r: 0, trackPos: { s: sc.s, d: 0 }, steer: 0, wheelRot: 0, tyres: { compound: 'M' }, drsOpen: false, brakeIn: 0, pitch: 0, roll: 0, isSafetyCar: true };
    this.safetyCar = sc;
    this.flags.sc = true;
    this.say('SAFETY CAR deployed. Slow down, no overtaking.', 3, 'banner');
    this.events.push({ type: 'flag', flag: 'sc' });
    this.updateSafetyCar(0);
  }

  scSpeedAt(s) {
    return Math.min(55, this.track.sampleArr(this.profileFor(this.order?.[0] ?? this.comps[0]).v, s) * 0.62);
  }

  updateSafetyCar(dt) {
    const sc = this.safetyCar, t = this.track;
    const leader = this.order?.find((c) => !c.retired && c.status === 'running' && c.finishTime == null);
    let target = this.scSpeedAt(sc.s);
    if (leader) {
      let gap = sc.s - leader.car.trackPos.s;
      if (gap < -t.length / 2) gap += t.length;
      if (gap > t.length / 2) gap -= t.length;
      // wait for the leader to catch up
      if (gap > 60) target *= 0.6;
    }
    sc.v += clamp(target - sc.v, -10 * dt, 6 * dt);
    const prevS = sc.s;
    sc.s = t.wrapS(sc.s + sc.v * dt);
    sc.d = t.sampleArr(t.lineOff, sc.s) * 0.5;
    if (prevS > t.length - 50 && sc.s < 50) {
      sc.lapsDone++;
      if (sc.lapsDone >= sc.lapsLeft) { sc.inThisLap = true; this.say('Safety car in this lap. Get ready for the restart.', 2, 'banner'); }
    }
    if (sc.inThisLap && t.pitProgress(sc.s) >= 0 && t.pitProgress(sc.s) < 30) {
      this.safetyCar = null;
      this.flags.sc = false;
      this.drsEnabledLap = (leader?.lap ?? 0) + 2;
      this.say('Safety car is in. Race resumes at the line!', 3, 'banner');
      this.events.push({ type: 'flag', flag: 'green' });
      return;
    }
    const pos = t.toWorld(sc.s, sc.d);
    Object.assign(sc.car, { x: pos.x, z: pos.z, yaw: pos.heading, vx: sc.v });
    sc.car.trackPos.s = sc.s; sc.car.trackPos.d = sc.d;
    sc.car.wheelRot += (sc.v / 0.36) * dt;
  }

  scFollowCap(c) {
    // queue behind the car ahead in the running order at ~25 m
    const t = this.track;
    const order = this.order ?? this.comps;
    const idx = order.indexOf(c);
    let aheadS = null, aheadV = 0;
    for (let k = idx - 1; k >= 0; k--) {
      const o = order[k];
      if (o.status === 'running' && !o.retired && !o.pit.phase && o.finishTime == null) { aheadS = o.car.trackPos.s; aheadV = o.car.vx; break; }
    }
    if (aheadS == null) { aheadS = this.safetyCar.s; aheadV = this.safetyCar.v; }
    let gap = aheadS - c.car.trackPos.s;
    if (gap < -t.length / 2) gap += t.length;
    if (gap > t.length / 2) gap -= t.length;
    if (gap < 0) return this.scSpeedAt(c.car.trackPos.s) * 0.7;
    const want = 22;
    return clamp(aheadV + (gap - want) * 0.6, 0, gap > 400 ? 80 : 60);
  }

  deployVSC() {
    this.vsc = { remaining: 55 + this.rng() * 50, ending: false };
    this.flags.vsc = true;
    this.say('VIRTUAL SAFETY CAR deployed. Respect the delta.', 3, 'banner');
    this.events.push({ type: 'flag', flag: 'vsc' });
  }

  vscSpeed(c) {
    return this.track.sampleArr(c.ai.profile.v, c.car.trackPos.s) * 0.6;
  }

  updateVSC(dt) {
    this.vsc.remaining -= dt;
    if (this.vsc.remaining < 10 && !this.vsc.ending) { this.vsc.ending = true; this.say('VSC ending.', 2, 'banner'); }
    if (this.vsc.remaining <= 0) {
      this.vsc = null;
      this.flags.vsc = false;
      const leader = this.order?.[0];
      this.drsEnabledLap = (leader?.lap ?? 0) + 2;
      this.say('Green flag — racing!', 2, 'banner');
      this.events.push({ type: 'flag', flag: 'green' });
    }
  }

  // ------------------------------------------------------------------ collisions
  collisions(running) {
    const n = running.length;
    const L = this.track.length;
    for (let i = 0; i < n; i++) {
      const a = running[i];
      if (a.car.frozen && this.phase === 'grid') continue;
      for (let j = i + 1; j < n; j++) {
        const b = running[j];
        let ds = b.car.trackPos.s - a.car.trackPos.s;
        if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
        if (Math.abs(ds) > 8) continue;
        const pa = !!(a.pit.phase && a.pit.phase !== 'approach'), pb = !!(b.pit.phase && b.pit.phase !== 'approach');
        if (pa !== pb) continue;
        if ((a.retired && Math.abs(a.car.trackPos.d) > this.track.halfWidth + 2) || (b.retired && Math.abs(b.car.trackPos.d) > this.track.halfWidth + 2)) continue;
        this.collidePair(a, b);
      }
    }
  }

  collidePair(A, B) {
    const a = A.car, b = B.car;
    const R = 0.95;
    const offs = [-1.85, 0, 1.85];
    let best = null;
    const ca = Math.cos(a.yaw), sa = Math.sin(a.yaw), cb = Math.cos(b.yaw), sb = Math.sin(b.yaw);
    for (const oa of offs) {
      const ax = a.x + ca * oa, az = a.z + sa * oa;
      for (const ob of offs) {
        const bx = b.x + cb * ob, bz = b.z + sb * ob;
        const dx = ax - bx, dz = az - bz;
        const d2 = dx * dx + dz * dz;
        if (d2 < 4 * R * R && (!best || d2 < best.d2)) best = { d2, dx, dz, oa, ob, ax, az, bx, bz };
      }
    }
    if (!best) return;
    const d = Math.sqrt(best.d2) || 0.01;
    const nx = best.dx / d, nz = best.dz / d; // from b to a
    const pen = 2 * R - d;
    const ma = a.mass, mb = b.mass;
    const wa = mb / (ma + mb), wb = ma / (ma + mb);
    a.x += nx * pen * wa; a.z += nz * pen * wa;
    b.x -= nx * pen * wb; b.z -= nz * pen * wb;
    // world velocities
    const vax = a.vx * ca - a.vy * sa, vaz = a.vx * sa + a.vy * ca;
    const vbx = b.vx * cb - b.vy * sb, vbz = b.vx * sb + b.vy * cb;
    // contact point velocities include yaw: v + r x p (right-positive yaw -> perpendicular)
    const rax = best.oa * ca, raz = best.oa * sa, rbx = best.ob * cb, rbz = best.ob * sb;
    const pvax = vax - a.r * raz, pvaz = vaz + a.r * rax;
    const pvbx = vbx - b.r * rbz, pvbz = vbz + b.r * rbx;
    const rel = (pvax - pvbx) * nx + (pvaz - pvbz) * nz;
    if (rel >= 0) return;
    const IZ = 1150;
    const crossA = rax * nz - raz * nx, crossB = rbx * nz - rbz * nx;
    const e = 0.25;
    const jImp = (-(1 + e) * rel) / (1 / ma + 1 / mb + (crossA * crossA) / IZ + (crossB * crossB) / IZ);
    const nvax = vax + (jImp / ma) * nx, nvaz = vaz + (jImp / ma) * nz;
    const nvbx = vbx - (jImp / mb) * nx, nvbz = vbz - (jImp / mb) * nz;
    a.vx = nvax * ca + nvaz * sa; a.vy = -nvax * sa + nvaz * ca;
    b.vx = nvbx * cb + nvbz * sb; b.vy = -nvbx * sb + nvbz * cb;
    a.r += (crossA * jImp) / IZ;
    b.r -= (crossB * jImp) / IZ;
    const impact = -rel;
    if (impact > 2) {
      this.events.push({ type: 'contact', a: A.id, b: B.id, impact, x: (best.ax + best.bx) / 2, z: (best.az + best.bz) / 2 });
      if (A.isPlayer || B.isPlayer) this.events.push({ type: 'impact', strength: impact });
    }
    if (this.settings.damage !== 'off' && impact > 5) {
      const mul = this.settings.damage === 'reduced' ? 0.5 : 1;
      if (best.oa > 1) a.applyDamage((impact - 5) * 0.04 * mul, 'front');
      if (best.ob > 1) b.applyDamage((impact - 5) * 0.04 * mul, 'front');
      if (best.oa < -1) a.applyDamage((impact - 5) * 0.02 * mul, 'rear');
      if (best.ob < -1) b.applyDamage((impact - 5) * 0.02 * mul, 'rear');
    }
    // blame: rear-ending with the nose
    if (this.type === 'race' && this.phase === 'racing' && impact > 7 && this.settings.penalties !== 'off') {
      const now = this.time;
      const atFault = best.oa > 1 && best.ob < 0 ? A : best.ob > 1 && best.oa < 0 ? B : null;
      if (atFault && atFault.isPlayer && (!atFault.lastBlame || now - atFault.lastBlame > 5)) {
        atFault.lastBlame = now;
        this.givePenalty(atFault, impact > 12 ? 10 : 5, 'causing a collision');
      }
    }
  }

  // ------------------------------------------------------------------ engineer
  engineer() {
    const p = this.player;
    if (!p || p.status !== 'running' || this.type === 'timetrial') return;
    const now = this.time;
    this._eng = this._eng || { lastGap: 0, rainWarned: false, wearWarned: 0, windowSaid: -1, wetSaid: false, lap: -1, fuelWarn: false };
    const E = this._eng;
    // weather
    const eta = this.weather.rainEta(600);
    if (eta < 600 && eta > 30 && !E.rainWarned && this.weather.wetness < 0.15) {
      E.rainWarned = true;
      this.say(`Radar shows rain in about ${Math.max(1, Math.round(eta / 60))} minute${eta > 90 ? 's' : ''}.`, 2);
    }
    if (eta === Infinity) E.rainWarned = false;
    const ideal = idealCompoundFor(this.weather.wetness);
    const onWet = COMPOUNDS[p.car.tyres.compound].wet;
    if (ideal && !onWet && this.weather.wetness > 0.22 && !E.wetSaid) { E.wetSaid = true; this.say(`Track is getting wet. Box for ${COMPOUNDS[ideal].name}s when ready.`, 3); }
    if (!ideal && onWet && this.weather.wetness < 0.12 && !E.wetSaid) { E.wetSaid = true; this.say('Track is drying — slicks are the tyre now.', 3); }
    if (ideal && onWet) E.wetSaid = false;
    if (!ideal && !onWet) E.wetSaid = false;
    // tyres
    const wear = p.car.tyres.maxWear();
    if (wear > 0.55 && E.wearWarned < 1) { E.wearWarned = 1; this.say(`Tyre wear ${Math.round(wear * 100)}%. Start thinking about the stop.`, 1); }
    if (wear > 0.72 && E.wearWarned < 2) { E.wearWarned = 2; this.say('Tyres are close to the cliff. Box soon!', 2); }
    if (wear < 0.2) E.wearWarned = 0;
    // race-only messages at lap boundaries
    if (this.type === 'race' && p.lap !== E.lap && p.lap >= 1) {
      E.lap = p.lap;
      const ahead = this.order?.[p.position - 2];
      if (p.lap % 3 === 0 && ahead && p.interval != null && p.interval < 5) this.say(`Gap to ${ahead.driver.short} ahead: ${p.interval.toFixed(1)}s.`, 1);
      const win = playerPitWindow({ compound: p.car.tyres.compound, wearScale: this.wearScale, lapLen: this.track.length, lap: p.lap, tyreLaps: p.tyreLaps });
      if (!onWet && p.lap === win.from && this.raceLaps - p.lap > 2 && E.windowSaid !== win.from) {
        E.windowSaid = win.from;
        const next = pickDry({ wearScale: this.wearScale, lapLen: this.track.length, usedCompounds: p.usedCompounds, mustUseTwo: this.mustUseTwo }, this.raceLaps - p.lap);
        this.say(`Pit window open. Suggest ${COMPOUNDS[next].name}s.`, 2);
      }
      const fuelNeed = (this.raceLaps - p.lap) * this.fuelPerLap();
      if (p.car.fuel < fuelNeed * 0.97 && !E.fuelWarn) { E.fuelWarn = true; this.say('Fuel is critical — switch to lean mix.', 2); }
      if (this.mustUseTwo && p.usedCompounds.size < 2 && this.raceLaps - p.lap <= 3 && this.weather.wetness < 0.2) this.say('Reminder: you must use two dry compounds this race.', 2, 'warning');
    }
    void now;
  }

  // ------------------------------------------------------------------ results
  endSession() {
    if (this.finished) return;
    this.updateClassification();
    this.finished = true;
    if (this.type === 'race') {
      // apply outstanding time penalties and the two-compound rule
      const pen = (c) => c.penaltyPending + (this.mustUseTwo && this.weather.wetness < 0.2 && !c.usedCompounds.has('WET') && c.usedCompounds.size < 2 && c.finishTime != null ? 10 : 0);
      const finishers = this.comps.filter((c) => c.finishTime != null);
      const leaderLaps = Math.max(...finishers.map((c) => c.lap));
      finishers.forEach((c) => { c.adjTime = c.finishTime + pen(c); c.extraPen = pen(c); });
      // order: laps desc, then adjusted time
      finishers.sort((a, b) => b.lap - a.lap || a.adjTime - b.adjTime);
      const dnf = this.comps.filter((c) => c.finishTime == null).sort((a, b) => b.totalDist - a.totalDist);
      this.results = [...finishers, ...dnf].map((c, k) => ({
        pos: k + 1, comp: c, driver: c.driver, team: c.team, isPlayer: c.isPlayer,
        time: c.adjTime ?? null, laps: c.lap,
        gap: c.adjTime != null ? (c.lap < leaderLaps ? `+${leaderLaps - c.lap} Lap${leaderLaps - c.lap > 1 ? 's' : ''}` : k === 0 ? formatTime(c.adjTime) : '+' + (c.adjTime - finishers[0].adjTime).toFixed(3)) : 'DNF',
        status: c.retired ? 'DNF' : c.finishTime == null ? 'DNF' : 'Finished',
        reason: c.retired?.reason ?? null,
        penalties: c.penaltyTotal + (c.extraPen ?? 0) + c.penaltiesServed,
        bestLap: c.bestLap, stops: c.stops, fastest: this.fastestLap?.comp === c,
        grid: c.gridPos + 1,
      }));
    } else if (this.type === 'qualifying') {
      const order = this.qualiOrder();
      this.results = order.map((c, k) => ({ pos: k + 1, comp: c, driver: c.driver, team: c.team, isPlayer: c.isPlayer, time: c.bestLap, phaseTime: c.quali.phaseBest, eliminated: c.quali.eliminated ? this.qPhases[c.quali.elimPhase]?.name : null }));
    } else {
      const order = [...this.comps].sort((a, b) => (a.bestLap ?? 1e9) - (b.bestLap ?? 1e9));
      this.results = order.map((c, k) => ({ pos: k + 1, comp: c, driver: c.driver, team: c.team, isPlayer: c.isPlayer, time: c.bestLap, laps: c.laps.length }));
    }
    this.events.push({ type: 'sessionEnd' });
  }

  /** Simulate the rest of a session without rendering (skip). Bounded for responsiveness. */
  skipToEnd(maxSeconds = 4000) {
    if (this.type === 'race' && this.player && !this.player.retired && this.player.finishTime == null) this.forceAutopilot = true;
    if (this.type !== 'race') {
      // player goes back to the garage; finish the clock
      if (this.player && this.player.status === 'running') this.toGarage(this.player);
    }
    const end = this.time + maxSeconds;
    while (!this.finished && this.time < end) this.step();
    if (!this.finished) this.endSession();
  }

  /** Estimated lap time for a competitor (used by session simulation and the UI). */
  estimateLap(c) { return this.profileFor(c).lapTime / (c.ai?.pace ?? 1); }

  positionLabel(c) { return ordinal(c.position); }

  stintLifeLaps(compound) { return stintLife(compound, this.wearScale, this.track.length); }
}

// run a callback on the next simulation tick (avoid recursion inside event handling)
function setTimeout0(fn, session) {
  session._deferred = session._deferred || [];
  session._deferred.push(fn);
  if (!session._deferHook) {
    session._deferHook = true;
    const orig = session.step.bind(session);
    session.step = function () {
      orig();
      const q = session._deferred.splice(0);
      for (const f of q) f();
    };
  }
}

export { CAR_LENGTH };
