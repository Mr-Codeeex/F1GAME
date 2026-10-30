// Career mode, championship standings, R&D progression and persistent storage.
import { TEAMS, DRIVERS, POINTS } from './data/teams.js';
import { TRACKS } from './data/tracks.js';
import { makeRng, clamp } from './sim/util.js';

const KEY = 'apexgp.save.v1';

export const RD_TREE = [
  { id: 'aero', name: 'Aerodynamics', desc: 'More downforce and less drag.', stat: 'aero' },
  { id: 'power', name: 'Power Unit', desc: 'More ICE power, better ERS recovery.', stat: 'power' },
  { id: 'chassis', name: 'Chassis', desc: 'Lower weight, better mechanical grip and braking.', stat: 'chassis' },
  { id: 'reliability', name: 'Durability', desc: 'Fewer mechanical failures.', stat: 'reliability' },
  { id: 'ers', name: 'Energy Store', desc: 'Faster energy harvesting.', stat: 'ers' },
];
export const RD_LEVELS = 5;
export const RD_COST = [120, 180, 260, 360, 480];
export const RD_GAIN = 0.013;

const DEFAULT_SETTINGS = {
  quality: 'auto', resolutionScale: 1, showFps: false,
  master: 0.8, engine: 0.8, sfx: 0.8, radioVoice: true,
  touchSteer: 'buttons', autoThrottle: false, tiltRange: 28, steerGamma: 1.6,
  units: 'kph', hud: 'full', nameTags: true,
  assists: { abs: true, tc: 2, autoGears: true, steering: true, braking: 0, line: 'corners', pit: true, drsAuto: false },
  difficulty: 85, damage: 'full', safetyCar: 'on', penalties: 'on', failures: true,
};

export function loadSave() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { data = null; }
  const save = data && typeof data === 'object' ? data : {};
  save.settings = { ...DEFAULT_SETTINGS, ...(save.settings ?? {}) };
  save.settings.assists = { ...DEFAULT_SETTINGS.assists, ...(save.settings.assists ?? {}) };
  save.timeTrial = save.timeTrial ?? {};
  save.setups = save.setups ?? {};
  save.stats = save.stats ?? { races: 0, wins: 0, podiums: 0, poles: 0, distanceKm: 0 };
  save.career = save.career ?? null;
  return save;
}

export function writeSave(save) {
  try { localStorage.setItem(KEY, JSON.stringify(save)); return true; } catch { return false; }
}

export function resetSave() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function newCareer({ name, number, teamId, calendarLength = TRACKS.length, raceLength = 0.25, practice = true, qualiFormat = 'short' }) {
  const rng = makeRng(Date.now() & 0xffff);
  const calendar = TRACKS.map((t) => t.id);
  // shuffle all but keep the first round fixed for familiarity
  for (let i = calendar.length - 1; i > 1; i--) { const j = 1 + Math.floor(rng() * i); [calendar[i], calendar[j]] = [calendar[j], calendar[i]]; }
  const teamPerf = Object.fromEntries(TEAMS.map((t) => [t.id, { ...t.perf }]));
  return {
    driver: { name: name || 'Player', short: (name || 'PLA').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X'), number: number || 2, nat: 'XX' },
    teamId,
    season: 1,
    round: 0,
    calendar: calendar.slice(0, calendarLength),
    raceLength, practice, qualiFormat,
    standings: { drivers: {}, teams: {} },
    history: [],
    resources: 150,
    upgrades: Object.fromEntries(RD_TREE.map((r) => [r.id, 0])),
    teamPerf,
    weekend: null,
    reputation: 50,
  };
}

/** The driver entry list for a career weekend: player replaces the team's second seat. */
export function careerEntries(career) {
  const entries = [];
  const replaced = DRIVERS.filter((d) => d.team === career.teamId)[1];
  for (const d of DRIVERS) {
    const isPlayer = d === replaced;
    const team = TEAMS.find((t) => t.id === d.team);
    const perf = { ...career.teamPerf[d.team] };
    if (d.team === career.teamId) for (const r of RD_TREE) perf[r.stat] = clamp(perf[r.stat] + career.upgrades[r.id] * RD_GAIN, 0, 1.1);
    entries.push({
      driver: isPlayer ? { ...career.driver, id: 'player', team: d.team, skill: 1, aggression: 0.5, consistency: 1, wetSkill: 1 } : d,
      team: team.id, isPlayer, perf,
    });
  }
  return entries;
}

export function playerPerf(career) {
  const perf = { ...career.teamPerf[career.teamId] };
  for (const r of RD_TREE) perf[r.stat] = clamp(perf[r.stat] + career.upgrades[r.id] * RD_GAIN, 0, 1.1);
  return perf;
}

export function upgradeCost(career, id) {
  const lvl = career.upgrades[id];
  return lvl >= RD_LEVELS ? null : RD_COST[lvl];
}

export function buyUpgrade(career, id) {
  const cost = upgradeCost(career, id);
  if (cost == null || career.resources < cost) return false;
  career.resources -= cost;
  career.upgrades[id]++;
  return true;
}

/** Apply race results to the championship. results: session.results */
export function applyRaceResult(career, results, trackId) {
  const st = career.standings;
  const row = [];
  let playerPos = null, mateBeaten = false;
  const player = results.find((r) => r.isPlayer);
  const mate = results.find((r) => !r.isPlayer && r.team.id === career.teamId);
  results.forEach((r, k) => {
    const pts = r.status === 'Finished' && k < POINTS.length ? POINTS[k] : 0;
    const did = r.isPlayer ? 'player' : r.driver.id;
    st.drivers[did] = (st.drivers[did] ?? 0) + pts;
    st.teams[r.team.id] = (st.teams[r.team.id] ?? 0) + pts;
    row.push({ id: did, team: r.team.id, pos: r.pos, pts, status: r.status });
    if (r.isPlayer) playerPos = r.pos;
  });
  if (player && mate) mateBeaten = player.pos < mate.pos;
  // resources: points scored, beating the team-mate and the team's expectation
  const expected = expectedPosition(career);
  let earned = 40 + (player ? Math.max(0, 21 - player.pos) * 6 : 0) + (mateBeaten ? 30 : 0) + (playerPos && playerPos <= expected ? 40 : 0);
  if (player?.status !== 'Finished') earned = 25;
  career.resources += earned;
  career.reputation = clamp(career.reputation + (playerPos && playerPos <= expected ? 4 : -2) + (playerPos === 1 ? 6 : 0), 0, 100);
  career.history.push({ round: career.round + 1, trackId, playerPos, results: row });
  // rival development
  const rng = makeRng(career.season * 100 + career.round * 7 + 1);
  for (const t of TEAMS) {
    if (t.id === career.teamId) continue;
    for (const k of ['aero', 'power', 'chassis']) career.teamPerf[t.id][k] = clamp(career.teamPerf[t.id][k] + rng() * 0.006, 0, 1.08);
  }
  career.round++;
  career.weekend = null;
  return { earned, expected, mateBeaten };
}

export function expectedPosition(career) {
  const order = [...TEAMS].sort((a, b) => perfScore(career.teamPerf[b.id]) - perfScore(career.teamPerf[a.id]));
  const idx = order.findIndex((t) => t.id === career.teamId);
  return Math.min(20, idx * 2 + 2);
}

function perfScore(p) { return p.aero * 0.45 + p.power * 0.35 + p.chassis * 0.2; }

export function driverStandings(career) {
  const rows = [];
  for (const d of DRIVERS) {
    const replaced = DRIVERS.filter((x) => x.team === career.teamId)[1];
    if (d === replaced) rows.push({ id: 'player', name: career.driver.name, team: d.team, pts: career.standings.drivers.player ?? 0, isPlayer: true });
    else rows.push({ id: d.id, name: d.name, team: d.team, pts: career.standings.drivers[d.id] ?? 0 });
  }
  rows.sort((a, b) => b.pts - a.pts);
  return rows;
}

export function teamStandings(career) {
  return TEAMS.map((t) => ({ id: t.id, name: t.name, pts: career.standings.teams[t.id] ?? 0, colors: t.colors })).sort((a, b) => b.pts - a.pts);
}

export function seasonOver(career) { return career.round >= career.calendar.length; }

export function startNextSeason(career) {
  career.season++;
  career.round = 0;
  career.standings = { drivers: {}, teams: {} };
  career.history = [];
  // regulation reset narrows the field slightly
  for (const t of TEAMS) for (const k of ['aero', 'power', 'chassis']) career.teamPerf[t.id][k] = clamp(career.teamPerf[t.id][k] * 0.98 + 0.018, 0, 1.05);
  for (const r of RD_TREE) career.upgrades[r.id] = Math.max(0, career.upgrades[r.id] - 1);
}

/** Practice programme rewards: beat a target lap, tyre management. */
export function practiceReward(session, player) {
  const est = session.profileFor(player).lapTime;
  const target = est * 1.045;
  const out = [];
  if (player.bestLap != null) {
    const pts = player.bestLap <= target * 0.985 ? 60 : player.bestLap <= target ? 40 : player.bestLap <= target * 1.02 ? 20 : 5;
    out.push({ name: 'Qualifying Pace', detail: `Best ${player.bestLap.toFixed(3)}s vs target ${target.toFixed(3)}s`, pts });
  }
  const valid = player.laps.filter((l) => l.valid).map((l) => l.time);
  if (valid.length >= 3) {
    const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
    const spread = Math.sqrt(valid.reduce((a, b) => a + (b - avg) ** 2, 0) / valid.length);
    const pts = spread < 0.6 ? 40 : spread < 1.2 ? 25 : 10;
    out.push({ name: 'Race Pace Consistency', detail: `${valid.length} valid laps, σ ${spread.toFixed(2)}s`, pts });
  }
  return out;
}
