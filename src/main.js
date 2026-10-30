// Application controller: menus <-> sessions, race weekends, career flow, frame loop.
import { GameRenderer } from './render/renderer.js';
import { InputManager } from './input.js';
import { AudioEngine } from './audio.js';
import { Hud } from './ui/hud.js';
import { Menus, getTrack } from './ui/menus.js';
import { Session } from './sim/session.js';
import { Weather } from './sim/weather.js';
import { TRACKS } from './data/tracks.js';
import { TEAMS, DRIVERS } from './data/teams.js';
import { applyPreset, sanitizeSetup, computeCarParams } from './sim/setup.js';
import { speedProfile } from './sim/profile.js';
import { idealCompoundFor } from './sim/tyres.js';
import { pickDry } from './sim/strategy.js';
import { makeRng, clamp, formatTime } from './sim/util.js';
import { loadSave, writeSave, resetSave, newCareer, careerEntries, applyRaceResult, buyUpgrade, startNextSeason, practiceReward } from './career.js';

const isTouch = ('ontouchstart' in window || navigator.maxTouchPoints > 0) && matchMedia('(pointer: coarse)').matches;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

class App {
  constructor() {
    this.save = loadSave();
    this.input = new InputManager(this.save.settings);
    this.audio = new AudioEngine(this.save.settings);
    this.hud = new Hud(document.getElementById('hud'), this);
    this.menus = new Menus(document.getElementById('ui'), this);
    this.canvas = document.getElementById('gl');
    this.renderer = null;
    this.session = null;
    this.paused = false;
    this.towerMode = 'interval';
    this.last = performance.now();
    this.fps = 60;
    this.prof = { sim: 0, render: 0, frames: 0 };
    if (isTouch) document.body.classList.add('touch');
    document.body.insertAdjacentHTML('beforeend', '<div class="rotate-hint">Rotate your device to landscape to race.</div>');
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.session && !this.paused && !this.skipping) this.pause(); });
    window.addEventListener('pointerdown', () => this.audio.start(), { once: true });
    window.addEventListener('keydown', () => this.audio.start(), { once: true });
    this.menus.main();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------------ persistence / settings
  persist() { writeSave(this.save); }

  applySettings() {
    const s = this.save.settings;
    this.input.settings = s;
    this.audio.setVolumes({ master: s.master, engine: s.engine, sfx: s.sfx, radioVoice: s.radioVoice });
    if (this.renderer) this.renderer.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.renderer.pixelRatioCap) * s.resolutionScale);
    if (this.session) {
      Object.assign(this.session.settings.assists, s.assists);
      const p = this.session.player;
      if (p) Object.assign(p.car.assists, { abs: s.assists.abs, tc: s.assists.tc, autoGears: s.assists.autoGears });
      this.hud.el?.fps?.classList.toggle('hidden', !s.showFps);
    }
    this.persist();
  }

  resetAll() {
    resetSave();
    this.save = loadSave();
    this.applySettings();
    this.menus.toast('All data reset');
    this.menus.main();
  }

  qualityLevel() {
    const forced = new URLSearchParams(location.search).get('q');
    if (['low', 'medium', 'high'].includes(forced)) return forced;
    const q = this.save.settings.quality;
    if (q !== 'auto') return q;
    if (isTouch) return Math.min(screen.width, screen.height) < 500 ? 'low' : 'medium';
    return 'high';
  }

  ensureRenderer() {
    const q = this.qualityLevel();
    if (this.renderer && this.renderer.quality === q) return;
    if (this.renderer) { this.renderer.renderer.dispose(); this.renderer.renderer.forceContextLoss?.(); }
    // recreate the canvas to obtain a fresh context with the new antialias setting
    const fresh = this.canvas.cloneNode();
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
    this.renderer = new GameRenderer(this.canvas, { quality: q, resolutionScale: this.save.settings.resolutionScale });
  }

  getSetup(trackId) {
    const t = TRACKS.find((x) => x.id === trackId);
    return sanitizeSetup(this.save.setups[trackId] ?? applyPreset(t?.runoff === 'street' ? 'highDf' : 'balanced'));
  }

  storeSetup(trackId, st) { this.save.setups[trackId] = st; this.persist(); this.menus.toast('Setup saved'); }

  // ------------------------------------------------------------------ entries & weekends
  playerDriver() {
    const c = this.save.career;
    return { id: 'player', name: c?.driver.name ?? 'You', short: c?.driver.short ?? 'YOU', number: c?.driver.number ?? 2, skill: 1, aggression: 0.5, consistency: 1, wetSkill: 1 };
  }

  gpEntries(teamId) {
    const seat = DRIVERS.filter((d) => d.team === teamId)[1];
    return DRIVERS.map((d) => (d === seat ? { driver: { ...this.playerDriver(), team: teamId }, team: teamId, isPlayer: true } : { driver: d, team: d.team }));
  }

  lapsFor(trackId, v) {
    const t = TRACKS.find((x) => x.id === trackId);
    if (typeof v === 'number') return v;
    const frac = { p25: 0.25, p50: 0.5, p100: 1 }[v] ?? 0.25;
    return Math.max(3, Math.round(t.laps * frac));
  }

  sessionSettings(wk, type) {
    const s = this.save.settings;
    return {
      laps: wk.raceLaps, difficulty: wk.difficulty ?? s.difficulty, weather: wk.weather ?? 'dynamic',
      damage: s.damage, safetyCar: s.safetyCar, penalties: s.penalties, failures: s.failures,
      qualiFormat: wk.qualiFormat ?? 'short', sessionMinutes: type === 'practice' ? (wk.practiceMinutes ?? 15) : wk.qualiFormat === 'oneshot' ? 6 : 12,
      assists: { ...s.assists }, startCompound: wk.startCompound ?? 'auto',
    };
  }

  makeWeekend(o) {
    return { stageIdx: 0, results: {}, grid: null, seed: (Math.random() * 1e9) | 0, startCompound: 'auto', ...o };
  }

  startGrandPrix(q) {
    const stages = q.format === 'full' ? ['practice', 'qualifying', 'race'] : q.format === 'qr' ? ['qualifying', 'race'] : ['race'];
    const wk = this.makeWeekend({ mode: 'gp', trackId: q.track, teamId: q.team, entries: this.gpEntries(q.team), raceLaps: this.lapsFor(q.track, q.laps), stages, weather: q.weather, qualiFormat: q.quali, difficulty: q.difficulty });
    if (stages[0] === 'race') wk.grid = this.estimateGrid(wk);
    this.weekend = wk;
    this.menus.weekendHub(wk);
  }

  createCareer(st) {
    this.save.career = newCareer({ name: st.name, number: st.number, teamId: st.teamId, raceLength: st.raceLength, practice: st.practice !== '0', qualiFormat: st.quali });
    this.persist();
  }

  startCareerWeekend() {
    const c = this.save.career;
    const trackId = c.calendar[c.round];
    if (!c.weekend || c.weekend.trackId !== trackId) {
      c.weekend = this.makeWeekend({ mode: 'career', trackId, teamId: c.teamId, raceLaps: this.lapsFor(trackId, c.raceLength), stages: c.practice ? ['practice', 'qualifying', 'race'] : ['qualifying', 'race'], qualiFormat: c.qualiFormat, weather: 'dynamic' });
    }
    c.weekend.entries = careerEntries(c);
    this.weekend = c.weekend;
    this.persist();
    this.menus.weekendHub(c.weekend);
  }

  buyUpgrade(id) {
    if (buyUpgrade(this.save.career, id)) { this.persist(); this.audio.blip(1200); this.menus.toast('Upgrade installed'); }
  }

  nextSeason() { startNextSeason(this.save.career); this.persist(); }

  previewWeather(wk) {
    const t = TRACKS.find((x) => x.id === wk.trackId);
    return new Weather({ mode: wk.weather ?? 'dynamic', climate: t.climate, duration: 3600, seed: wk.seed * 7 + 3 + wk.stageIdx, timeScale: 1 });
  }

  /** Instant grid estimate (used when qualifying is skipped). */
  estimateGrid(wk) {
    const track = getTrack(wk.trackId);
    const rng = makeRng(wk.seed + 99);
    const diff = wk.difficulty ?? this.save.settings.difficulty;
    const base = 0.86 + 0.14 * clamp(diff / 100, 0, 1.1);
    const cache = new Map();
    const rows = wk.entries.map((e) => {
      const team = TEAMS.find((t) => t.id === e.team);
      const perf = e.perf ?? team.perf;
      const setup = e.isPlayer ? this.getSetup(wk.trackId) : applyPreset(track.def.runoff === 'street' ? 'highDf' : 'balanced');
      const key = JSON.stringify(perf) + JSON.stringify(setup);
      if (!cache.has(key)) cache.set(key, speedProfile(track, computeCarParams(setup, perf), { compound: 'S', fuel: 8 }).lapTime);
      const skill = e.isPlayer ? 0.9 : e.driver.skill;
      const time = cache.get(key) / (base * (0.975 + 0.025 * skill)) * (1 + rng.gauss() * 0.003);
      return { e, time };
    });
    rows.sort((a, b) => a.time - b.time);
    wk.estimated = rows;
    return rows.map((r) => r.e);
  }

  simulateStage(wk) {
    const stage = wk.stages[wk.stageIdx];
    if (stage === 'qualifying') {
      wk.grid = this.estimateGrid(wk);
      wk.results.qualifying = wk.estimated.map((r, k) => ({ pos: k + 1, driver: r.e.driver, team: TEAMS.find((t) => t.id === r.e.team), isPlayer: !!r.e.isPlayer, time: r.time }));
    }
    wk.stageIdx++;
    this.persist();
    this.menus.weekendHub(wk);
  }

  playStage(wk) {
    const stage = wk.stages[wk.stageIdx];
    const entries = (wk.grid ?? wk.entries).map((e, k) => ({ ...e, gridPos: k, setup: e.isPlayer ? this.getSetup(wk.trackId) : undefined }));
    const cfg = { trackId: wk.trackId, type: stage, entries, settings: this.sessionSettings(wk, stage), seed: wk.seed + wk.stageIdx * 13 };
    this.startSession(cfg, (session) => this.stageFinished(wk, session));
  }

  stageFinished(wk, session) {
    const stage = session.type;
    const slim = (session.results ?? []).map((r) => ({ pos: r.pos, driver: r.driver, team: r.team, isPlayer: r.isPlayer, time: r.time, status: r.status }));
    wk.results[stage] = slim;
    const p = session.player;
    const stats = this.save.stats;
    if (p) stats.distanceKm += p.car.distance / 1000;
    let extra = null;
    if (stage === 'qualifying') {
      const ent = (session.results ?? []).map((r) => wk.entries.find((e) => (e.isPlayer && r.isPlayer) || (!e.isPlayer && e.driver.id === r.driver.id)));
      wk.grid = ent.filter(Boolean);
      const me = session.results.find((r) => r.isPlayer);
      if (me?.pos === 1) stats.poles++;
    }
    if (stage === 'practice' && wk.mode === 'career' && p) {
      const rw = practiceReward(session, p);
      const pts = rw.reduce((a, b) => a + b.pts, 0);
      this.save.career.resources += pts;
      extra = { html: rw.map((r) => `<span class="stat"><b>+${r.pts}</b><span>${r.name}</span></span>`).join('') };
    }
    if (stage === 'race') {
      stats.races++;
      const me = session.results.find((r) => r.isPlayer);
      if (me && me.status === 'Finished') { if (me.pos === 1) stats.wins++; if (me.pos <= 3) stats.podiums++; }
      if (wk.mode === 'career') {
        const out = applyRaceResult(this.save.career, session.results, wk.trackId);
        extra = { html: `<span class="stat"><b>+${out.earned}</b><span>Resources</span></span><span class="stat"><b>P${out.expected}</b><span>Team target</span></span>${out.mateBeaten ? '<span class="stat"><b>✔</b><span>Beat team-mate</span></span>' : ''}` };
      }
    }
    this.persist();
    this.menus.results(session, extra, () => {
      wk.stageIdx++;
      if (stage === 'race' || wk.stageIdx >= wk.stages.length) {
        this.weekend = null;
        if (wk.mode === 'career') this.menus.career(); else this.menus.main();
      } else this.menus.weekendHub(wk);
      this.persist();
    });
  }

  startTimeTrial(q) {
    const team = TEAMS.find((t) => t.id === q.team);
    const entries = [{ driver: { ...this.playerDriver(), team: q.team }, team: q.team, isPlayer: true, setup: this.getSetup(q.track), perf: team.perf }];
    this.startSession({ trackId: q.track, type: 'timetrial', entries, settings: { ...this.sessionSettings({ raceLaps: 0, weather: 'clear' }, 'timetrial'), weather: 'clear' }, seed: 1, ttTeam: q.team }, () => this.menus.timeTrial());
  }

  // ------------------------------------------------------------------ session lifecycle
  async startSession(cfg, onEnd) {
    this.menus.loading('Preparing the circuit…', 0.1);
    await nextFrame();
    this.ensureRenderer();
    const track = getTrack(cfg.trackId);
    this.menus.loading('Building the field…', 0.4);
    await nextFrame();
    const session = new Session({ track, type: cfg.type, entries: cfg.entries, settings: cfg.settings, seed: cfg.seed });
    if (this.renderer.track !== track) {
      this.menus.loading('Rendering scenery…', 0.65);
      await nextFrame();
      this.renderer.loadTrack(track);
    }
    this.renderer.setSession(session);
    this.renderer.garageTeam = session.player?.teamIndex ?? 0;
    this.cfg = cfg;
    this.onSessionEnd = onEnd;
    this.session = session;
    this.paused = false;
    this.skipping = false;
    this.lap = { trace: [], best: null, ghostRec: null };
    // time trial ghost
    this.ghostData = null;
    if (cfg.type === 'timetrial') {
      const rec = this.save.timeTrial[cfg.trackId];
      if (rec?.ghost) {
        this.ghostData = rec.ghost;
        this.lap.best = rec.trace ?? null;
        this.renderer.setGhost(TEAMS.find((t) => t.id === rec.team)?.colors ?? ['#fff', '#fff', '#fff']);
      } else this.renderer.setGhost(null);
    } else this.renderer.setGhost(null);
    this.hud.attach(session);
    const touchEl = document.getElementById('touch');
    if (isTouch) { touchEl.classList.remove('hidden'); this.input.buildTouchUI(touchEl); } else touchEl.classList.add('hidden');
    document.body.classList.add('in-session');
    this.input.enabled = true;
    this.menus.loading('Ready', 1);
    await nextFrame();
    this.menus.clear();
    if (isTouch) { try { await document.documentElement.requestFullscreen?.(); await screen.orientation?.lock?.('landscape'); } catch { /* not supported */ } }
    if (cfg.type !== 'race') this.hud.pushRadio(cfg.type === 'timetrial' ? 'Out lap — warm the tyres and push from the line.' : 'In the garage. Pick tyres and go out when ready.', 'radio');
  }

  endSessionUI() {
    this.session = null;
    this.hud.detach();
    document.getElementById('touch').classList.add('hidden');
    document.body.classList.remove('in-session');
    this.audio.silence();
    this.paused = false;
    this.skipping = false;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }

  pause() {
    if (!this.session) return;
    this.paused = true;
    this.audio.silence();
    const s = this.session;
    this.menus.pause(s, {
      resume: () => { this.paused = false; this.input.tapped.clear(); this.menus.clear(); },
      restart: () => { const cfg = this.cfg, cb = this.onSessionEnd; this.endSessionUI(); this.startSession(cfg, cb); },
      skip: () => { this.paused = false; this.menus.clear(); this.skipSession(); },
      quit: () => {
        this.endSessionUI();
        if (this.weekend) this.menus.weekendHub(this.weekend);
        else if (this.cfg.type === 'timetrial') this.menus.timeTrial();
        else this.menus.main();
      },
    });
  }

  // ------------------------------------------------------------------ player actions (HUD callbacks)
  suggestCompound(s, p) {
    const ideal = idealCompoundFor(s.weather.wetness);
    if (ideal) return ideal;
    if (s.type !== 'race') return 'S';
    return pickDry({ wearScale: s.wearScale, lapLen: s.track.length, usedCompounds: p.usedCompounds, mustUseTwo: s.mustUseTwo }, s.raceLaps - Math.max(0, p.lap));
  }

  togglePit() {
    const s = this.session, p = s?.player;
    if (!p || s.type === 'timetrial' || p.status !== 'running') return;
    if (p.pit.requested) s.cancelPit(p);
    else s.requestPit(p, p.pit.compound ?? this.suggestCompound(s, p), s.type !== 'race');
  }

  returnToGarage() {
    const s = this.session, p = s?.player;
    if (!p || p.status !== 'running' || s.type === 'race' || s.type === 'timetrial') return;
    s.requestPit(p, null, true);
  }

  leaveGarage(compound, fuel) {
    const s = this.session, p = s.player;
    const fuelKg = s.type === 'qualifying' ? undefined : fuel === 'quali' ? 8 : fuel === 'race' ? 60 : 30;
    if (s.leaveGarage(p, { compound, fuel: fuelKg, setup: this.getSetup(s.track.id) })) {
      this.hud.pushRadio('Pit exit is clear. Limiter on until the line.', 'radio');
      this.renderer.camState.init = false;
    }
  }

  openSetupFromGarage() {
    const s = this.session;
    this.paused = true;
    this.menus.setup(s.track.id, this.getSetup(s.track.id), (st) => {
      this.storeSetup(s.track.id, st);
      s.player.car.setSetup(st);
      s.profiles.clear();
      s.attachAI(s.player);
      this.menus.clear();
      this.paused = false;
    });
  }

  skipSession() {
    const s = this.session;
    if (!s || this.skipping) return;
    if (s.type === 'practice') { if (s.player?.status === 'running') s.toGarage(s.player); s.endSession(); return; }
    if (s.type === 'timetrial') return;
    this.skipping = true;
    s.timeScale = 1;
    if (s.type === 'race') s.forceAutopilot = true;
    else if (s.player?.status === 'running') s.toGarage(s.player);
    this.menus.loading('Simulating…', 0);
  }

  resetCar() {
    const s = this.session, p = s?.player;
    if (!p || p.status !== 'running' || p.pit.phase) return;
    if (s.type === 'race' && p.car.speed > 3) { this.hud.pushRadio('Reset is only available when stopped.', 'warning'); return; }
    s.recoverCar(p);
    p.lapValid = false;
    this.renderer.camState.init = false;
  }

  // ------------------------------------------------------------------ frame loop
  frame(t) {
    requestAnimationFrame((tt) => this.frame(tt));
    const dt = Math.min(0.05, Math.max(0.0005, (t - this.last) / 1000));
    this.last = t;
    this.fps += (1 / dt - this.fps) * 0.05;
    const s = this.session;
    if (!s) return;
    if (this.skipping) return this.skipFrame();
    const p = s.player;
    const car = p?.car;
    const settings = this.save.settings;
    let inp = { throttle: 0, brake: 0, steer: 0 };
    if (!this.paused) {
      inp = this.input.poll(dt, car?.vx ?? 0, settings.assists);
      if (inp.pause) return this.pause();
      if (inp.camera) { const m = this.renderer.cycleCamera(); this.hud.showBanner(m === 'chaseFar' ? 'Chase far' : m.toUpperCase(), 700); }
      if (inp.mfd) this.hud.toggleMfd();
      if (inp.hud) this.hud.root.classList.toggle('hidden');
      if (car && p.status === 'running') {
        if (inp.pit) this.togglePit();
        if (inp.ersMode) { car.ersMode = (car.ersMode + 1) % 3; this.audio.blip(700); }
        if (inp.fuelMix) { car.fuelMix = (car.fuelMix + 1) % 3; this.audio.blip(600); }
        if (inp.reset) this.resetCar();
        if (!car.assists.autoGears) {
          if (inp.gearUp && car.gear < 8) car.gear++;
          if (inp.gearDown && car.gear > 1) car.gear--;
        }
      }
      s.setPlayerInput(inp);
      const t0 = performance.now();
      s.update(dt);
      this.prof.sim += performance.now() - t0;
    }
    // events
    const contacts = [];
    for (const e of s.events.splice(0)) {
      this.hud.handleEvent(e);
      if (e.type === 'radio' && e.priority >= 2) this.audio.radio(e.text);
      else if (e.type === 'radio' || e.type === 'penalty' || e.type === 'warning') this.audio.radio(e.priority >= 3 ? e.text : null);
      if (e.type === 'lights') this.audio.lights(e.n, e.out);
      if (e.type === 'impact') this.audio.impact(e.strength);
      if (e.type === 'contact') contacts.push(e);
      if (e.type === 'lap' && p) this.onPlayerLap(e);
      if (e.type === 'sessionEnd') return this.sessionEnded();
    }
    // lap delta trace & ghost
    let delta = null, ghostPose = null;
    if (p && p.status === 'running' && p.lap >= 0) {
      const tLap = s.time - p.lapStart;
      const bin = Math.floor(car.trackPos.s / 10);
      if (this.lap.trace[bin] == null && !p.outLap) this.lap.trace[bin] = tLap;
      if (this.lap.best && this.lap.best[bin] != null && !p.outLap) delta = tLap - this.lap.best[bin];
      if (s.type === 'timetrial') {
        const rec = this.lap.ghostRec ?? (this.lap.ghostRec = { x: [], z: [], yaw: [] });
        const k = Math.floor(tLap / 0.05);
        if (rec.x.length <= k && !p.outLap) { rec.x[k] = Math.round(car.x * 10) / 10; rec.z[k] = Math.round(car.z * 10) / 10; rec.yaw[k] = Math.round(car.yaw * 1000) / 1000; }
        if (this.ghostData && !p.outLap) {
          const g = this.ghostData;
          const f = tLap / 0.05, i = Math.floor(f);
          if (i + 1 < g.x.length) {
            const a = f - i;
            ghostPose = { x: g.x[i] + (g.x[i + 1] - g.x[i]) * a, z: g.z[i] + (g.z[i + 1] - g.z[i]) * a, yaw: g.yaw[i] + Math.atan2(Math.sin(g.yaw[i + 1] - g.yaw[i]), Math.cos(g.yaw[i + 1] - g.yaw[i])) * a, t: tLap };
          }
        }
      }
    }
    if (isTouch) document.getElementById('touch').classList.toggle('garage', !p || p.status !== 'running');
    // camera focus
    let focus = p && p.status === 'running' ? p : null;
    if (s.type === 'race' && p && (p.retired) && s.order) focus = s.order.find((c) => !c.retired && c.status === 'running') ?? focus;
    const lineProfile = p?.ai?.profile;
    this.renderer.update(dt, focus, { lookBack: inp.lookBack, lineMode: p && p.status === 'running' && !this.paused ? settings.assists.line : 'off', lineProfile, ghostPose, contacts });
    const t1 = performance.now();
    this.renderer.render();
    this.prof.render += performance.now() - t1;
    this.prof.frames++;
    this.hud.update(dt, { input: inp, renderer: this.renderer, delta, ghostTime: s.type === 'timetrial' ? this.save.timeTrial[s.track.id]?.time : null, fps: this.fps });
    if (focus) {
      const cam = this.renderer.camera;
      const yaw = this.renderer.cameraYaw();
      this.audio.update(focus, s.comps, { x: cam.position.x, z: cam.position.z, yaw }, s.weather, { paused: this.paused, cockpit: this.renderer.cameraMode === 'cockpit' || this.renderer.cameraMode === 'tcam', crowd: 0.015 });
    }
    else this.audio.silence();
  }

  onPlayerLap(e) {
    const s = this.session;
    const p = s.player;
    if (e.valid && (p.bestLap == null || e.time <= p.bestLap + 1e-6)) this.lap.best = this.lap.trace.slice();
    if (s.type === 'timetrial' && e.valid) {
      const rec = this.save.timeTrial[s.track.id];
      if (!rec || e.time < rec.time) {
        const g = this.lap.ghostRec;
        this.save.timeTrial[s.track.id] = { time: e.time, team: this.cfg.ttTeam, date: Date.now(), ghost: g, trace: this.lap.trace.slice() };
        this.ghostData = g;
        this.renderer.setGhost(TEAMS.find((t) => t.id === this.cfg.ttTeam).colors);
        this.persist();
        this.hud.showBanner(`New record  ${formatTime(e.time)}`, 3000);
        this.audio.blip(1400, 0.2, 0.2);
      }
    }
    this.lap.trace = [];
    this.lap.ghostRec = null;
  }

  skipFrame() {
    const s = this.session;
    const t0 = performance.now();
    while (!s.finished && performance.now() - t0 < 24) for (let k = 0; k < 60 && !s.finished; k++) s.step();
    let frac;
    if (s.type === 'race') frac = Math.min(1, ((s.order?.[0]?.lap ?? 0) + 1) / (s.raceLaps + 1));
    else {
      const total = s.qPhases.reduce((a, p) => a + p.duration, 0);
      const done = s.qPhases.slice(0, s.qPhase).reduce((a, p) => a + p.duration, 0) + (s.qPhases[s.qPhase].duration - (s.phaseRemaining ?? 0));
      frac = Math.min(1, done / total);
    }
    this.menus.loading(`Simulating ${s.type}… ${Math.round(frac * 100)}%`, frac);
    s.events.length = 0;
    if (s.finished) { this.menus.hideLoading(); this.sessionEnded(); }
  }

  sessionEnded() {
    const s = this.session;
    const cb = this.onSessionEnd;
    this.endSessionUI();
    this.menus.hideLoading();
    if (s.type === 'timetrial') { cb?.(s); return; }
    cb?.(s);
  }
}

window.app = new App();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

