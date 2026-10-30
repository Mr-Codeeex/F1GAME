// Unified input: keyboard, gamepad and touch (on-screen pedals + buttons or tilt steering).
// Produces analog throttle/brake/steer plus edge-triggered actions every frame.
import { clamp, approach } from './sim/util.js';

const KEYMAP = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  gearUp: ['KeyE'],
  gearDown: ['KeyQ'],
  drs: ['Space'],
  overtake: ['KeyF'],
  ersMode: ['KeyR'],
  fuelMix: ['KeyM'],
  pit: ['KeyP'],
  camera: ['KeyC'],
  lookBack: ['KeyB'],
  pause: ['Escape'],
  mfd: ['Tab'],
  reset: ['Backspace'],
  hud: ['KeyH'],
};
const EDGE_ACTIONS = ['gearUp', 'gearDown', 'ersMode', 'fuelMix', 'pit', 'camera', 'pause', 'mfd', 'reset', 'hud', 'drsTap'];

export class InputManager {
  constructor(settings = {}) {
    this.settings = settings;
    this.keys = new Set();
    this.tapped = new Set(); // keys pressed since the last poll (taps shorter than a frame)
    this.prev = {};
    this.state = { throttle: 0, brake: 0, steer: 0, drs: false, overtake: false, lookBack: false };
    this.touch = { left: false, right: false, throttle: false, brake: false, drs: false, overtake: false, lookBack: false, taps: new Set() };
    this.touchSteer = 0;
    this.tilt = 0;
    this.usingGamepad = false;
    this.lastDevice = 'keyboard';
    this.enabled = true;
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace'].includes(e.code) && this.enabled) e.preventDefault();
      this.keys.add(e.code);
      if (!e.repeat) this.tapped.add(e.code);
      this.lastDevice = 'keyboard';
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('deviceorientation', (e) => {
      if (e.gamma == null) return;
      const angle = (screen.orientation?.angle ?? window.orientation ?? 0);
      // in landscape the steering axis is beta; sign depends on rotation direction
      let v = angle === 90 ? e.beta : angle === -90 || angle === 270 ? -e.beta : e.gamma;
      this.tilt = clamp((v ?? 0) / (this.settings.tiltRange ?? 28), -1, 1);
    });
  }

  key(action) {
    return KEYMAP[action]?.some((k) => this.keys.has(k)) ?? false;
  }

  tappedKey(action) {
    return KEYMAP[action]?.some((k) => this.tapped.has(k)) ?? false;
  }

  /** Called by the touch UI */
  setTouch(name, down) {
    if (EDGE_ACTIONS.includes(name)) { if (down) this.touch.taps.add(name); return; }
    this.touch[name] = down;
    this.lastDevice = 'touch';
  }

  readGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const b = (i) => p.buttons[i]?.pressed ?? false;
      const bv = (i) => p.buttons[i]?.value ?? 0;
      const ax = p.axes[0] ?? 0;
      const dz = 0.08;
      const steer = Math.abs(ax) < dz ? 0 : Math.sign(ax) * Math.pow((Math.abs(ax) - dz) / (1 - dz), this.settings.steerGamma ?? 1.6);
      const gp = {
        throttle: bv(7), brake: bv(6), steer,
        drs: b(0), overtake: b(1), pit: b(2), camera: b(3), gearDown: b(4), gearUp: b(5),
        mfd: b(8), pause: b(9), lookBack: b(10) || b(11), ersMode: b(12), fuelMix: b(13), reset: b(14) && b(15),
      };
      if (gp.throttle > 0.05 || gp.brake > 0.05 || Math.abs(ax) > 0.2 || p.buttons.some((x) => x.pressed)) this.lastDevice = 'gamepad';
      return gp;
    }
    return null;
  }

  /**
   * Poll once per frame. speed in m/s (for speed-sensitive steering assist).
   */
  poll(dt, speed = 0, assists = {}) {
    const gp = this.readGamepad();
    const out = { throttle: 0, brake: 0, steer: 0, drs: false, overtake: false, lookBack: false };
    // digital sources
    const kbThrottle = this.key('throttle') || this.touch.throttle;
    const kbBrake = this.key('brake') || this.touch.brake;
    let digitalSteer = (this.key('right') || this.touch.right ? 1 : 0) - (this.key('left') || this.touch.left ? 1 : 0);
    // throttle/brake ramps for digital input (avoid on/off snap)
    const st = this.state;
    st.kThrottle = approach(st.kThrottle ?? 0, kbThrottle ? 1 : 0, dt * (kbThrottle ? 6 : 10));
    st.kBrake = approach(st.kBrake ?? 0, kbBrake ? 1 : 0, dt * (kbBrake ? 9 : 12));
    out.throttle = st.kThrottle;
    out.brake = st.kBrake;
    if (this.settings.autoThrottle && this.lastDevice === 'touch' && !kbBrake) out.throttle = 1;
    // steering
    const steerAssist = assists.steering !== false;
    const v = Math.abs(speed);
    // speed-sensitive lock for digital/tilt steering (keeps the front tyres near peak slip)
    const lock = steerAssist ? clamp(Math.atan(3.6 * 32 / Math.max(25, v * v)) / 0.36 + 0.12, 0.12, 1) : 1;
    let target = digitalSteer * lock;
    let analog = false;
    if (this.settings.touchSteer === 'tilt' && this.lastDevice === 'touch' && this.touchActive) { target = this.tilt * lock; analog = true; }
    if (gp && (Math.abs(gp.steer) > 0.01 || this.lastDevice === 'gamepad')) {
      if (Math.abs(gp.steer) > 0.01) { target = gp.steer * (steerAssist ? Math.max(lock, 0.25) : 1); analog = true; }
      out.throttle = Math.max(out.throttle, gp.throttle);
      out.brake = Math.max(out.brake, gp.brake);
    }
    if (analog) st.steer = approach(st.steer ?? 0, target, dt * 6);
    else {
      const returning = Math.sign(target) !== Math.sign(st.steer ?? 0) || target === 0;
      const rate = returning ? 5.5 : 2.2 + 1.5 * lock;
      st.steer = approach(st.steer ?? 0, target, dt * rate);
    }
    out.steer = st.steer;
    out.drs = this.key('drs') || this.touch.drs || !!gp?.drs;
    out.overtake = this.key('overtake') || this.touch.overtake || !!gp?.overtake;
    out.lookBack = this.key('lookBack') || this.touch.lookBack || !!gp?.lookBack;
    // edges
    for (const a of EDGE_ACTIONS) {
      const held = this.key(a) || !!gp?.[a];
      out[a] = (held && !this.prev[a]) || this.touch.taps.has(a) || (this.tappedKey(a) && !this.prev[a]);
      this.prev[a] = held;
    }
    this.touch.taps.clear();
    this.tapped.clear();
    if (!this.enabled) { out.throttle = 0; out.brake = 0; out.steer = 0; }
    this.state = Object.assign(st, out);
    return out;
  }

  /** Build on-screen touch controls inside container. */
  buildTouchUI(container) {
    this.touchActive = true;
    container.innerHTML = '';
    const mk = (cls, label, name, hold = true) => {
      const el = document.createElement('div');
      el.className = 'tbtn ' + cls;
      el.innerHTML = label;
      const down = (e) => { e.preventDefault(); el.classList.add('on'); this.setTouch(name, true); };
      const up = (e) => { e.preventDefault(); el.classList.remove('on'); if (hold) this.setTouch(name, false); };
      el.addEventListener('touchstart', down, { passive: false });
      el.addEventListener('touchend', up, { passive: false });
      el.addEventListener('touchcancel', up, { passive: false });
      el.addEventListener('mousedown', down);
      el.addEventListener('mouseup', up);
      el.addEventListener('mouseleave', (e) => { if (el.classList.contains('on')) up(e); });
      container.appendChild(el);
      return el;
    };
    if (this.settings.touchSteer !== 'tilt') {
      mk('t-left', '◀', 'left');
      mk('t-right', '▶', 'right');
    }
    mk('t-throttle', 'GAS', 'throttle');
    mk('t-brake', 'BRAKE', 'brake');
    mk('t-drs', 'DRS', 'drs');
    mk('t-ot', 'OT', 'overtake');
    mk('t-pit', 'PIT', 'pit', false);
    mk('t-cam', '🎥', 'camera', false);
    mk('t-mfd', '☰', 'mfd', false);
    mk('t-pause', '❚❚', 'pause', false);
    mk('t-ers', 'ERS', 'ersMode', false);
  }
}

export const KEY_HELP = [
  ['W / ↑', 'Throttle'], ['S / ↓', 'Brake'], ['A D / ← →', 'Steer'], ['E / Q', 'Gear up / down (manual)'],
  ['Space', 'DRS'], ['F', 'ERS Overtake (hold)'], ['R', 'Cycle ERS mode'], ['M', 'Cycle fuel mix'],
  ['P', 'Box request'], ['Tab', 'Strategy / MFD'], ['C', 'Camera'], ['B', 'Look back'], ['H', 'Toggle HUD'],
  ['Backspace', 'Reset to track (practice / time trial)'], ['Esc', 'Pause'],
];
