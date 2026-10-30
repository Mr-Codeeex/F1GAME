// Headless race: node tools/racesim.mjs [track] [laps] [type]
import { Track } from '../src/sim/track.js';
import { trackById } from '../src/data/tracks.js';
import { DRIVERS } from '../src/data/teams.js';
import { Session } from '../src/sim/session.js';
import { formatTime } from '../src/sim/util.js';

const track = new Track(trackById(process.argv[2] ?? 'aurora'));
const laps = +(process.argv[3] ?? 5);
const type = process.argv[4] ?? 'race';
const entries = DRIVERS.map((d, i) => ({ driver: d, team: d.team, gridPos: i }));
const t0 = Date.now();
const s = new Session({ track, type, entries, settings: { laps, weather: process.env.WX ?? 'clear', difficulty: 90, sessionMinutes: +(process.env.MIN ?? 8), qualiFormat: process.env.QF ?? 'short' }, seed: +(process.env.SEED ?? 5) });
let lastLog = 0;
while (!s.finished && s.time < 60 * 60) {
  s.step();
  for (const e of s.events.splice(0)) if (['radio', 'banner', 'info', 'penalty', 'warning'].includes(e.type) && process.env.V) console.log(`[${s.time.toFixed(0)}s] ${e.type}: ${e.text}`);
  if (s.time - lastLog > 60 && process.env.V) {
    lastLog = s.time;
    const o = s.order ?? [];
    console.log(`t=${s.time.toFixed(0)} wet=${s.weather.wetness.toFixed(2)} ` + o.slice(0, 6).map((c) => `${c.driver.short}(L${c.lap} ${c.car.tyres.compound}${c.pit.phase ? '/' + c.pit.phase : ''})`).join(' '));
  }
}
console.log(`sim ${s.time.toFixed(0)} s in ${((Date.now() - t0) / 1000).toFixed(1)} s wall, finished=${s.finished}`);
for (const r of s.results ?? []) {
  const c = r.comp;
  console.log(`${String(r.pos).padStart(2)} ${c.driver.name.padEnd(20)} ${c.team.short} grid ${String(c.gridPos + 1).padStart(2)} ${String(r.gap ?? formatTime(r.time)).padStart(10)} best ${formatTime(c.bestLap)} stops ${c.stops} tyres ${c.tyreHistory.map((h) => h.compound).join('')} pen ${c.penaltyTotal} ${c.retired ? 'DNF ' + c.retired.reason : ''} ${r.eliminated ?? ''}`);
}
