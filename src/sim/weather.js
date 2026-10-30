// Dynamic weather: forecast timeline, rain intensity, track wetness (wetting / drying), temperatures.
import { clamp, lerp, makeRng } from './util.js';

export const WEATHER_STATES = [
  { id: 'clear', name: 'Clear', rain: 0, sun: 1, icon: '☀' },
  { id: 'cloudy', name: 'Light Cloud', rain: 0, sun: 0.65, icon: '⛅' },
  { id: 'overcast', name: 'Overcast', rain: 0, sun: 0.25, icon: '☁' },
  { id: 'light', name: 'Light Rain', rain: 0.38, sun: 0.1, icon: '🌦' },
  { id: 'heavy', name: 'Heavy Rain', rain: 0.9, sun: 0, icon: '🌧' },
];
export const stateById = (id) => WEATHER_STATES.find((w) => w.id === id) ?? WEATHER_STATES[0];

/**
 * opts: { mode: 'dynamic' | fixed state id, climate: {rain, airTemp:[lo,hi]}, duration (s), seed, timeScale }
 * timeScale > 1 compresses weather evolution for short sessions.
 */
export class Weather {
  constructor(opts = {}) {
    const rng = makeRng(opts.seed ?? 7);
    this.rng = rng;
    this.climate = opts.climate ?? { rain: 0.25, airTemp: [18, 26] };
    this.duration = opts.duration ?? 3600;
    this.timeScale = opts.timeScale ?? 1;
    this.time = 0;
    const [lo, hi] = this.climate.airTemp;
    this.airTemp = lo + (hi - lo) * rng();
    this.forecast = [];
    if (opts.mode && opts.mode !== 'dynamic') {
      this.forecast.push({ t: 0, state: opts.mode });
    } else {
      // Markov chain over states, biased by climate rain probability
      let idx = rng() < 0.55 ? 0 : rng() < 0.6 ? 1 : 2;
      if (rng() < this.climate.rain * 0.6) idx = rng() < 0.6 ? 3 : 4;
      const step = Math.max(120, this.duration / 6);
      for (let t = 0; t <= this.duration + step; t += step) {
        this.forecast.push({ t, state: WEATHER_STATES[idx].id });
        const r = rng();
        const rainy = this.climate.rain;
        if (idx <= 2) {
          if (r < rainy * 0.35 && idx >= 1) idx = 3;
          else if (r < 0.35) idx = Math.min(2, idx + 1);
          else if (r < 0.6) idx = Math.max(0, idx - 1);
        } else if (idx === 3) {
          if (r < 0.25 + rainy * 0.2) idx = 4;
          else if (r < 0.7) idx = 2;
        } else if (r < 0.5) idx = 3;
      }
    }
    const s0 = stateById(this.forecast[0].state);
    this.rain = s0.rain;
    this.sun = s0.sun;
    this.wetness = opts.startWetness ?? clamp(s0.rain * 1.1, 0, 1);
    this.trackTemp = this.airTemp + 14 * this.sun;
  }

  stateAt(t) {
    let st = this.forecast[0].state;
    for (const f of this.forecast) if (f.t <= t) st = f.state;
    return stateById(st);
  }

  get current() { return this.stateAt(this.time); }

  update(dt) {
    this.time += dt;
    const target = this.current;
    const k = Math.min(1, dt * 0.012 * this.timeScale);
    this.rain = lerp(this.rain, target.rain, k);
    this.sun = lerp(this.sun, target.sun, k);
    const wetTarget = clamp(this.rain * 1.12, 0, 1);
    if (wetTarget > this.wetness) this.wetness += (wetTarget - this.wetness) * Math.min(1, dt * 0.008 * this.timeScale);
    else this.wetness = Math.max(wetTarget, this.wetness - dt * 0.0011 * (0.6 + 0.8 * this.sun) * this.timeScale * (1 + this.trackTemp / 60));
    const tt = this.airTemp + 16 * this.sun - 6 * this.rain;
    this.trackTemp = lerp(this.trackTemp, tt, Math.min(1, dt * 0.01 * this.timeScale));
  }

  /** forecast entries for the next `span` seconds (for HUD/engineer) */
  upcoming(span = 1800, count = 5) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const t = this.time + (span * i) / (count - 1);
      out.push({ t: t - this.time, state: this.stateAt(t) });
    }
    return out;
  }

  /** seconds until rain starts (or Infinity) */
  rainEta(span = 900) {
    for (let t = 0; t <= span; t += 15) if (this.stateAt(this.time + t).rain > 0) return t;
    return Infinity;
  }
}
