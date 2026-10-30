// Menu screens rendered into #ui. All navigation goes through App callbacks.
import { TRACKS } from '../data/tracks.js';
import { TEAMS, DRIVERS } from '../data/teams.js';
import { Track } from '../sim/track.js';
import { SETUP_GROUPS, SETUP_PRESETS, applyPreset, sanitizeSetup } from '../sim/setup.js';
import { WEATHER_STATES } from '../sim/weather.js';
import { COMPOUNDS } from '../sim/tyres.js';
import { formatTime, ordinal } from '../sim/util.js';
import { KEY_HELP } from '../input.js';
import { RD_TREE, RD_LEVELS, RD_GAIN, upgradeCost, driverStandings, teamStandings, expectedPosition, playerPerf, seasonOver } from '../career.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const trackCache = new Map();
export function getTrack(id) {
  if (!trackCache.has(id)) trackCache.set(id, new Track(TRACKS.find((t) => t.id === id)));
  return trackCache.get(id);
}

export function trackSvg(id, stroke = '#e8edf3') {
  const t = getTrack(id);
  const b = t.bounds();
  const w = b.maxX - b.minX, h = b.maxZ - b.minZ, pad = 60;
  let d = '';
  for (let i = 0; i < t.n; i += 4) d += `${i ? 'L' : 'M'}${(t.px[i] - b.minX + pad).toFixed(0)},${(t.pz[i] - b.minZ + pad).toFixed(0)}`;
  const sf = t.toWorld(0, 0);
  return `<svg class="trackmap" viewBox="0 0 ${w + pad * 2} ${h + pad * 2}" preserveAspectRatio="xMidYMid meet"><path d="${d}Z" fill="none" stroke="rgba(0,0,0,.5)" stroke-width="44" stroke-linejoin="round"/><path d="${d}Z" fill="none" stroke="${stroke}" stroke-width="22" stroke-linejoin="round"/><circle cx="${sf.x - b.minX + pad}" cy="${sf.z - b.minZ + pad}" r="34" fill="#e8102e"/></svg>`;
}

function seg(name, options, current) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, label]) => `<button data-v="${esc(v)}" class="${String(current) === String(v) ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
}

function teamRating(perf) { return Math.round(((perf.aero * 0.45 + perf.power * 0.35 + perf.chassis * 0.2) - 0.7) * 333); }

export class Menus {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.qr = null;
  }

  set(html, cls = '') {
    this.root.innerHTML = `<div class="screen ${cls}">${html}</div>`;
    const sc = this.root.firstElementChild;
    // segmented controls
    sc.querySelectorAll('.seg').forEach((sg) => sg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      sg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      sg.dispatchEvent(new CustomEvent('change', { detail: b.dataset.v, bubbles: true }));
    }));
    return sc;
  }

  clear() { this.root.innerHTML = ''; }

  toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._tt);
    this._tt = setTimeout(() => t.classList.remove('show'), 2200);
  }

  loading(text, frac = null) {
    let el = this.root.querySelector('.loading');
    if (!el) {
      this.root.insertAdjacentHTML('beforeend', '<div class="loading"><div class="brand"><h1>APEX<span>GP</span></h1></div><div class="ltext"></div><div class="bar"><i style="width:0%"></i></div></div>');
      el = this.root.querySelector('.loading');
    }
    el.querySelector('.ltext').textContent = text;
    el.querySelector('.bar').style.visibility = frac == null ? 'hidden' : 'visible';
    if (frac != null) el.querySelector('.bar i').style.width = `${Math.round(frac * 100)}%`;
  }

  hideLoading() { this.root.querySelector('.loading')?.remove(); }

  // ------------------------------------------------------------------ main menu
  main() {
    const save = this.app.save;
    const c = save.career;
    const sc = this.set(`
      <div class="brand"><h1>APEX<span>GP</span></h1><small>Formula racing simulator</small></div>
      <div class="menu-main">
        <div class="card" data-go="career"><span class="ico">🏆</span><span class="tag">${c ? `Season ${c.season} · Round ${Math.min(c.round + 1, c.calendar.length)}` : 'New'}</span><h3>Career</h3><p>Join a team, develop the car, fight for the championship.</p></div>
        <div class="card" data-go="gp"><span class="ico">🏁</span><h3>Grand Prix</h3><p>Full race weekend or quick race on any circuit.</p></div>
        <div class="card" data-go="tt"><span class="ico">⏱</span><h3>Time Trial</h3><p>Hot laps against your ghost.</p></div>
        <div class="card" data-go="records"><span class="ico">📊</span><h3>Records</h3><p>Personal bests and stats.</p></div>
        <div class="card" data-go="settings"><span class="ico">⚙</span><h3>Settings</h3><p>Graphics, audio, controls, assists.</p></div>
        <div class="card" data-go="help"><span class="ico">❔</span><h3>How to Play</h3><p>Controls, DRS, ERS, tyres, flags and penalties.</p></div>
      </div>
      <p style="color:var(--muted);font-size:12px;margin-top:22px">All teams, drivers and circuits are fictional. v1.0</p>`);
    sc.addEventListener('click', (e) => {
      const g = e.target.closest('[data-go]')?.dataset.go;
      if (!g) return;
      this.app.audio.start();
      this.app.audio.blip(880);
      if (g === 'career') this.career();
      if (g === 'gp') this.grandPrix();
      if (g === 'tt') this.timeTrial();
      if (g === 'records') this.records();
      if (g === 'settings') this.settings(() => this.main());
      if (g === 'help') this.help(() => this.main());
    });
  }

  // ------------------------------------------------------------------ grand prix / quick race
  grandPrix() {
    const s = this.app.save.settings;
    this.qr = this.qr ?? { track: TRACKS[0].id, team: TEAMS[3].id, laps: 5, format: 'race', weather: 'dynamic', quali: 'short', difficulty: s.difficulty, practiceMin: 10 };
    const q = this.qr;
    const sc = this.set(`
      <div class="title"><span class="back" data-act="back">◀ Back</span>Grand Prix</div>
      <div class="subtitle">Circuit</div>
      <div class="grid">${TRACKS.map((t) => `<div class="card ${q.track === t.id ? 'sel' : ''}" data-track="${t.id}">${trackSvg(t.id)}<h3>${esc(t.short)}</h3><p>${esc(t.location)} · ${(getTrack(t.id).length / 1000).toFixed(2)} km · ${t.laps} laps</p></div>`).join('')}</div>
      <div class="subtitle">Team</div>
      <div class="grid tight">${TEAMS.map((t) => `<div class="card ${q.team === t.id ? 'sel' : ''}" data-team="${t.id}" style="border-left:5px solid ${t.colors[0]}"><h3 style="font-size:15px">${esc(t.name)}</h3><p>Rating ${teamRating(t.perf)} · ${DRIVERS.filter((d) => d.team === t.id).map((d) => d.short).join(' / ')}</p></div>`).join('')}</div>
      <div class="cols" style="margin-top:16px">
        <div class="panel">
          <div class="field"><label>Weekend format</label>${seg('format', [['race', 'Race only'], ['qr', 'Qualifying + Race'], ['full', 'Full weekend']], q.format)}</div>
          <div class="field"><label>Race length</label>${seg('laps', [[3, '3 laps'], [5, '5 laps'], ['p25', '25%'], ['p50', '50%'], ['p100', '100%']], q.laps)}</div>
          <div class="field"><label>Qualifying</label>${seg('quali', [['short', 'Short'], ['full', 'Q1·Q2·Q3'], ['oneshot', 'One-shot']], q.quali)}</div>
        </div>
        <div class="panel">
          <div class="field"><label>Weather</label>${seg('weather', [['dynamic', 'Dynamic'], ...WEATHER_STATES.map((w) => [w.id, w.icon + ' ' + w.name])], q.weather)}</div>
          <div class="field"><label>AI difficulty</label><span class="val" id="dval">${q.difficulty}</span><input type="range" min="40" max="110" value="${q.difficulty}" id="diff"></div>
          <div class="row end" style="margin-top:10px"><button class="btn" data-act="assists">Assists</button><button class="btn primary" data-act="start">Start weekend ▶</button></div>
        </div>
      </div>`);
    sc.addEventListener('change', (e) => {
      const name = e.target.closest('[data-seg]')?.dataset.seg;
      if (name) q[name] = isNaN(+e.detail) ? e.detail : +e.detail;
    });
    sc.querySelector('#diff').addEventListener('input', (e) => { q.difficulty = +e.target.value; sc.querySelector('#dval').textContent = q.difficulty; });
    sc.addEventListener('click', (e) => {
      const tr = e.target.closest('[data-track]')?.dataset.track;
      const tm = e.target.closest('[data-team]')?.dataset.team;
      if (tr) { q.track = tr; sc.querySelectorAll('[data-track]').forEach((x) => x.classList.toggle('sel', x.dataset.track === tr)); }
      if (tm) { q.team = tm; sc.querySelectorAll('[data-team]').forEach((x) => x.classList.toggle('sel', x.dataset.team === tm)); }
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'back') this.main();
      if (a === 'assists') this.settings(() => this.grandPrix(), 'assists');
      if (a === 'start') this.app.startGrandPrix(q);
    });
  }

  timeTrial() {
    const tt = this.app.save.timeTrial;
    this.tt = this.tt ?? { track: TRACKS[0].id, team: TEAMS[0].id };
    const q = this.tt;
    const sc = this.set(`
      <div class="title"><span class="back" data-act="back">◀ Back</span>Time Trial</div>
      <div class="grid">${TRACKS.map((t) => `<div class="card ${q.track === t.id ? 'sel' : ''}" data-track="${t.id}">${trackSvg(t.id)}<h3>${esc(t.short)}</h3><p>Record: <b>${tt[t.id] ? formatTime(tt[t.id].time) : '—'}</b></p></div>`).join('')}</div>
      <div class="subtitle">Car</div>
      <div class="grid tight">${TEAMS.map((t) => `<div class="card ${q.team === t.id ? 'sel' : ''}" data-team="${t.id}" style="border-left:5px solid ${t.colors[0]}"><h3 style="font-size:15px">${esc(t.name)}</h3><p>Rating ${teamRating(t.perf)}</p></div>`).join('')}</div>
      <div class="row end" style="margin-top:16px"><button class="btn" data-act="setup">Car setup</button><button class="btn primary" data-act="start">Drive ▶</button></div>`);
    sc.addEventListener('click', (e) => {
      const tr = e.target.closest('[data-track]')?.dataset.track;
      const tm = e.target.closest('[data-team]')?.dataset.team;
      if (tr) { q.track = tr; sc.querySelectorAll('[data-track]').forEach((x) => x.classList.toggle('sel', x.dataset.track === tr)); }
      if (tm) { q.team = tm; sc.querySelectorAll('[data-team]').forEach((x) => x.classList.toggle('sel', x.dataset.team === tm)); }
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'back') this.main();
      if (a === 'setup') this.setup(q.track, this.app.getSetup(q.track), (st) => { this.app.storeSetup(q.track, st); this.timeTrial(); });
      if (a === 'start') this.app.startTimeTrial(q);
    });
  }

  // ------------------------------------------------------------------ weekend hub
  weekendHub(wk) {
    const t = TRACKS.find((x) => x.id === wk.trackId);
    const tr = getTrack(wk.trackId);
    const names = { practice: 'Practice', qualifying: 'Qualifying', race: 'Race' };
    const steps = wk.stages.map((st, k) => {
      const res = wk.results[st];
      let info = k === wk.stageIdx ? 'Next' : k < wk.stageIdx ? 'Complete' : '';
      if (res && st !== 'race') { const me = res.find((r) => r.isPlayer); info = me ? `P${me.pos}${me.time ? ' · ' + formatTime(me.time) : ''}` : info; }
      return `<div class="step ${k < wk.stageIdx ? 'done' : k === wk.stageIdx ? 'cur' : ''}"><b>${names[st]}</b><span>${info}</span></div>`;
    }).join('');
    const stage = wk.stages[wk.stageIdx];
    const wx = this.app.previewWeather(wk);
    const fc = wx.upcoming(3600, 5).map((f) => `<div><b>${f.state.icon}</b>${f.t < 1 ? 'Now' : '+' + Math.round(f.t / 60) + 'm'}</div>`).join('');
    const grid = wk.grid ? `<div class="panel"><div class="subtitle" style="margin-top:0">Starting grid</div><table class="tbl">${wk.grid.slice(0, 20).map((e, k) => `<tr class="${e.isPlayer ? 'me' : ''}"><td>${k + 1}</td><td><span class="teambar" style="background:${TEAMS.find((x) => x.id === e.team).colors[0]}"></span>${esc(e.driver.name)}</td></tr>`).join('')}</table></div>` : '';
    const sc = this.set(`
      <div class="title"><span class="back" data-act="quit">◀ ${wk.mode === 'career' ? 'Career' : 'Quit'}</span>${esc(t.name)}</div>
      <div class="cols">
        <div class="panel">${trackSvg(t.id)}
          <div class="row" style="margin-top:8px"><span class="stat"><b>${(tr.length / 1000).toFixed(3)} km</b><span>Length</span></span><span class="stat"><b>${wk.raceLaps}</b><span>Race laps</span></span><span class="stat"><b>${tr.corners.length}</b><span>Corners</span></span><span class="stat"><b>${tr.drsZones.length}</b><span>DRS zones</span></span></div>
          <div class="subtitle">Forecast</div><div class="forecast">${fc}</div>
        </div>
        <div class="panel">
          <div class="weekend-steps">${steps}</div>
          ${stage ? `<div class="subtitle">Next: ${names[stage]}</div>
          <div class="row"><button class="btn primary" data-act="play">Drive ${names[stage]} ▶</button>${stage !== 'race' ? `<button class="btn" data-act="skip">Skip (simulate)</button>` : ''}<button class="btn" data-act="setup">Car setup</button></div>
          ${stage === 'race' ? `<div class="subtitle">Starting tyre</div>${seg('startCompound', [['auto', 'Engineer'], ['S', 'Soft'], ['M', 'Medium'], ['H', 'Hard'], ['I', 'Inter'], ['W', 'Wet']], wk.startCompound ?? 'auto')}` : ''}` : ''}
        </div>
        ${grid}
      </div>`);
    sc.addEventListener('change', (e) => { if (e.target.closest('[data-seg]')?.dataset.seg === 'startCompound') wk.startCompound = e.detail; });
    sc.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'quit') { if (wk.mode === 'career') this.career(); else this.main(); }
      if (a === 'play') this.app.playStage(wk);
      if (a === 'skip') this.app.simulateStage(wk);
      if (a === 'setup') this.setup(wk.trackId, this.app.getSetup(wk.trackId), (st) => { this.app.storeSetup(wk.trackId, st); this.weekendHub(wk); });
    });
  }

  // ------------------------------------------------------------------ car setup
  setup(trackId, setup, onDone) {
    let st = sanitizeSetup(setup);
    const render = () => {
      const groups = SETUP_GROUPS.map((g) => `<div class="panel"><div class="subtitle" style="margin-top:0">${esc(g.name)}</div>${g.params.map((p) => `
        <div class="field"><label>${esc(p.name)}</label><span class="val" data-val="${p.id}">${st[p.id].toFixed(p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 0)}${p.unit ?? ''}</span>
        <input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${st[p.id]}" data-p="${p.id}"><span class="hint">${esc(p.hint)}</span></div>`).join('')}</div>`).join('');
      const sc = this.set(`
        <div class="title"><span class="back" data-act="done">◀ Done</span>Car Setup — ${esc(TRACKS.find((t) => t.id === trackId)?.short ?? '')}</div>
        <div class="row" style="margin-bottom:12px">${Object.entries(SETUP_PRESETS).map(([k, v]) => `<button class="btn small" data-preset="${k}">${esc(v.name)}</button>`).join('')}<span class="spacer"></span><button class="btn small primary" data-act="done">Save & close</button></div>
        <div class="cols">${groups}</div>`);
      sc.addEventListener('input', (e) => {
        const id = e.target.dataset.p;
        if (!id) return;
        const p = SETUP_GROUPS.flatMap((g) => g.params).find((x) => x.id === id);
        st[id] = +e.target.value;
        sc.querySelector(`[data-val="${id}"]`).textContent = st[id].toFixed(p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 0) + (p.unit ?? '');
      });
      sc.addEventListener('click', (e) => {
        const pr = e.target.closest('[data-preset]')?.dataset.preset;
        if (pr) { st = applyPreset(pr); render(); this.toast(`${SETUP_PRESETS[pr].name} preset loaded`); }
        if (e.target.closest('[data-act]')?.dataset.act === 'done') onDone(sanitizeSetup(st));
      });
    };
    render();
  }

  // ------------------------------------------------------------------ results
  results(session, extra, onContinue) {
    const type = session.type;
    const res = session.results ?? [];
    let head, rows;
    if (type === 'race') {
      head = '<tr><th>Pos</th><th>Driver</th><th>Team</th><th class="num">Time / Gap</th><th class="num">Best lap</th><th>Stops</th><th class="num">Pen</th><th class="num">Grid</th></tr>';
      rows = res.map((r) => `<tr class="${r.isPlayer ? 'me' : ''}"><td>${r.status === 'DNF' ? 'DNF' : r.pos}</td><td><span class="teambar" style="background:${r.team.colors[0]}"></span>${esc(r.driver.name)}${r.fastest ? ' <span class="pill" style="background:rgba(177,76,255,.25);color:#d9a6ff">FL</span>' : ''}</td><td>${esc(r.team.short)}</td><td class="num">${esc(r.status === 'DNF' ? (r.reason ?? 'DNF') : r.gap)}</td><td class="num">${formatTime(r.bestLap)}</td><td>${r.comp.tyreHistory.map((h) => `<span class="tyre" style="color:${COMPOUNDS[h.compound].color};width:16px;height:16px;border-width:2px;font-size:8px"><b>${h.compound}</b></span>`).join('')}</td><td class="num">${r.penalties ? r.penalties + 's' : ''}</td><td class="num">${r.grid}</td></tr>`).join('');
    } else {
      head = `<tr><th>Pos</th><th>Driver</th><th>Team</th><th class="num">Best lap</th><th class="num">Gap</th>${type === 'qualifying' ? '<th>Out in</th>' : '<th class="num">Laps</th>'}</tr>`;
      const best = res[0]?.time;
      rows = res.map((r) => `<tr class="${r.isPlayer ? 'me' : ''}"><td>${r.pos}</td><td><span class="teambar" style="background:${r.team.colors[0]}"></span>${esc(r.driver.name)}</td><td>${esc(r.team.short)}</td><td class="num">${formatTime(r.time)}</td><td class="num">${r.time && best && r.pos > 1 ? '+' + (r.time - best).toFixed(3) : ''}</td>${type === 'qualifying' ? `<td>${esc(r.eliminated ?? '')}</td>` : `<td class="num">${r.laps ?? ''}</td>`}</tr>`).join('');
    }
    const me = res.find((r) => r.isPlayer);
    const title = { race: 'Race Classification', qualifying: 'Qualifying Results', practice: 'Practice Times', timetrial: 'Time Trial' }[type];
    const sc = this.set(`
      <div class="title">${title}</div>
      ${me ? `<div class="row" style="margin-bottom:12px"><span class="stat"><b>${me.status === 'DNF' ? 'DNF' : ordinal(me.pos)}</b><span>Your result</span></span>${me.bestLap || me.time ? `<span class="stat"><b>${formatTime(me.bestLap ?? me.time)}</b><span>Best lap</span></span>` : ''}${extra?.html ?? ''}</div>` : ''}
      <div class="panel" style="overflow-x:auto"><table class="tbl">${head}${rows}</table></div>
      <div class="row end" style="margin-top:14px">${extra?.buttons ?? ''}<button class="btn primary" data-act="continue">Continue ▶</button></div>`);
    sc.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'continue') onContinue();
      else if (a && extra?.onAction) extra.onAction(a);
    });
  }

  // ------------------------------------------------------------------ pause
  pause(session, actions) {
    const canSetup = false;
    const sc = this.set(`
      <div style="max-width:420px;margin:8vh auto 0;display:grid;gap:10px">
        <div class="title" style="justify-content:center">Paused</div>
        <button class="btn primary" data-act="resume">Resume</button>
        ${session.type !== 'race' || !session.player?.finishTime ? `<button class="btn" data-act="restart">Restart session</button>` : ''}
        ${session.type !== 'timetrial' ? `<button class="btn" data-act="skip">${session.type === 'race' ? 'Simulate to finish' : 'Skip session'}</button>` : ''}
        ${canSetup ? '<button class="btn" data-act="setup">Car setup</button>' : ''}
        <button class="btn" data-act="settings">Settings</button>
        <button class="btn" data-act="help">Controls</button>
        <button class="btn" data-act="quit">Quit to menu</button>
      </div>`, 'overlay');
    sc.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (!a) return;
      if (a === 'settings') this.settings(() => this.pause(session, actions));
      else if (a === 'help') this.help(() => this.pause(session, actions));
      else actions[a]?.();
    });
  }

  // ------------------------------------------------------------------ career
  career() {
    const c = this.app.save.career;
    if (!c) return this.newCareer();
    if (seasonOver(c)) return this.seasonEnd();
    const nextId = c.calendar[c.round];
    const t = TRACKS.find((x) => x.id === nextId);
    const team = TEAMS.find((x) => x.id === c.teamId);
    const ds = driverStandings(c), ts = teamStandings(c);
    const myPos = ds.findIndex((r) => r.isPlayer) + 1;
    const perf = playerPerf(c);
    const tab = this.careerTab ?? 'standings';
    const standings = `<div class="row" style="margin-bottom:8px">${seg('ctab', [['standings', 'Drivers'], ['teams', 'Constructors'], ['calendar', 'Calendar'], ['rd', 'R&D']], tab)}</div>
      ${tab === 'standings' ? `<table class="tbl">${ds.map((r, k) => `<tr class="${r.isPlayer ? 'me' : ''}"><td>${k + 1}</td><td><span class="teambar" style="background:${TEAMS.find((x) => x.id === r.team).colors[0]}"></span>${esc(r.name)}</td><td class="num">${r.pts}</td></tr>`).join('')}</table>` : ''}
      ${tab === 'teams' ? `<table class="tbl">${ts.map((r, k) => `<tr class="${r.id === c.teamId ? 'me' : ''}"><td>${k + 1}</td><td><span class="teambar" style="background:${r.colors[0]}"></span>${esc(r.name)}</td><td class="num">${r.pts}</td></tr>`).join('')}</table>` : ''}
      ${tab === 'calendar' ? `<table class="tbl">${c.calendar.map((id, k) => { const h = c.history.find((x) => x.round === k + 1); const tt = TRACKS.find((x) => x.id === id); return `<tr class="${k === c.round ? 'me' : ''}"><td>R${k + 1}</td><td>${esc(tt.short)}</td><td>${h ? (h.playerPos ? ordinal(h.playerPos) : 'DNF') : k === c.round ? 'Next' : ''}</td></tr>`; }).join('')}</table>` : ''}
      ${tab === 'rd' ? `<div style="margin-bottom:8px">Resource points: <b style="color:var(--accent2)">${c.resources}</b></div>${RD_TREE.map((r) => { const lvl = c.upgrades[r.id]; const cost = upgradeCost(c, r.id); return `<div class="field"><label>${esc(r.name)} <span class="pill">Lv ${lvl}/${RD_LEVELS}</span></label><button class="btn small ${cost != null && c.resources >= cost ? 'primary' : ''}" data-buy="${r.id}" ${cost == null || c.resources < cost ? 'disabled' : ''}>${cost == null ? 'Maxed' : `Upgrade · ${cost}`}</button><span class="hint">${esc(r.desc)} +${(RD_GAIN * 100).toFixed(1)}% per level · now ${(perf[r.stat] * 100).toFixed(1)}</span></div>`; }).join('')}` : ''}`;
    const sc = this.set(`
      <div class="title"><span class="back" data-act="back">◀ Menu</span>Career — Season ${c.season}</div>
      <div class="row" style="margin-bottom:12px">
        <span class="stat" style="border-left:4px solid ${team.colors[0]}"><b>${esc(c.driver.name)}</b><span>${esc(team.name)} #${c.driver.number}</span></span>
        <span class="stat"><b>${myPos ? ordinal(myPos) : '-'}</b><span>Championship</span></span>
        <span class="stat"><b>${c.standings.drivers.player ?? 0}</b><span>Points</span></span>
        <span class="stat"><b>${c.resources}</b><span>Resources</span></span>
        <span class="stat"><b>P${expectedPosition(c)}</b><span>Team target</span></span>
      </div>
      <div class="cols">
        <div class="panel"><div class="subtitle" style="margin-top:0">Round ${c.round + 1} of ${c.calendar.length}</div>${trackSvg(t.id)}<h3 style="margin:8px 0 2px">${esc(t.name)}</h3><p style="color:var(--muted);margin:0 0 10px">${esc(t.location)}</p>
          <div class="row"><button class="btn primary" data-act="weekend">${c.weekend ? 'Continue weekend ▶' : 'Start race weekend ▶'}</button><button class="btn" data-act="setup">Car setup</button></div>
          <div class="row" style="margin-top:14px"><button class="btn small" data-act="abandon">Abandon career</button></div></div>
        <div class="panel">${standings}</div>
      </div>`);
    sc.addEventListener('change', (e) => { if (e.target.closest('[data-seg]')?.dataset.seg === 'ctab') { this.careerTab = e.detail; this.career(); } });
    sc.addEventListener('click', (e) => {
      const buy = e.target.closest('[data-buy]')?.dataset.buy;
      if (buy) { this.app.buyUpgrade(buy); this.career(); return; }
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'back') this.main();
      if (a === 'weekend') this.app.startCareerWeekend();
      if (a === 'setup') this.setup(t.id, this.app.getSetup(t.id), (st) => { this.app.storeSetup(t.id, st); this.career(); });
      if (a === 'abandon' && confirm('Abandon this career? Progress will be lost.')) { this.app.save.career = null; this.app.persist(); this.main(); }
    });
  }

  newCareer() {
    const st = { name: 'Alex Rivera', number: 27, teamId: TEAMS[6].id, raceLength: 'p25', practice: true, quali: 'short' };
    const sc = this.set(`
      <div class="title"><span class="back" data-act="back">◀ Back</span>New Career</div>
      <div class="cols">
        <div class="panel">
          <div class="field"><label>Driver name</label><input type="text" id="cname" value="${esc(st.name)}" maxlength="22"></div>
          <div class="field"><label>Race number</label><input type="number" id="cnum" value="${st.number}" min="2" max="99" style="width:90px"></div>
          <div class="field"><label>Race length</label>${seg('raceLength', [[5, '5 laps'], ['p25', '25%'], ['p50', '50%'], ['p100', '100%']], st.raceLength)}</div>
          <div class="field"><label>Weekend</label>${seg('practice', [['1', 'Practice + Quali + Race'], ['0', 'Quali + Race']], '1')}</div>
          <div class="field"><label>Qualifying</label>${seg('quali', [['short', 'Short'], ['full', 'Q1·Q2·Q3'], ['oneshot', 'One-shot']], st.quali)}</div>
        </div>
        <div class="panel"><div class="subtitle" style="margin-top:0">Choose your team</div>
          <div class="grid tight">${TEAMS.map((t) => `<div class="card ${st.teamId === t.id ? 'sel' : ''}" data-team="${t.id}" style="border-left:5px solid ${t.colors[0]}"><h3 style="font-size:15px">${esc(t.name)}</h3><p>Rating ${teamRating(t.perf)} · ${t.perf.reliability >= 0.93 ? 'Reliable' : 'Fragile'}</p></div>`).join('')}</div>
          <p style="color:var(--muted);font-size:12px">You replace the team's second driver. Lower-rated teams expect less — beat expectations to earn more resources.</p>
          <div class="row end"><button class="btn primary" data-act="create">Sign contract ▶</button></div>
        </div>
      </div>`);
    sc.addEventListener('change', (e) => { const n = e.target.closest('[data-seg]')?.dataset.seg; if (n) st[n] = e.detail; });
    sc.addEventListener('click', (e) => {
      const tm = e.target.closest('[data-team]')?.dataset.team;
      if (tm) { st.teamId = tm; sc.querySelectorAll('[data-team]').forEach((x) => x.classList.toggle('sel', x.dataset.team === tm)); }
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'back') this.main();
      if (a === 'create') {
        st.name = sc.querySelector('#cname').value.trim() || 'Player';
        st.number = +sc.querySelector('#cnum').value || 27;
        this.app.createCareer(st);
        this.career();
      }
    });
  }

  seasonEnd() {
    const c = this.app.save.career;
    const ds = driverStandings(c), ts = teamStandings(c);
    const me = ds.findIndex((r) => r.isPlayer) + 1;
    const sc = this.set(`
      <div class="title">Season ${c.season} complete</div>
      <div class="row" style="margin-bottom:12px"><span class="stat"><b>${ordinal(me)}</b><span>Drivers' championship</span></span><span class="stat"><b>${ordinal(ts.findIndex((r) => r.id === c.teamId) + 1)}</b><span>Constructors'</span></span><span class="stat"><b>${esc(ds[0].name)}</b><span>Champion</span></span></div>
      <div class="cols"><div class="panel"><table class="tbl">${ds.slice(0, 10).map((r, k) => `<tr class="${r.isPlayer ? 'me' : ''}"><td>${k + 1}</td><td>${esc(r.name)}</td><td class="num">${r.pts}</td></tr>`).join('')}</table></div>
      <div class="panel"><table class="tbl">${ts.map((r, k) => `<tr class="${r.id === c.teamId ? 'me' : ''}"><td>${k + 1}</td><td>${esc(r.name)}</td><td class="num">${r.pts}</td></tr>`).join('')}</table></div></div>
      <div class="row end" style="margin-top:14px"><button class="btn" data-act="menu">Main menu</button><button class="btn primary" data-act="next">Start season ${c.season + 1} ▶</button></div>`);
    sc.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'menu') this.main();
      if (a === 'next') { this.app.nextSeason(); this.career(); }
    });
  }

  // ------------------------------------------------------------------ records
  records() {
    const s = this.app.save;
    const st = s.stats;
    const sc = this.set(`
      <div class="title"><span class="back" data-act="back">◀ Back</span>Records</div>
      <div class="row" style="margin-bottom:12px"><span class="stat"><b>${st.races}</b><span>Races</span></span><span class="stat"><b>${st.wins}</b><span>Wins</span></span><span class="stat"><b>${st.podiums}</b><span>Podiums</span></span><span class="stat"><b>${st.poles}</b><span>Poles</span></span><span class="stat"><b>${Math.round(st.distanceKm)}</b><span>km driven</span></span></div>
      <div class="panel"><table class="tbl"><tr><th>Circuit</th><th class="num">Time trial record</th><th>Car</th><th>Date</th></tr>${TRACKS.map((t) => { const r = s.timeTrial[t.id]; return `<tr><td>${esc(t.name)}</td><td class="num">${r ? formatTime(r.time) : '—'}</td><td>${r ? esc(TEAMS.find((x) => x.id === r.team)?.short ?? '') : ''}</td><td>${r ? new Date(r.date).toLocaleDateString() : ''}</td></tr>`; }).join('')}</table></div>`);
    sc.addEventListener('click', (e) => { if (e.target.closest('[data-act]')?.dataset.act === 'back') this.main(); });
  }

  // ------------------------------------------------------------------ settings
  settings(back, focus = null) {
    const s = this.app.save.settings;
    const a = s.assists;
    const sc = this.set(`
      <div class="title"><span class="back" data-act="back">◀ Back</span>Settings</div>
      <div class="cols">
        <div class="panel" ${focus === 'assists' ? 'style="border-color:var(--accent)"' : ''}><div class="subtitle" style="margin-top:0">Driving assists</div>
          <div class="field"><label>ABS</label>${seg('a.abs', [['true', 'On'], ['false', 'Off']], a.abs)}</div>
          <div class="field"><label>Traction control</label>${seg('a.tc', [[2, 'Full'], [1, 'Medium'], [0, 'Off']], a.tc)}</div>
          <div class="field"><label>Gearbox</label>${seg('a.autoGears', [['true', 'Automatic'], ['false', 'Manual']], a.autoGears)}</div>
          <div class="field"><label>Steering assist</label>${seg('a.steering', [['true', 'On'], ['false', 'Off']], a.steering)}<span class="hint">Speed-sensitive lock for keyboard, touch and tilt.</span></div>
          <div class="field"><label>Braking assist</label>${seg('a.braking', [[0, 'Off'], [1, 'Low'], [2, 'High']], a.braking)}</div>
          <div class="field"><label>Racing line</label>${seg('a.line', [['off', 'Off'], ['corners', 'Corners'], ['full', 'Full']], a.line)}</div>
          <div class="field"><label>Pit assist</label>${seg('a.pit', [['true', 'Auto drive'], ['false', 'Manual entry']], a.pit)}</div>
          <div class="field"><label>Auto DRS</label>${seg('a.drsAuto', [['true', 'On'], ['false', 'Off']], a.drsAuto)}</div>
        </div>
        <div class="panel"><div class="subtitle" style="margin-top:0">Race rules & AI</div>
          <div class="field"><label>AI difficulty</label><span class="val" id="dv">${s.difficulty}</span><input type="range" min="40" max="110" value="${s.difficulty}" data-num="difficulty"></div>
          <div class="field"><label>Damage</label>${seg('damage', [['full', 'Simulation'], ['reduced', 'Reduced'], ['off', 'Off']], s.damage)}</div>
          <div class="field"><label>Safety car</label>${seg('safetyCar', [['on', 'On'], ['reduced', 'Reduced'], ['off', 'Off']], s.safetyCar)}</div>
          <div class="field"><label>Penalties</label>${seg('penalties', [['on', 'On'], ['off', 'Off']], s.penalties)}</div>
          <div class="field"><label>Mechanical failures (AI)</label>${seg('failures', [['true', 'On'], ['false', 'Off']], s.failures)}</div>
          <div class="subtitle">Display</div>
          <div class="field"><label>Units</label>${seg('units', [['kph', 'km/h'], ['mph', 'mph']], s.units)}</div>
          <div class="field"><label>Driver name tags</label>${seg('nameTags', [['true', 'On'], ['false', 'Off']], s.nameTags)}</div>
          <div class="field"><label>FPS counter</label>${seg('showFps', [['true', 'On'], ['false', 'Off']], s.showFps)}</div>
        </div>
        <div class="panel"><div class="subtitle" style="margin-top:0">Graphics</div>
          <div class="field"><label>Quality</label>${seg('quality', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], s.quality)}<span class="hint">Applied on the next session.</span></div>
          <div class="field"><label>Resolution scale</label><span class="val" id="rsv">${Math.round(s.resolutionScale * 100)}%</span><input type="range" min="0.5" max="1" step="0.05" value="${s.resolutionScale}" data-num="resolutionScale"></div>
          <div class="subtitle">Audio</div>
          <div class="field"><label>Master</label><input type="range" min="0" max="1" step="0.05" value="${s.master}" data-num="master"></div>
          <div class="field"><label>Engine</label><input type="range" min="0" max="1" step="0.05" value="${s.engine}" data-num="engine"></div>
          <div class="field"><label>Effects</label><input type="range" min="0" max="1" step="0.05" value="${s.sfx}" data-num="sfx"></div>
          <div class="field"><label>Spoken radio</label>${seg('radioVoice', [['true', 'On'], ['false', 'Off']], s.radioVoice)}</div>
          <div class="subtitle">Touch & controller</div>
          <div class="field"><label>Touch steering</label>${seg('touchSteer', [['buttons', 'Buttons'], ['tilt', 'Tilt']], s.touchSteer)}</div>
          <div class="field"><label>Auto throttle (touch)</label>${seg('autoThrottle', [['true', 'On'], ['false', 'Off']], s.autoThrottle)}</div>
          <div class="field"><label>Tilt range</label><span class="val" id="tr">${s.tiltRange}°</span><input type="range" min="12" max="45" step="1" value="${s.tiltRange}" data-num="tiltRange"></div>
          <div class="field"><label>Stick linearity</label><span class="val" id="sg">${s.steerGamma}</span><input type="range" min="1" max="2.5" step="0.1" value="${s.steerGamma}" data-num="steerGamma"></div>
          <div class="row" style="margin-top:10px"><button class="btn small" data-act="reset">Reset all data</button></div>
        </div>
      </div>`);
    const parse = (v) => (v === 'true' ? true : v === 'false' ? false : isNaN(+v) ? v : +v);
    sc.addEventListener('change', (e) => {
      const n = e.target.closest('[data-seg]')?.dataset.seg;
      if (!n) return;
      if (n.startsWith('a.')) a[n.slice(2)] = parse(e.detail); else s[n] = parse(e.detail);
      this.app.applySettings();
    });
    sc.addEventListener('input', (e) => {
      const n = e.target.dataset.num;
      if (!n) return;
      s[n] = +e.target.value;
      if (n === 'difficulty') sc.querySelector('#dv').textContent = s[n];
      if (n === 'resolutionScale') sc.querySelector('#rsv').textContent = Math.round(s[n] * 100) + '%';
      if (n === 'tiltRange') sc.querySelector('#tr').textContent = s[n] + '°';
      if (n === 'steerGamma') sc.querySelector('#sg').textContent = s[n];
      this.app.applySettings();
    });
    sc.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'back') { this.app.persist(); back(); }
      if (act === 'reset' && confirm('Delete all saved progress, records and settings?')) this.app.resetAll();
    });
  }

  help(back) {
    const sc = this.set(`
      <div class="title"><span class="back" data-act="back">◀ Back</span>How to Play</div>
      <div class="cols">
        <div class="panel"><div class="subtitle" style="margin-top:0">Keyboard</div><table class="tbl">${KEY_HELP.map(([k, d]) => `<tr><td><span class="kbd">${esc(k)}</span></td><td>${esc(d)}</td></tr>`).join('')}</table>
          <div class="subtitle">Gamepad</div><p style="color:var(--muted);font-size:13px;line-height:1.5">Left stick steer · RT throttle · LT brake · A DRS · B Overtake · X Box request · Y Camera · LB/RB gears · Start pause · Back strategy · D-pad up/down ERS / fuel mix · Stick clicks look back.</p>
          <div class="subtitle">Touch</div><p style="color:var(--muted);font-size:13px;line-height:1.5">Left: steering buttons (or tilt). Right: GAS and BRAKE pedals, DRS, OT (overtake), ERS mode. Top-left row: pause, camera, strategy, pit.</p></div>
        <div class="panel"><div class="subtitle" style="margin-top:0">Race craft</div><div style="font-size:14px;line-height:1.55;color:#cfd6df">
          <p><b>DRS</b> opens the rear wing flap on marked straights. In races it is enabled two laps after the start or a restart, when you are within one second of the car ahead at the detection line. Braking closes it. Disabled in the wet.</p>
          <p><b>ERS</b> stores up to 4 MJ. Braking harvests energy; deployment adds up to 120 kW at full throttle. Modes: None (recharge), Medium (sustainable), Hotlap (strong, drains), Overtake button (max power). Deployment is capped at 4 MJ per lap.</p>
          <p><b>Tyres</b>: Soft is fastest but wears quickly; Medium balances; Hard lasts longest. Keep temperatures in the green window. Past ~75% wear grip falls off a cliff. Intermediates for damp, Full Wets for standing water. In dry races of 8+ laps two different dry compounds are mandatory.</p>
          <p><b>Fuel</b>: cars start with just enough fuel. Use Lean mix to save fuel, Rich for extra power.</p>
          <p><b>Flags</b>: yellow — slow down, no overtaking; Safety Car — queue up and hold position; VSC — keep under the speed delta; blue — let faster cars through; black &amp; white — final track-limits warning.</p>
          <p><b>Penalties</b>: track limits (4th offence and beyond), causing a collision, overtaking under SC/VSC, ignoring blue flags. Time penalties are served at your next stop or added to your race time.</p>
          <p><b>Pit stops</b>: request a stop (P or the MFD) and choose the compound. With pit assist on, the car drives itself through the pit lane at the 80 km/h limit.</p>
        </div></div>
      </div>`);
    sc.addEventListener('click', (e) => { if (e.target.closest('[data-act]')?.dataset.act === 'back') back(); });
  }
}
