// Headless single-car lap test: node tools/lapsim.mjs [trackId] [laps] [compound]
import { Track } from '../src/sim/track.js';
import { trackById } from '../src/data/tracks.js';
import { CarPhysics } from '../src/sim/car.js';
import { speedProfile } from '../src/sim/profile.js';
import { AIDriver } from '../src/sim/ai.js';
import { makeRng } from '../src/sim/util.js';

const track = new Track(trackById(process.argv[2] ?? 'aurora'));
const laps = +(process.argv[3] ?? 3);
const car = new CarPhysics({ track, compound: process.argv[4] ?? 'M', fuel: 30 });
car.wetness = +(process.env.WET ?? 0);
const prof = speedProfile(track, car.params, { compound: car.tyres.compound });
console.log(`${track.name}: ${track.length.toFixed(0)} m, profile lap ${prof.lapTime.toFixed(2)} s, vmax ${(Math.max(...prof.v) * 3.6).toFixed(0)} kph, vmin ${(Math.min(...prof.v) * 3.6).toFixed(0)}`);
const entry = { car, driver: { skill: 1, aggression: 0.5, consistency: 1, wetSkill: 1 } };
const ai = new AIDriver(entry, track, prof, makeRng(1));
ai.setDifficulty(+(process.env.DIFF ?? 100));
const st = track.toWorld(-30, 0);
car.placeAt(st.x, st.z, st.heading);
const dt = 1 / 240;
let t = 0, lap = -1, lapStart = 0, lastS = car.trackPos.s, maxOff = 0, offTime = 0, topV = 0, maxLat = 0, wall = 0;
let wearStart = 0;
while (lap < laps && t < 600) {
  const inp = ai.update(dt, { nearby: [] });
  car.drsAllowed = track.inDrsZone(car.trackPos.s) >= 0;
  car.drsOpen = car.drsAllowed && inp.drs;
  car.step(dt, inp);
  t += dt;
  const s = car.trackPos.s;
  if (lastS > track.length - 50 && s < 50) {
    if (lap >= 0) console.log(`lap ${lap + 1}: ${(t - lapStart).toFixed(3)} s  wear/lap ${(car.tyres.avgWear() - wearStart).toFixed(4)} temps ${car.tyres.temp.map(x => x.toFixed(0)).join('/')} fuel ${car.fuel.toFixed(1)} batt ${(car.batteryFrac * 100).toFixed(0)}% off ${offTime.toFixed(1)}s walls ${wall}`);
    lap++; lapStart = t; wearStart = car.tyres.avgWear(); offTime = 0; car.newLap();
  }
  lastS = s;
  maxOff = Math.max(maxOff, Math.abs(car.trackPos.d) - track.halfWidth);
  if (car.offTrackWheels >= 4) offTime += dt;
  topV = Math.max(topV, car.vx);
  if (lap >= 0) maxLat = Math.max(maxLat, Math.abs(car.ay) / 9.81);
  for (const e of car.events.splice(0)) wall++;
  if (process.env.TRACE && Math.round(t * 240) % 48 === 0) console.log(t.toFixed(1), "s", s.toFixed(0), "d", car.trackPos.d.toFixed(1), "line", track.sampleArr(track.lineOff, s).toFixed(1), "v", (car.vx*3.6).toFixed(0), "prof", (track.sampleArr(prof.v, s)*3.6).toFixed(0), "thr", inp.throttle.toFixed(2), "brk", inp.brake.toFixed(2), "st", inp.steer.toFixed(2), "beta", Math.atan2(car.vy, car.vx).toFixed(2), "r", car.r.toFixed(2), "g", car.gear, "grip", ai.gripScale().toFixed(2), car.tyres.temp[0].toFixed(0));
  if (ai.stuckTimer > 5) { console.log('STUCK at s=', s.toFixed(0), 'd=', car.trackPos.d.toFixed(1)); break; }
}
console.log(`top ${(topV * 3.6).toFixed(0)} kph, max lat ${maxLat.toFixed(2)} g, max excursion ${maxOff.toFixed(1)} m`);
