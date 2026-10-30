// Tyre compounds and the grip/temperature/wear model.
import { clamp } from './util.js';

export const COMPOUNDS = {
  S: { id: 'S', name: 'Soft', color: '#e8212b', grip: 1.0, wear: 1.55, optTemp: 92, window: 18, heat: 1.15, wet: false },
  M: { id: 'M', name: 'Medium', color: '#f5d31f', grip: 0.978, wear: 1.0, optTemp: 98, window: 20, heat: 1.0, wet: false },
  H: { id: 'H', name: 'Hard', color: '#eeeeee', grip: 0.958, wear: 0.62, optTemp: 104, window: 22, heat: 0.88, wet: false },
  I: { id: 'I', name: 'Intermediate', color: '#2fb54a', grip: 0.9, wear: 1.0, optTemp: 72, window: 22, heat: 1.0, wet: true },
  W: { id: 'W', name: 'Full Wet', color: '#2a6fe0', grip: 0.86, wear: 0.9, optTemp: 62, window: 24, heat: 0.9, wet: true },
};
export const DRY_COMPOUNDS = ['S', 'M', 'H'];

/** Grip multiplier of a compound for a given track wetness (0 dry .. 1 flooded). */
export function wetnessGrip(compound, w) {
  switch (compound) {
    case 'I':
      return 0.86 + 0.05 * clamp(w / 0.3, 0, 1) - 0.18 * Math.max(0, w - 0.62) / 0.38 - 0.04 * Math.max(0, 0.15 - w) / 0.15;
    case 'W':
      return 0.8 + 0.06 * clamp(w / 0.6, 0, 1) - 0.03 * Math.max(0, w - 0.85) / 0.15;
    default:
      // slicks: grip collapses quickly and aquaplane in standing water
      return 1 - 0.5 * Math.pow(w, 0.9) - 0.25 * Math.max(0, w - 0.5);
  }
}

/** Best compound for the conditions (used by AI and engineer). */
export function idealCompoundFor(w) {
  if (w < 0.18) return null; // dry tyre of choice
  if (w < 0.66) return 'I';
  return 'W';
}

/** Grip factor from temperature (bell shaped, gentle). */
export function tempGrip(c, temp) {
  const x = (temp - c.optTemp) / c.window;
  return clamp(1 - 0.055 * x * x, 0.8, 1);
}

/** Grip factor from wear 0..1 with a performance cliff past ~75%. */
export function wearGrip(wear) {
  return 1 - 0.06 * wear - 0.9 * Math.pow(Math.max(0, wear - 0.75), 2) - (wear >= 0.995 ? 0.35 : 0);
}

export class TyreSet {
  constructor(compound = 'M', opts = {}) {
    this.compound = compound;
    this.wear = [0, 0, 0, 0]; // FL FR RL RR
    this.temp = Array(4).fill(opts.startTemp ?? 80);
    this.laps = 0;
    this.used = opts.used ?? false;
    this.flatspot = [0, 0, 0, 0];
  }
  get data() { return COMPOUNDS[this.compound]; }
  maxWear() { return Math.max(...this.wear); }
  avgWear() { return (this.wear[0] + this.wear[1] + this.wear[2] + this.wear[3]) / 4; }
  avgTemp() { return (this.temp[0] + this.temp[1] + this.temp[2] + this.temp[3]) / 4; }
}
