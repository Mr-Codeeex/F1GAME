// In-session heads-up display: timing tower, lap/sector timing with live delta, dash (speed,
// gear, RPM LEDs, pedals, ERS, DRS, fuel), tyre widget, minimap, flags, start lights, radio feed,
// pit stop overlay, name tags, MFD (strategy) panel and the garage panel for practice/qualifying.
import { formatTime, formatGap, clamp } from '../sim/util.js';
import { COMPOUNDS, DRY_COMPOUNDS } from '../sim/tyres.js';
import { ERS_MODES, FUEL_MIXES, RPM_MAX } from '../sim/car.js';
import { teamAccent } from '../data/teams.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function tempColor(t, opt) {
  const d = t - opt;
  if (d < -25) return '#3a8bff';
  if (d < -10) return '#5fd0ff';
  if (d < 10) return '#22d36b';
  if (d < 22) return '#ffd400';
  return '#ff3b4e';
}

export class Hud {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.radio = [];
    this.mfdOpen = false;
    this.lastTower = 0;
    this.banner = null;
    this.bannerUntil = 0;
    this.flagUntil = 0;
  }

  attach(session, opts = {}) {
    this.session = session;
    this.opts = opts;
    this.radio = [];
    this.mfdOpen = false;
    const type = session.type;
    this.root.innerHTML = `
      <div class="p h-tower" id="h-tower"></div>
      <div class="p ${type === 'race' ? 'h-pos' : 'h-session'}" id="h-top"></div>
      <div class="p h-info" id="h-info"></div>
      <div class="h-radio" id="h-radio"></div>
      <div class="p h-flag hidden" id="h-flag"></div>
      <div class="p h-banner hidden" id="h-banner" style="background:none;border:0"></div>
      <div class="p h-lights hidden" id="h-lights">${'<i></i>'.repeat(5)}</div>
      <div class="p h-pit hidden" id="h-pit"></div>
      <div class="h-tags" id="h-tags"></div>
      <div class="p h-dash" id="h-dash">
        <div class="h-rpm" id="h-rpm">${'<i></i>'.repeat(15)}</div>
        <div class="h-speed"><b id="h-spd">0</b><span id="h-unit">KM/H</span><div class="h-pedals" style="justify-content:flex-end;margin-top:4px"><i class="t"><b id="h-thr"></b></i><i class="br"><b id="h-brk"></b></i></div></div>
        <div class="h-gear" id="h-gear">N</div>
        <div class="h-right">
          <div class="row" style="gap:5px"><span class="h-chip" id="h-drs">DRS</span><span class="h-chip" id="h-ersm">MED</span><span class="h-chip" id="h-mix">STD</span><span class="h-chip hidden" id="h-lim">PIT</span></div>
          <div class="h-ers"><span>ERS</span><div style="flex:1"><div class="bar"><i id="h-ers"></i></div><div class="bar dep"><i id="h-dep"></i></div></div></div>
          <div class="row" style="gap:8px;justify-content:space-between"><span id="h-fuel">FUEL</span><span id="h-bias" class="h-dmg"></span></div>
        </div>
      </div>
      <div class="p h-tyres" id="h-tyres">
        <div class="tw" id="h-t0"></div><div class="tw" id="h-t1"></div><div class="tw" id="h-t2"></div><div class="tw" id="h-t3"></div>
        <div class="ft"><span id="h-tc"></span><span id="h-tl"></span></div>
      </div>
      <div class="p h-map"><canvas id="h-map" width="380" height="380"></canvas></div>
      <div class="p h-mfd hidden" id="h-mfd"></div>
      <div class="p h-garage hidden" id="h-garage"></div>
      <div class="h-ff hidden" id="h-ff"></div>
      <div class="h-fps hidden" id="h-fps"></div>`;
    this.el = {};
    for (const n of this.root.querySelectorAll('[id]')) this.el[n.id.replace('h-', '')] = n;
    this.rpmLeds = [...this.el.rpm.children];
    this.mapCanvas = this.el.map;
    this.prepareMap();
    this.el.mfd.addEventListener('click', (e) => this.onMfdClick(e));
    this.el.garage.addEventListener('click', (e) => this.onGarageClick(e));
    this.el.ff.addEventListener('click', (e) => this.onFFClick(e));
    this.el.unit.textContent = this.app.save.settings.units === 'mph' ? 'MPH' : 'KM/H';
    this.el.fps.classList.toggle('hidden', !this.app.save.settings.showFps);
    this.lastGarageState = null;
    this.root.classList.remove('hidden');
  }

  detach() {
    this.root.innerHTML = '';
    this.root.classList.add('hidden');
    this.session = null;
  }

  // ------------------------------------------------------------------ minimap
  prepareMap() {
    const t = this.session.track;
    const b = t.bounds();
    const W = this.mapCanvas.width, pad = 24;
    const sc = (W - pad * 2) / Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
    this.mapXf = (x, z) => [pad + (x - b.minX) * sc + ((W - pad * 2) - (b.maxX - b.minX) * sc) / 2, pad + (z - b.minZ) * sc + ((W - pad * 2) - (b.maxZ - b.minZ) * sc) / 2];
    const off = document.createElement('canvas');
    off.width = W; off.height = W;
    const g = off.getContext('2d');
    g.lineJoin = 'round';
    const path = () => { g.beginPath(); for (let i = 0; i <= t.n; i += 3) { const [x, y] = this.mapXf(t.px[i % t.n], t.pz[i % t.n]); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath(); };
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 14; path(); g.stroke();
    g.strokeStyle = '#e9edf2'; g.lineWidth = 7; path(); g.stroke();
    // sectors
    const secCol = ['#ff4d6a', '#3fa9ff', '#ffd400'];
    for (let k = 0; k < 3; k++) {
      const s0 = t.sectors[k], s1 = k < 2 ? t.sectors[k + 1] : t.length;
      g.strokeStyle = secCol[k]; g.lineWidth = 3; g.beginPath();
      for (let s = s0; s <= s1; s += 6) { const p = t.toWorld(s, 0); const [x, y] = this.mapXf(p.x, p.z); s === s0 ? g.moveTo(x, y) : g.lineTo(x, y); }
      g.stroke();
    }
    // start line
    const p0 = t.toWorld(0, -t.halfWidth * 2.5), p1 = t.toWorld(0, t.halfWidth * 2.5);
    g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.moveTo(...this.mapXf(p0.x, p0.z)); g.lineTo(...this.mapXf(p1.x, p1.z)); g.stroke();
    this.mapBase = off;
  }

  drawMap() {
    const g = this.mapCanvas.getContext('2d');
    const s = this.session;
    g.clearRect(0, 0, this.mapCanvas.width, this.mapCanvas.height);
    g.drawImage(this.mapBase, 0, 0);
    if (s.safetyCar) { const [x, y] = this.mapXf(s.safetyCar.car.x, s.safetyCar.car.z); g.fillStyle = '#ffb400'; g.fillRect(x - 6, y - 6, 12, 12); }
    for (const c of s.comps) {
      if (c.status !== 'running' || c.isPlayer) continue;
      const [x, y] = this.mapXf(c.car.x, c.car.z);
      g.fillStyle = teamAccent(c.team); g.strokeStyle = c.retired ? '#ff3b4e' : '#fff'; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    const p = s.player;
    if (p && p.status === 'running') {
      const [x, y] = this.mapXf(p.car.x, p.car.z);
      g.fillStyle = '#e8102e'; g.strokeStyle = '#fff'; g.lineWidth = 3;
      g.beginPath(); g.arc(x, y, 10, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }

  // ------------------------------------------------------------------ events
  pushRadio(text, kind = 'radio') {
    const label = { radio: 'Race Engineer', penalty: 'Race Control', warning: 'Race Control', info: 'Race Control' }[kind] ?? 'Radio';
    this.radio.push({ text, kind, label, until: performance.now() + (kind === 'info' ? 5000 : 7500) });
    if (this.radio.length > 4) this.radio.shift();
    this.renderRadio();
  }

  renderRadio() {
    this.el.radio.innerHTML = this.radio.map((r) => `<div class="${r.kind}"><small>${r.label}</small>${esc(r.text)}</div>`).join('');
  }

  showBanner(text, ms = 2600) {
    this.el.banner.textContent = text;
    this.el.banner.classList.remove('hidden');
    this.bannerUntil = performance.now() + ms;
  }

  showFlag(flag, ms = 4000) {
    const names = { yellow: 'Yellow flag', doubleyellow: 'Double yellow', sc: 'Safety Car', vsc: 'Virtual Safety Car', blue: 'Blue flag — let the leaders by', green: 'Green flag', chequered: 'Chequered flag', blackwhite: 'Track limits — black & white flag', white: 'Final lap' };
    const cls = flag === 'doubleyellow' ? 'yellow' : flag === 'white' ? 'green' : flag;
    this.el.flag.className = `p h-flag ${cls}`;
    this.el.flag.textContent = names[flag] ?? flag;
    this.flagUntil = flag === 'sc' || flag === 'vsc' ? Infinity : performance.now() + ms;
    this.persistFlag = flag === 'sc' || flag === 'vsc' ? flag : null;
  }

  handleEvent(e) {
    switch (e.type) {
      case 'radio': case 'penalty': case 'warning': case 'info':
        this.pushRadio(e.text, e.type);
        break;
      case 'banner':
        this.showBanner(e.text);
        this.pushRadio(e.text, 'info');
        break;
      case 'lights':
        this.el.lights.classList.toggle('hidden', e.n === 0 && !!e.out);
        [...this.el.lights.children].forEach((l, k) => l.classList.toggle('on', k < e.n));
        if (e.out) setTimeout(() => this.el.lights?.classList.add('hidden'), 900);
        break;
      case 'flag':
        if (e.flag === 'green' && this.persistFlag) { this.persistFlag = null; }
        if (e.flag === 'yellow' || e.flag === 'doubleyellow') { if (!this.persistFlag) this.showFlag(e.flag, 3500); }
        else this.showFlag(e.flag, e.flag === 'green' ? 2500 : 4000);
        break;
      case 'sector': {
        this.sectorState = this.sectorState || [null, null, null];
        this.sectorState[e.sector] = e.overall ? 'p' : e.best ? 'g' : 'y';
        break;
      }
      case 'newLap':
        this.sectorState = [null, null, null];
        break;
      case 'lap':
        if (!e.valid && this.session.type !== 'race') this.pushRadio('Lap invalid.', 'warning');
        break;
      case 'personalBest':
        if (this.session.type !== 'race') this.showBanner(`Personal best  ${formatTime(e.time)}`, 2200);
        break;
      case 'position':
        if (e.to < e.from && this.session.phase === 'racing') this.showBanner(`P${e.to}`, 1200);
        break;
      case 'phase':
        this.showBanner(e.name, 2500);
        break;
    }
  }

  // ------------------------------------------------------------------ per-frame
  update(dt, ctx) {
    const s = this.session;
    if (!s) return;
    const now = performance.now();
    const p = s.player;
    const settings = this.app.save.settings;
    // radio expiry
    const before = this.radio.length;
    this.radio = this.radio.filter((r) => r.until > now);
    if (this.radio.length !== before) this.renderRadio();
    if (this.bannerUntil && now > this.bannerUntil) { this.el.banner.classList.add('hidden'); this.bannerUntil = 0; }
    if (this.persistFlag && !s.safetyCar && !s.vsc) { this.persistFlag = null; this.flagUntil = 0; }
    this.el.flag.classList.toggle('hidden', !(now < this.flagUntil || this.persistFlag));

    if (now - this.lastTower > 250) {
      this.lastTower = now;
      this.renderTower();
      this.renderTop();
      this.renderGarage();
      if (this.mfdOpen) this.renderMfd();
      this.renderFF();
    }
    if (!p) return;
    const car = p.car;
    const showCar = p.status === 'running';
    this.el.dash.classList.toggle('hidden', !showCar);
    this.el.tyres.classList.toggle('hidden', !showCar || window.innerWidth < 820);
    // dash
    if (showCar) {
      const mph = settings.units === 'mph';
      this.el.spd.textContent = Math.round(Math.abs(car.vx) * (mph ? 2.237 : 3.6));
      this.el.gear.textContent = car.reverse ? 'R' : car.vx < 0.3 && car.throttleIn < 0.05 && !car.frozen ? 'N' : car.gear;
      const frac = clamp((car.rpm - 6500) / (RPM_MAX - 6500 - 300), 0, 1);
      const lit = Math.round(frac * 15);
      this.rpmLeds.forEach((l, k) => { l.className = k < lit ? (k < 5 ? 'g' : k < 10 ? 'r' : 'b') + ' on' : ''; });
      this.el.rpm.classList.toggle('flash', car.rpm > 11850);
      this.el.thr.style.height = `${car.throttleIn * 100}%`;
      this.el.brk.style.height = `${car.brakeIn * 100}%`;
      this.el.drs.className = 'h-chip ' + (car.drsOpen ? 'on' : car.drsAllowed ? 'avail' : '');
      const mode = ctx.input?.overtake ? 3 : car.ersMode;
      this.el.ersm.textContent = ERS_MODES[mode].name.slice(0, 4);
      this.el.ersm.className = 'h-chip ' + (mode >= 2 ? 'warn' : '');
      this.el.mix.textContent = FUEL_MIXES[car.fuelMix].name.slice(0, 4);
      this.el.lim.classList.toggle('hidden', !car.limiter);
      this.el.ers.style.width = `${car.batteryFrac * 100}%`;
      this.el.dep.style.width = `${(1 - car.lapDeployFrac) * 100}%`;
      const fpl = s.fuelPerLap();
      const fuelLaps = car.fuel / fpl;
      const need = s.type === 'race' ? s.raceLaps - Math.max(0, p.lap) : 0;
      this.el.fuel.innerHTML = s.type === 'race' ? `FUEL <b style="color:${fuelLaps - need < -0.3 ? '#ff5468' : fuelLaps - need < 0.3 ? '#ffd400' : '#22d36b'}">${fuelLaps - need >= 0 ? '+' : ''}${(fuelLaps - need).toFixed(1)}</b> laps` : `FUEL ${car.fuel.toFixed(1)} kg`;
      const dmg = car.damage;
      const dm = Math.max(dmg.frontWing, dmg.rearWing, dmg.floor);
      this.el.bias.textContent = dm > 0.05 ? `DMG FW ${Math.round(dmg.frontWing * 100)}% RW ${Math.round(dmg.rearWing * 100)}%` : '';
      // tyres
      const comp = COMPOUNDS[car.tyres.compound];
      for (let w = 0; w < 4; w++) {
        const el = this.el['t' + w];
        el.style.background = tempColor(car.tyres.temp[w], comp.optTemp);
        el.textContent = `${Math.round(car.tyres.wear[w] * 100)}%`;
      }
      this.el.tc.innerHTML = `<span class="tyre" style="color:${comp.color}"><b>${comp.id}</b></span> ${Math.round(car.tyres.avgTemp())}°`;
      this.el.tl.textContent = `${p.tyreLaps} laps`;
    }
    // timing panel
    this.renderInfo(ctx);
    // pit overlay
    const pit = p.pit;
    if (pit.phase === 'box') {
      this.el.pit.classList.remove('hidden');
      this.el.pit.innerHTML = `<div class="lbl" style="color:var(--muted);font-size:12px;letter-spacing:.15em">PIT STOP</div><b>${Math.max(0, pit.timer).toFixed(1)}</b><div>${pit.compound ? `<span class="tyre" style="color:${COMPOUNDS[pit.compound].color}"><b>${pit.compound}</b></span> ` : ''}${pit.repairWing ? 'New front wing' : ''}</div>`;
    } else this.el.pit.classList.add('hidden');
    // minimap
    this.mapTick = (this.mapTick ?? 0) + 1;
    if (this.mapTick % 2 === 0) this.drawMap();
    // name tags
    this.renderTags(ctx);
    if (settings.showFps) this.el.fps.textContent = `${ctx.fps?.toFixed(0) ?? ''} fps`;
  }

  renderTop() {
    const s = this.session, p = s.player;
    if (s.type === 'race') {
      const lap = p ? Math.min(s.raceLaps, Math.max(1, p.lap + 1)) : 0;
      this.el.top.innerHTML = p ? `<span class="pp">P${p.position}<small>/${s.comps.length}</small></span><span class="lap">LAP <b>${lap}</b>/${s.raceLaps}</span>${p.penaltyPending ? `<span class="pill bad">+${p.penaltyPending}s</span>` : ''}${p.warnings ? `<span class="pill">TL ${p.warnings}</span>` : ''}` : '';
    } else if (s.type === 'timetrial') {
      this.el.top.innerHTML = `<span>TIME TRIAL</span><span class="clk">${formatTime(p.bestLap)}</span>`;
    } else {
      const ph = s.qPhases[s.qPhase];
      const rem = s.phaseRemaining ?? ph.duration;
      const m = Math.floor(rem / 60), sec = Math.floor(rem % 60);
      this.el.top.innerHTML = `<span>${esc(ph.name).toUpperCase()}</span><span class="clk">${s.phaseOver ? 'FLAG' : `${m}:${String(sec).padStart(2, '0')}`}</span>${p ? `<span>P${p.position}</span>` : ''}`;
    }
  }

  renderTower() {
    const s = this.session;
    const order = s.order ?? s.comps;
    const p = s.player;
    const hdr = s.type === 'race' ? `<div class="hdr"><span>LAP ${Math.max(1, Math.min(s.raceLaps, (order[0]?.lap ?? 0) + 1))}/${s.raceLaps}</span><span>${s.safetyCar ? 'SC' : s.vsc ? 'VSC' : 'INT'}</span></div>` : `<div class="hdr"><span>${s.type === 'qualifying' ? s.qPhases[s.qPhase].name.toUpperCase() : s.type === 'timetrial' ? 'TIME TRIAL' : 'PRACTICE'}</span><span>BEST</span></div>`;
    const rows = [];
    let list = order;
    if (s.type === 'timetrial') list = [p];
    // on small screens show the leaders and the cars around the player
    for (const c of list) {
      const me = c === p;
      let gap = '';
      if (s.type === 'race') {
        if (c.retired) gap = 'OUT';
        else if (c.finishTime != null) gap = c.position === 1 ? 'FIN' : (c.gapLeader != null ? formatGap(c.gapLeader) : 'FIN');
        else if (c.pit.phase && c.pit.phase !== 'approach') gap = 'PIT';
        else if (c.position === 1) gap = 'Leader';
        else if (c.lappedBy >= 1) gap = `+${c.lappedBy} L`;
        else {
          const v = this.app.towerMode === 'leader' ? c.gapLeader : c.interval;
          gap = v != null ? formatGap(v) : '';
        }
      } else {
        const t = s.type === 'qualifying' ? c.quali.phaseBest ?? (c.quali.eliminated ? c.bestLap : null) : c.bestLap;
        gap = t == null ? (c.status === 'garage' ? 'GARAGE' : '—') : c.position === 1 ? formatTime(t) : formatGap(c.gapLeader ?? 0);
        if (c.status === 'running' && c.pit.phase && c.pit.phase !== 'approach') gap = 'PIT';
      }
      const comp = COMPOUNDS[c.car.tyres.compound];
      const cls = ['r', me ? 'me' : '', c.retired || c.quali.eliminated ? 'out' : '', gap === 'PIT' ? 'pit' : '', c.car.drsOpen ? 'drs' : ''].join(' ');
      rows.push(`<div class="${cls}"><span class="pos">${c.position}</span><span class="tb" style="background:${teamAccent(c.team)}"></span><span class="nm">${esc(c.driver.short)}</span><span class="gp">${gap}</span><span class="ty" style="border-color:${comp.color}"></span></div>`);
    }
    this.el.tower.innerHTML = hdr + rows.join('');
  }

  renderInfo(ctx) {
    const s = this.session, p = s.player;
    if (!p) return;
    const cur = p.status === 'running' && p.lap >= 0 && !p.outLap ? s.time - p.lapStart : null;
    const delta = ctx.delta;
    const deltaHtml = delta != null && cur != null && p.lapValid ? `<span class="h-delta ${delta < 0 ? 'neg' : 'pos'}">${formatGap(delta)}</span>` : '';
    const st = this.sectorState || [];
    const secs = [0, 1, 2].map((k) => `<i class="${st[k] ?? ''}"></i>`).join('');
    const invalid = p.status === 'running' && !p.lapValid && !p.outLap ? '<span class="pill bad">INVALID</span>' : p.outLap && p.status === 'running' ? '<span class="pill">OUT LAP</span>' : '';
    this.el.info.innerHTML = `<div class="lbl">Lap time ${invalid}</div><div class="big">${cur != null ? formatTime(cur) : '--:--.---'}</div>${deltaHtml}
      <div class="h-sectors">${secs}</div>
      <div class="lines"><span>LAST</span><span>${formatTime(p.lastLap)}</span><span>BEST</span><span>${formatTime(p.bestLap)}</span>${s.fastestLap ? `<span>FASTEST</span><span>${formatTime(s.fastestLap.time)} ${esc(s.fastestLap.comp.driver.short)}</span>` : ''}${ctx.ghostTime ? `<span>RECORD</span><span>${formatTime(ctx.ghostTime)}</span>` : ''}</div>`;
  }

  renderTags(ctx) {
    const s = this.session;
    const el = this.el.tags;
    if (!this.app.save.settings.nameTags || !ctx.renderer || !s.player || s.player.status !== 'running') { if (el.innerHTML) el.innerHTML = ''; return; }
    const p = s.player;
    const out = [];
    for (const c of s.comps) {
      if (c === p || c.status !== 'running') continue;
      const dx = c.car.x - p.car.x, dz = c.car.z - p.car.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 120 * 120 || d2 < 9) continue;
      const sp = ctx.renderer.project(c.car.x, 1.6, c.car.z);
      if (!sp) continue;
      out.push(`<div style="left:${sp.x | 0}px;top:${sp.y | 0}px;border-color:${teamAccent(c.team)};opacity:${clamp(1.4 - Math.sqrt(d2) / 100, 0.3, 1).toFixed(2)}">P${c.position} ${esc(c.driver.short)}</div>`);
    }
    el.innerHTML = out.join('');
  }

  // ------------------------------------------------------------------ MFD (strategy)
  toggleMfd(force) {
    this.mfdOpen = force ?? !this.mfdOpen;
    this.el.mfd.classList.toggle('hidden', !this.mfdOpen);
    if (this.mfdOpen) this.renderMfd();
  }

  renderMfd() {
    const s = this.session, p = s.player;
    if (!p) return;
    const car = p.car;
    const wx = s.weather;
    const fc = wx.upcoming(Math.min(1800, s.sessionLength), 5).map((f) => `<div><b>${f.state.icon}</b>${f.t < 1 ? 'Now' : '+' + Math.round(f.t / 60) + 'm'}</div>`).join('');
    const sel = p.pit.compound ?? this.app.suggestCompound(s, p);
    const comps = [...DRY_COMPOUNDS, 'I', 'W'].map((c) => `<button data-cmp="${c}" class="${sel === c ? 'on' : ''}" style="color:${COMPOUNDS[c].color}">${COMPOUNDS[c].name}</button>`).join('');
    const ers = ERS_MODES.slice(0, 3).map((m) => `<button data-ers="${m.id}" class="${car.ersMode === m.id ? 'on' : ''}">${m.name}</button>`).join('');
    const mix = FUEL_MIXES.map((m, k) => `<button data-mix="${k}" class="${car.fuelMix === k ? 'on' : ''}">${m.name}</button>`).join('');
    const pitting = p.pit.requested;
    const canPit = s.type !== 'timetrial';
    const life = s.stintLifeLaps(sel);
    this.el.mfd.innerHTML = `
      <h4>Weather — track ${Math.round(wx.trackTemp)}°C, ${Math.round(wx.wetness * 100)}% wet</h4><div class="forecast" style="margin-bottom:10px">${fc}</div>
      ${canPit ? `<h4>Pit strategy</h4><div class="seg" style="margin-bottom:6px">${comps}</div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:8px">≈ ${life.toFixed(0)} laps of life · pit loss ≈ ${s.pitLoss().toFixed(0)}s${s.mustUseTwo ? ' · two dry compounds required' : ''}</div>
      <div class="row"><button class="btn small ${pitting ? '' : 'primary'}" data-act="pit">${pitting ? 'Cancel box request' : s.type === 'race' ? 'Box this lap' : 'Box & return to garage'}</button>${s.type !== 'race' ? '<button class="btn small" data-act="garage">Return to garage</button>' : ''}</div>` : ''}
      <h4>ERS deployment</h4><div class="seg" style="margin-bottom:8px">${ers}</div>
      <h4>Fuel mix</h4><div class="seg" style="margin-bottom:8px">${mix}</div>
      <h4>Brake bias ${Math.round(car.params.brakeBias * 100)}%</h4><div class="row"><button class="btn small" data-act="bias-">◀ Rearward</button><button class="btn small" data-act="bias+">Forward ▶</button></div>
      <h4>Car status</h4><div style="font-size:12px;color:var(--muted)">Front wing ${Math.round(car.damage.frontWing * 100)}% · Rear wing ${Math.round(car.damage.rearWing * 100)}% · Tyres ${Math.round(car.tyres.maxWear() * 100)}% worn · ${p.stops} stop${p.stops === 1 ? '' : 's'}${p.penaltyPending ? ` · +${p.penaltyPending}s penalty` : ''}</div>`;
  }

  onMfdClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const s = this.session, p = s.player;
    if (b.dataset.cmp) { p.pit.compound = b.dataset.cmp; this.app.audio.blip(990); }
    if (b.dataset.ers) p.car.ersMode = +b.dataset.ers;
    if (b.dataset.mix) p.car.fuelMix = +b.dataset.mix;
    const a = b.dataset.act;
    if (a === 'pit') this.app.togglePit();
    if (a === 'garage') this.app.returnToGarage();
    if (a === 'bias-' || a === 'bias+') {
      const st = { ...p.car.setup, brakeBias: clamp(p.car.setup.brakeBias + (a === 'bias+' ? 1 : -1), 50, 70) };
      p.car.setSetup(st);
    }
    this.renderMfd();
  }

  // ------------------------------------------------------------------ garage panel (practice/qualifying)
  renderGarage() {
    const s = this.session, p = s.player;
    const show = p && p.status === 'garage' && (s.type === 'practice' || s.type === 'qualifying') && !s.finished;
    this.el.garage.classList.toggle('hidden', !show);
    if (!show) { this.lastGarageState = null; return; }
    const out = s.type === 'qualifying' && p.quali.eliminated;
    const state = [out, s.phaseOver, s.qPhase, this.garageCompound, this.garageFuel].join('|');
    if (state === this.lastGarageState) return;
    this.lastGarageState = state;
    const cmp = this.garageCompound ?? (s.weather.wetness > 0.2 ? (s.weather.wetness > 0.66 ? 'W' : 'I') : s.type === 'qualifying' ? 'S' : 'M');
    this.garageCompound = cmp;
    const fuel = this.garageFuel ?? (s.type === 'qualifying' ? 'quali' : 'medium');
    this.garageFuel = fuel;
    const comps = [...DRY_COMPOUNDS, 'I', 'W'].map((c) => `<button data-gc="${c}" class="${cmp === c ? 'on' : ''}" style="color:${COMPOUNDS[c].color}">${COMPOUNDS[c].name}</button>`).join('');
    const fuels = s.type === 'practice' ? `<div class="seg">${[['quali', 'Light'], ['medium', 'Medium'], ['race', 'Heavy']].map(([k, n]) => `<button data-gf="${k}" class="${fuel === k ? 'on' : ''}">${n} fuel</button>`).join('')}</div>` : '';
    this.el.garage.innerHTML = out ? `<div class="row"><b>Eliminated in ${s.qPhases[p.quali.elimPhase]?.name ?? ''} — P${p.position}</b><span class="spacer"></span><button class="btn primary" data-g="skip">Skip to end of session</button></div>`
      : `<div class="row" style="margin-bottom:8px"><b>Garage</b><span class="spacer"></span><span style="color:var(--muted);font-size:13px">${s.phaseOver ? 'Session finished' : 'Choose tyres and head out'}</span></div>
      <div class="row" style="margin-bottom:8px"><div class="seg">${comps}</div>${fuels}</div>
      <div class="row"><button class="btn primary" data-g="go" ${s.phaseOver ? 'disabled' : ''}>Go out ▶</button><button class="btn" data-g="setup">Car setup</button><span class="spacer"></span><button class="btn" data-g="skip">${s.type === 'qualifying' ? 'Skip — simulate session' : 'End session'}</button></div>`;
  }

  onGarageClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.gc) { this.garageCompound = b.dataset.gc; this.lastGarageState = null; this.renderGarage(); return; }
    if (b.dataset.gf) { this.garageFuel = b.dataset.gf; this.lastGarageState = null; this.renderGarage(); return; }
    const g = b.dataset.g;
    if (g === 'go') this.app.leaveGarage(this.garageCompound, this.garageFuel);
    if (g === 'setup') this.app.openSetupFromGarage();
    if (g === 'skip') this.app.skipSession();
  }

  // ------------------------------------------------------------------ fast forward (race when player finished / retired / spectating)
  renderFF() {
    const s = this.session, p = s.player;
    const show = s.type === 'race' && (!p || p.retired || p.finishTime != null) && !s.finished;
    this.el.ff.classList.toggle('hidden', !show);
    if (!show) return;
    const cur = s.timeScale;
    const html = [1, 4, 16].map((x) => `<button class="btn small ${cur === x ? 'primary' : ''}" data-ff="${x}">${x}×</button>`).join('') + '<button class="btn small" data-ff="end">Results ▶</button>';
    if (this.el.ff.innerHTML !== html) this.el.ff.innerHTML = html;
  }

  onFFClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.ff === 'end') this.app.skipSession();
    else this.session.timeScale = +b.dataset.ff;
  }
}
