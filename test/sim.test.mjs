// Headless simulation tests: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Track } from '../src/sim/track.js';
import { TRACKS, trackById } from '../src/data/tracks.js';
import { DRIVERS, TEAMS } from '../src/data/teams.js';
import { CarPhysics } from '../src/sim/car.js';
import { speedProfile } from '../src/sim/profile.js';
import { AIDriver } from '../src/sim/ai.js';
import { Session } from '../src/sim/session.js';
import { Weather } from '../src/sim/weather.js';
import { planRace, aiPitDecision } from '../src/sim/strategy.js';
import { wetnessGrip, idealCompoundFor } from '../src/sim/tyres.js';
import { computeCarParams, defaultSetup, applyPreset, sanitizeSetup } from '../src/sim/setup.js';
import { makeRng } from '../src/sim/util.js';
import { newCareer, applyRaceResult, buyUpgrade, careerEntries, driverStandings } from '../src/career.js';

const entries = () => DRIVERS.map((d, i) => ({ driver: d, team: d.team, gridPos: i }));

test('all circuits build, close and have sane geometry', () => {
  for (const def of TRACKS) {
    const t = new Track(def);
    assert.ok(t.length > 3800 && t.length < 6500, `${def.id} length ${t.length}`);
    for (let i = 0; i < t.n; i++) {
      const j = (i + 1) % t.n;
      const d = Math.hypot(t.px[j] - t.px[i], t.pz[j] - t.pz[i]);
      assert.ok(d > 1 && d < 3, `${def.id} sample spacing ${d} at ${i}`);
    }
    assert.ok(t.corners.length >= 8, `${def.id} corners`);
    assert.ok(t.drsZones.length >= 2);
    assert.ok(t.pit.length > 300 && t.pit.length < 900, `${def.id} pit length ${t.pit.length}`);
    // racing line stays on the road
    for (let i = 0; i < t.n; i++) assert.ok(Math.abs(t.lineOff[i]) <= t.halfWidth);
    // projection round trip
    const w = t.toWorld(1234, 2);
    const pr = t.project(w.x, w.z);
    assert.ok(Math.abs(pr.s - 1234) < 1 && Math.abs(pr.d - 2) < 0.2);
  }
});

test('car: top speed, acceleration and braking are in formula-car range', () => {
  const car = new CarPhysics({ compound: 'M', fuel: 30 });
  car.tyres.temp.fill(95);
  const dt = 1 / 240;
  let t = 0, t100 = null;
  while (t < 30) {
    car.step(dt, { throttle: 1, brake: 0, steer: 0 });
    car.tyres.temp.fill(95);
    t += dt;
    if (t100 == null && car.vx > 100 / 3.6) t100 = t;
  }
  const top = car.vx * 3.6;
  assert.ok(t100 > 1.8 && t100 < 3.6, `0-100 ${t100}`);
  assert.ok(top > 300 && top < 360, `top ${top}`);
  // braking from 300 km/h
  car.vx = 300 / 3.6;
  let dist = 0;
  while (car.vx > 1) { car.step(dt, { throttle: 0, brake: 1, steer: 0 }); dist += car.vx * dt; }
  assert.ok(dist > 70 && dist < 170, `brake distance ${dist}`);
});

test('tyres: wet compounds win in the wet, slicks in the dry', () => {
  assert.ok(wetnessGrip('S', 0) > wetnessGrip('I', 0));
  assert.ok(wetnessGrip('I', 0.45) > wetnessGrip('S', 0.45));
  assert.ok(wetnessGrip('W', 0.95) > wetnessGrip('I', 0.95));
  assert.equal(idealCompoundFor(0.05), null);
  assert.equal(idealCompoundFor(0.4), 'I');
  assert.equal(idealCompoundFor(0.9), 'W');
});

test('setup changes physics parameters in the expected direction', () => {
  const base = computeCarParams(defaultSetup());
  const low = computeCarParams(applyPreset('lowDrag'));
  const high = computeCarParams(applyPreset('highDf'));
  assert.ok(low.CdA < base.CdA && high.ClA > base.ClA);
  const s = sanitizeSetup({ frontWing: 999, brakeBias: 'x' });
  assert.equal(s.frontWing, 50);
  assert.equal(s.brakeBias, defaultSetup().brakeBias);
});

test('AI laps every circuit cleanly near the theoretical time', () => {
  for (const def of TRACKS) {
    const track = new Track(def);
    const car = new CarPhysics({ track, compound: 'M', fuel: 30 });
    const prof = speedProfile(track, car.params, { compound: 'M' });
    const ai = new AIDriver({ car, driver: { skill: 1, consistency: 1, wetSkill: 1, aggression: 0.5 } }, track, prof, makeRng(1));
    ai.setDifficulty(100);
    const st = track.toWorld(-30, 0);
    car.placeAt(st.x, st.z, st.heading);
    const dt = 1 / 240;
    let t = 0, lastS = car.trackPos.s, laps = -1, start = 0, lapTime = 0, offs = 0;
    while (laps < 2 && t < 400) {
      const inp = ai.update(dt, { nearby: [] });
      car.step(dt, inp);
      t += dt;
      if (car.offTrackWheels >= 4) offs++;
      const s = car.trackPos.s;
      if (lastS > track.length - 50 && s < 50) { if (laps >= 0) lapTime = t - start; laps++; start = t; }
      lastS = s;
    }
    assert.equal(laps, 2, `${def.id} did not complete laps`);
    assert.ok(lapTime < prof.lapTime * 1.08 && lapTime > prof.lapTime * 0.94, `${def.id} lap ${lapTime} vs ${prof.lapTime}`);
    assert.equal(offs, 0, `${def.id} went off track`);
  }
});

test('full race: finishes, classifies everyone, stops happen, no NaN', () => {
  const track = new Track(trackById('sierra'));
  const s = new Session({ track, type: 'race', entries: entries(), settings: { laps: 10, weather: 'clear' }, seed: 9 });
  let guard = 0;
  while (!s.finished && guard++ < 240 * 2400) s.step();
  assert.ok(s.finished, 'race finished');
  assert.equal(s.results.length, 20);
  const finishers = s.results.filter((r) => r.status === 'Finished');
  assert.ok(finishers.length >= 16, `finishers ${finishers.length}`);
  assert.ok(finishers.every((r) => r.laps === 10));
  // two-compound rule obeyed by the AI in a dry race of this length
  assert.ok(finishers.every((r) => r.comp.usedCompounds.size >= 2), 'two compounds');
  for (let k = 1; k < finishers.length; k++) assert.ok(finishers[k].time >= finishers[k - 1].time - 1e-6 || finishers[k].laps < finishers[k - 1].laps);
  for (const c of s.comps) assert.ok(Number.isFinite(c.car.x) && Number.isFinite(c.car.vx));
});

test('qualifying knockout (Q1/Q2/Q3) runs to completion with eliminations', () => {
  const track = new Track(trackById('kaltwald'));
  const s = new Session({ track, type: 'qualifying', entries: entries(), settings: { qualiFormat: 'full', weather: 'clear' }, seed: 3 });
  // shorten phases for the test
  s.qPhases.forEach((p) => { p.duration = 200; });
  s.phaseEndTime = 200;
  for (const c of s.comps) c.quali.nextOut = s.aiRunSchedule(c, 0);
  let guard = 0;
  while (!s.finished && guard++ < 240 * 2000) s.step();
  assert.ok(s.finished);
  const out = s.results.filter((r) => r.eliminated);
  assert.equal(out.length, 10);
  const timed = s.results.filter((r) => r.time != null);
  assert.ok(timed.length >= 15, `timed ${timed.length}`);
});

test('safety car deploys on an on-track accident and the field queues', () => {
  const track = new Track(trackById('aurora'));
  const s = new Session({ track, type: 'race', entries: entries(), settings: { laps: 6, weather: 'clear' }, seed: 4 });
  while (s.phase !== 'racing') s.step();
  s.simulate(40);
  s.rng = () => 0; // force neutralisation decisions
  const victim = s.order[10];
  victim.car.vx = 0;
  s.retire(victim, 'Accident');
  s.simulate(1);
  assert.ok(s.safetyCar, 'safety car out');
  s.simulate(60);
  for (const c of s.comps) if (c.status === 'running' && !c.retired) assert.ok(c.car.vx < 65, `${c.driver.short} too fast under SC: ${c.car.vx}`);
  let guard = 0;
  while (s.safetyCar && guard++ < 240 * 900) s.step();
  assert.equal(s.safetyCar, null, 'safety car came in');
});

test('pit stop: requested stop changes tyres and is counted', () => {
  const track = new Track(trackById('highland'));
  const s = new Session({ track, type: 'race', entries: entries().slice(0, 6), settings: { laps: 4, weather: 'clear' }, seed: 2 });
  const c = s.comps[2];
  while (s.phase !== 'racing') s.step();
  s.simulate(20);
  s.requestPit(c, 'H');
  let guard = 0;
  while (c.stops === 0 && guard++ < 240 * 400) s.step();
  assert.equal(c.stops, 1);
  assert.equal(c.car.tyres.compound, 'H');
});

test('weather evolves wetness with rain and dries out', () => {
  const w = new Weather({ mode: 'heavy', duration: 1000, seed: 1 });
  w.wetness = 0;
  for (let k = 0; k < 600; k++) w.update(1);
  assert.ok(w.wetness > 0.6);
  w.forecast = [{ t: 0, state: 'clear' }];
  for (let k = 0; k < 3000; k++) w.update(1);
  assert.ok(w.wetness < 0.1);
});

test('strategy: plans respect tyre life and react to rain', () => {
  const rng = makeRng(5);
  const plan = planRace(50, 1, 5000, rng, { mustUseTwo: true });
  assert.ok(plan.stints.length >= 2);
  assert.equal(plan.stints.reduce((a, s) => a + s.laps, 0), 50);
  const dec = aiPitDecision({ lap: 10, totalLaps: 30, wear: 0.2, compound: 'M', wetness: 0.45, rainSoon: false, sc: false, vsc: false, plan, stops: 0, usedCompounds: new Set(['M']), damage: 0, wearScale: 1, lapLen: 5000, tyreLaps: 10, mustUseTwo: true }, rng);
  assert.equal(dec, 'I');
});

test('career: points, resources and upgrades', () => {
  const c = newCareer({ name: 'Test', number: 5, teamId: TEAMS[5].id });
  const ents = careerEntries(c);
  assert.equal(ents.filter((e) => e.isPlayer).length, 1);
  const results = ents.map((e, k) => ({ pos: k + 1, isPlayer: e.isPlayer, driver: e.driver, team: TEAMS.find((t) => t.id === e.team), status: 'Finished' }));
  const before = c.resources;
  applyRaceResult(c, results, c.calendar[0]);
  assert.equal(c.round, 1);
  assert.ok(c.resources > before);
  const st = driverStandings(c);
  assert.equal(st[0].pts, 25);
  c.resources = 1000;
  assert.ok(buyUpgrade(c, 'aero'));
  assert.equal(c.upgrades.aero, 1);
});
