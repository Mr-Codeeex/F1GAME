// Race strategy: initial plan (stops & compounds) and in-race pit decisions for AI drivers,
// plus recommendations for the player's engineer.
import { idealCompoundFor, DRY_COMPOUNDS, COMPOUNDS } from './tyres.js';

// Average wear per lap at race pace (measured with tools/lapsim.mjs on a ~5 km lap), before wearScale
export const BASE_WEAR_PER_LAP = { S: 0.031, M: 0.02, H: 0.0125, I: 0.021, W: 0.019 };
// approximate pace offsets (s/lap) on a fresh tyre vs soft
const PACE = { S: 0, M: 0.4, H: 0.8 };
export const WEAR_LIMIT = 0.72;

export function stintLife(compound, wearScale, lapLen = 5000) {
  const perLap = BASE_WEAR_PER_LAP[compound] * wearScale * (lapLen / 5000);
  return WEAR_LIMIT / perLap;
}

/** Build a race plan: [{compound, laps}] with pit laps. */
export function planRace(totalLaps, wearScale, lapLen, rng, opts = {}) {
  const pitLoss = opts.pitLoss ?? 22;
  const candidates = [];
  const life = Object.fromEntries(DRY_COMPOUNDS.map((c) => [c, stintLife(c, wearScale, lapLen)]));
  const stintCost = (c, laps) => laps * PACE[c] + 0.04 * laps * laps * (BASE_WEAR_PER_LAP[c] / 0.02) * wearScale * (lapLen / 5000);
  // 0 stops only legal if we can't fit the two-compound rule anyway (very short races)
  if (totalLaps <= 3) return { stints: [{ compound: life.S >= totalLaps ? 'S' : 'M', laps: totalLaps }], pitLaps: [] };
  if (!opts.mustUseTwo) {
    for (const a of DRY_COMPOUNDS) if (life[a] >= totalLaps) candidates.push({ stints: [{ compound: a, laps: totalLaps }], cost: stintCost(a, totalLaps) });
  }
  for (const a of DRY_COMPOUNDS) for (const b of DRY_COMPOUNDS) {
    if (a === b) continue;
    for (let split = 0.3; split <= 0.7; split += 0.05) {
      const l1 = Math.round(totalLaps * split), l2 = totalLaps - l1;
      if (l1 > life[a] * 1.05 || l2 > life[b] * 1.05 || l1 < 1 || l2 < 1) continue;
      candidates.push({ stints: [{ compound: a, laps: l1 }, { compound: b, laps: l2 }], cost: stintCost(a, l1) + stintCost(b, l2) + pitLoss });
    }
  }
  for (const a of DRY_COMPOUNDS) for (const b of DRY_COMPOUNDS) for (const c of DRY_COMPOUNDS) {
    if (a === b && b === c) continue;
    const l1 = Math.round(totalLaps / 3), l2 = Math.round(totalLaps / 3), l3 = totalLaps - l1 - l2;
    if (l1 > life[a] || l2 > life[b] || l3 > life[c] || l3 < 1) continue;
    candidates.push({ stints: [{ compound: a, laps: l1 }, { compound: b, laps: l2 }, { compound: c, laps: l3 }], cost: stintCost(a, l1) + stintCost(b, l2) + stintCost(c, l3) + 2 * pitLoss });
  }
  if (!candidates.length) {
    // very high wear: hards, stop every life
    const stints = [];
    let left = totalLaps;
    while (left > 0) { const l = Math.min(left, Math.max(1, Math.floor(life.H))); stints.push({ compound: stints.length % 2 ? 'M' : 'H', laps: l }); left -= l; }
    return withPitLaps({ stints });
  }
  candidates.sort((x, y) => x.cost - y.cost);
  // variety: pick among the best few
  const pick = candidates[Math.min(candidates.length - 1, Math.floor(rng() * Math.min(4, candidates.length)))];
  return withPitLaps(pick);
}

function withPitLaps(plan) {
  const pitLaps = [];
  let acc = 0;
  for (let i = 0; i < plan.stints.length - 1; i++) { acc += plan.stints[i].laps; pitLaps.push(acc); }
  return { ...plan, pitLaps };
}

/**
 * Decide whether an AI car should pit at the end of this lap, and on which tyre.
 * state: { lap (current lap number, 1-based), totalLaps, wear, compound, wetness, rainSoon, sc, vsc, plan, stops, usedCompounds:Set, damage }
 */
export function aiPitDecision(st, rng) {
  const lapsLeft = st.totalLaps - st.lap;
  if (lapsLeft < 1) return null;
  const ideal = idealCompoundFor(st.wetness);
  const onWet = COMPOUNDS[st.compound].wet;
  // weather calls
  if (ideal && ideal !== st.compound) {
    // switch to inters/wets when it's properly wet
    if (!onWet && st.wetness > 0.22) return ideal;
    if (onWet && ideal !== st.compound && Math.abs(st.wetness - (ideal === 'W' ? 0.7 : 0.4)) > 0.12) return ideal;
  }
  if (!ideal && onWet && st.wetness < 0.12 && !st.rainSoon) {
    return pickDry(st, lapsLeft);
  }
  if (st.damage > 0.45 && lapsLeft > 2) return st.compound === 'W' || st.compound === 'I' ? st.compound : pickDry(st, lapsLeft);
  if (onWet) {
    if (st.wear > 0.8 && lapsLeft > 3) return st.compound;
    return null;
  }
  const life = stintLife(st.compound, st.wearScale, st.lapLen);
  const lapsOnTyre = st.tyreLaps;
  const remainingLife = life - lapsOnTyre;
  const needsTwo = st.mustUseTwo && st.usedCompounds.size < 2;
  // cheap stop under neutralisation
  if ((st.sc || st.vsc) && lapsLeft > 4 && (st.wear > 0.32 || (needsTwo && lapsLeft < life * 0.95)) && st.stops < 3) return pickDry(st, lapsLeft);
  // planned stop window
  const planned = st.plan?.pitLaps?.[st.stops];
  if (planned != null && st.lap >= planned - 1 + Math.floor(rng() * 3) - 1) {
    if (lapsLeft > 1) return st.plan.stints[st.stops + 1]?.compound ?? pickDry(st, lapsLeft);
  }
  // tyre worn out
  if (st.wear > WEAR_LIMIT + 0.04 && lapsLeft > 2 && remainingLife < lapsLeft) return pickDry(st, lapsLeft);
  // two-compound rule late in race
  if (needsTwo && lapsLeft <= 2 && lapsLeft >= 1) return pickDry(st, lapsLeft);
  return null;
}

export function pickDry(st, lapsLeft) {
  const options = DRY_COMPOUNDS.filter((c) => stintLife(c, st.wearScale, st.lapLen) >= lapsLeft * 0.95);
  const needOther = st.mustUseTwo && st.usedCompounds.size < 2;
  let pool = options.length ? options : ['H'];
  if (needOther) {
    const others = pool.filter((c) => !st.usedCompounds.has(c));
    if (others.length) pool = others;
    else pool = DRY_COMPOUNDS.filter((c) => !st.usedCompounds.has(c));
  }
  // fastest that lasts
  for (const c of ['S', 'M', 'H']) if (pool.includes(c)) return c;
  return 'M';
}

/** Recommended pit window for the player (lap range) on current tyres. */
export function playerPitWindow(st) {
  const life = stintLife(st.compound, st.wearScale, st.lapLen);
  const startLap = st.lap - st.tyreLaps;
  const ideal = Math.round(startLap + life * 0.92);
  return { from: Math.max(st.lap, ideal - 2), to: ideal + 2 };
}
