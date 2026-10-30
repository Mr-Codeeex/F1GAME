// Procedural audio with WebAudio: V6 hybrid engine (player + nearby rivals with panning and
// doppler), tyre squeal, wind, rain, kerbs, impacts, UI blips and optional spoken radio.

function noiseBuffer(ctx, seconds = 2) {
  const len = ctx.sampleRate * seconds;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function distortionCurve(k = 8) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
  return c;
}

class EngineVoice {
  constructor(ctx, out, opts = {}) {
    this.ctx = ctx;
    this.gain = ctx.createGain(); this.gain.gain.value = 0;
    this.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.Q.value = 0.8;
    this.shaper = ctx.createWaveShaper(); this.shaper.curve = distortionCurve(opts.drive ?? 6);
    this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth';
    this.o2 = ctx.createOscillator(); this.o2.type = 'square';
    this.o3 = ctx.createOscillator(); this.o3.type = 'sawtooth';
    const g1 = ctx.createGain(); g1.gain.value = 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    const g3 = ctx.createGain(); g3.gain.value = 0.12;
    this.o1.connect(g1); this.o2.connect(g2); this.o3.connect(g3);
    g1.connect(this.shaper); g2.connect(this.shaper); g3.connect(this.shaper);
    this.shaper.connect(this.filter);
    this.filter.connect(this.gain);
    if (this.pan) { this.gain.connect(this.pan); this.pan.connect(out); } else this.gain.connect(out);
    if (opts.turbo) {
      this.turbo = ctx.createOscillator(); this.turbo.type = 'sine';
      this.turboGain = ctx.createGain(); this.turboGain.gain.value = 0;
      this.turbo.connect(this.turboGain); this.turboGain.connect(out);
      this.turbo.start();
    }
    this.o1.start(); this.o2.start(); this.o3.start();
  }
  set(rpm, throttle, volume, pan = 0, doppler = 1) {
    const t = this.ctx.currentTime;
    const f = (rpm / 60) * 3 * doppler; // 6 cylinders, 4 stroke: 3 firing pulses per rev
    this.o1.frequency.setTargetAtTime(f, t, 0.02);
    this.o2.frequency.setTargetAtTime(f * 0.5, t, 0.02);
    this.o3.frequency.setTargetAtTime(f * 2.01, t, 0.02);
    this.filter.frequency.setTargetAtTime(500 + throttle * 3800 + rpm * 0.15, t, 0.05);
    this.gain.gain.setTargetAtTime(volume * (0.35 + 0.65 * throttle), t, 0.04);
    if (this.pan) this.pan.pan.setTargetAtTime(pan, t, 0.05);
    if (this.turbo) {
      this.turbo.frequency.setTargetAtTime(1800 + rpm * 0.45, t, 0.1);
      this.turboGain.gain.setTargetAtTime(volume * 0.025 * throttle, t, 0.1);
    }
  }
}

export class AudioEngine {
  constructor(settings = {}) {
    this.settings = { master: 0.8, engine: 0.8, sfx: 0.8, radioVoice: true, ...settings };
    this.ctx = null;
    this.started = false;
  }

  start() {
    if (this.started) { this.ctx?.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.settings.master;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp); comp.connect(ctx.destination);
    this.engineBus = ctx.createGain(); this.engineBus.gain.value = this.settings.engine; this.engineBus.connect(this.master);
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = this.settings.sfx; this.sfxBus.connect(this.master);
    this.player = new EngineVoice(ctx, this.engineBus, { turbo: true, drive: 7 });
    this.rivals = [new EngineVoice(ctx, this.engineBus, { drive: 5 }), new EngineVoice(ctx, this.engineBus, { drive: 5 })];
    const nb = noiseBuffer(ctx);
    const loop = (filterType, freq, q) => {
      const src = ctx.createBufferSource(); src.buffer = nb; src.loop = true;
      const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.sfxBus); src.start();
      return { g, f };
    };
    this.squeal = loop('bandpass', 1300, 6);
    this.wind = loop('lowpass', 600, 0.5);
    this.rain = loop('highpass', 2500, 0.3);
    this.gravel = loop('bandpass', 300, 0.8);
    this.crowd = loop('bandpass', 700, 0.4);
    this.kerb = ctx.createOscillator(); this.kerb.type = 'square'; this.kerb.frequency.value = 38;
    this.kerbGain = ctx.createGain(); this.kerbGain.gain.value = 0;
    this.kerb.connect(this.kerbGain); this.kerbGain.connect(this.sfxBus); this.kerb.start();
    this.noise = nb;
    this.started = true;
  }

  setVolumes(s) {
    Object.assign(this.settings, s);
    if (!this.ctx) return;
    this.master.gain.value = this.settings.master;
    this.engineBus.gain.value = this.settings.engine;
    this.sfxBus.gain.value = this.settings.sfx;
  }

  silence() {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.player.set(4000, 0, 0);
    for (const r of this.rivals) r.set(4000, 0, 0);
    for (const n of [this.squeal, this.wind, this.rain, this.gravel, this.crowd]) n.g.gain.setTargetAtTime(0, t, 0.1);
    this.kerbGain.gain.setTargetAtTime(0, t, 0.05);
  }

  /** frame update. listener = {x, z, yaw} (camera), focus = player car, others = [{car}] */
  update(focus, others, listener, weather, opts = {}) {
    if (!this.started || !focus) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const car = focus.car;
    const inCockpit = opts.cockpit;
    const v = Math.abs(car.vx);
    this.player.set(car.rpm, car.frozen ? car.throttleIn : car.throttleIn, opts.paused ? 0 : (inCockpit ? 0.55 : 0.42));
    // nearest rivals
    const cand = [];
    for (const o of others) {
      if (o === focus || o.status !== 'running') continue;
      const dx = o.car.x - listener.x, dz = o.car.z - listener.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 250 * 250) cand.push([d2, o, dx, dz]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < this.rivals.length; k++) {
      const c = cand[k];
      if (!c || opts.paused) { this.rivals[k].set(4000, 0, 0); continue; }
      const [d2, o, dx, dz] = c;
      const d = Math.sqrt(d2);
      const vol = Math.min(0.35, 9 / (d + 6));
      // relative bearing for panning (listener right = +)
      const ang = Math.atan2(dz, dx) - listener.yaw;
      const pan = Math.max(-1, Math.min(1, Math.sin(ang)));
      // doppler from closing speed
      const ovx = o.car.vx * Math.cos(o.car.yaw), ovz = o.car.vx * Math.sin(o.car.yaw);
      const lvx = car.vx * Math.cos(car.yaw), lvz = car.vx * Math.sin(car.yaw);
      const closing = -((ovx - lvx) * dx + (ovz - lvz) * dz) / Math.max(1, d);
      const dop = Math.max(0.75, Math.min(1.3, 343 / (343 - closing)));
      this.rivals[k].set(o.car.rpm, o.car.throttleIn, vol, pan, dop);
    }
    // tyre squeal from slip
    let slip = 0;
    for (let w = 0; w < 4; w++) slip = Math.max(slip, car.wheelSlip[w] + (car.wheelLock[w] ? 0.6 : 0));
    const sq = opts.paused ? 0 : Math.max(0, Math.min(1, (slip - 0.35) * 1.6)) * (v > 5 ? 1 : 0) * (1 - weather.wetness);
    this.squeal.g.gain.setTargetAtTime(sq * 0.18, t, 0.05);
    this.squeal.f.frequency.setTargetAtTime(1100 + slip * 500, t, 0.1);
    this.wind.g.gain.setTargetAtTime(opts.paused ? 0 : Math.min(0.25, v * v / 40000) * (inCockpit ? 1.3 : 0.7), t, 0.1);
    this.rain.g.gain.setTargetAtTime(opts.paused ? 0 : weather.rain * 0.12, t, 0.3);
    const offRoad = car.wheelSurf.some((s) => s === 2 || s === 3);
    this.gravel.g.gain.setTargetAtTime(opts.paused ? 0 : (offRoad ? Math.min(0.3, v / 100) : 0), t, 0.05);
    this.kerbGain.gain.setTargetAtTime(opts.paused ? 0 : (car.onKerb ? Math.min(0.08, v / 600) : 0), t, 0.02);
    this.crowd.g.gain.setTargetAtTime(opts.paused ? 0 : (opts.crowd ?? 0.015), t, 0.5);
  }

  impact(strength) {
    if (!this.started) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400 + strength * 40;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(Math.min(1, strength / 25), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    src.connect(f); f.connect(g); g.connect(this.sfxBus);
    src.start(t, Math.random()); src.stop(t + 0.6);
  }

  blip(freq = 880, dur = 0.08, vol = 0.15, type = 'sine') {
    if (!this.started) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.sfxBus); o.start(t); o.stop(t + dur + 0.02);
  }

  lights(n, out) {
    if (out) this.blip(1320, 0.25, 0.2, 'square');
    else if (n > 0) this.blip(660, 0.12, 0.15, 'square');
  }

  radio(text) {
    this.blip(1500, 0.05, 0.08);
    setTimeout(() => this.blip(1900, 0.05, 0.06), 70);
    if (this.settings.radioVoice && window.speechSynthesis && text) {
      try {
        const u = new SpeechSynthesisUtterance(text.replace(/[—–]/g, ','));
        u.rate = 1.12; u.pitch = 0.95; u.volume = Math.min(1, this.settings.master + 0.1);
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch { /* speech unavailable */ }
    }
  }
}
