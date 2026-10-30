// Procedural textures generated on canvas (no external assets).
import * as THREE from '../../vendor/three.module.min.js';
import { makeRng } from '../sim/util.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, repeat = true, aniso = 4) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = aniso;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function noise(ctx, w, h, base, spread, rng, alpha = 1, size = 1) {
  for (let i = 0; i < (w * h) / (size * size) * 0.6; i++) {
    const v = base + (rng() - 0.5) * spread;
    ctx.fillStyle = `rgba(${v | 0},${v | 0},${v | 0},${alpha})`;
    ctx.fillRect(rng() * w, rng() * h, size, size);
  }
}

export function makeTextures(theme = 'coastal', quality = 'high') {
  const rng = makeRng(42);
  const res = quality === 'low' ? 256 : 512;
  const T = {};

  // asphalt
  {
    const [c, g] = canvas(res, res);
    g.fillStyle = '#3d3f42'; g.fillRect(0, 0, res, res);
    noise(g, res, res, 62, 40, rng, 0.9, 2);
    noise(g, res, res, 90, 60, rng, 0.25, 1);
    // rubbered line darkening in the middle band
    const grd = g.createLinearGradient(0, 0, res, 0);
    grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(0.35, 'rgba(0,0,0,0.12)'); grd.addColorStop(0.65, 'rgba(0,0,0,0.12)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, res, res);
    T.asphalt = tex(c);
  }
  // grass
  {
    const [c, g] = canvas(res, res);
    const base = theme === 'desert' ? '#a88b5a' : theme === 'alpine' ? '#4f7a3a' : theme === 'tropical' ? '#3f7d2e' : '#4b7f34';
    g.fillStyle = base; g.fillRect(0, 0, res, res);
    for (let i = 0; i < res * res * 0.5; i++) {
      const d = (rng() - 0.5) * 40;
      const col = new THREE.Color(base);
      g.fillStyle = `rgb(${(col.r * 255 + d) | 0},${(col.g * 255 + d * 1.2) | 0},${(col.b * 255 + d * 0.5) | 0})`;
      g.fillRect(rng() * res, rng() * res, 2, 2);
    }
    // mowing stripes
    if (theme !== 'desert') for (let y = 0; y < res; y += res / 8) { g.fillStyle = (y / (res / 8)) % 2 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'; g.fillRect(0, y, res, res / 8); }
    T.grass = tex(c);
  }
  // gravel
  {
    const [c, g] = canvas(res, res);
    g.fillStyle = theme === 'desert' ? '#c9a46c' : '#b8ab92'; g.fillRect(0, 0, res, res);
    for (let i = 0; i < res * res * 0.35; i++) {
      const v = 150 + (rng() - 0.5) * 90;
      g.fillStyle = `rgb(${v + 20 | 0},${v + 10 | 0},${v - 10 | 0})`;
      g.fillRect(rng() * res, rng() * res, 2 + rng() * 2, 2 + rng() * 2);
    }
    T.gravel = tex(c);
  }
  // runoff asphalt (lighter, with coloured stripes typical of modern circuits)
  {
    const [c, g] = canvas(256, 256);
    g.fillStyle = '#55585c'; g.fillRect(0, 0, 256, 256);
    noise(g, 256, 256, 85, 40, rng, 0.8, 2);
    g.fillStyle = theme === 'desert' ? 'rgba(200,60,40,0.55)' : 'rgba(40,90,200,0.45)';
    g.fillRect(0, 0, 256, 96);
    T.runoff = tex(c);
  }
  // kerb (red/white stripes along v)
  {
    const [c, g] = canvas(64, 128);
    g.fillStyle = '#e8e8e8'; g.fillRect(0, 0, 64, 128);
    g.fillStyle = theme === 'city' ? '#2a62d4' : '#d4202a'; g.fillRect(0, 0, 64, 64);
    for (let x = 0; x < 64; x += 16) { g.fillStyle = 'rgba(0,0,0,0.08)'; g.fillRect(x, 0, 2, 128); }
    T.kerb = tex(c);
  }
  // barrier: tyre wall / armco with ad boards
  {
    const [c, g] = canvas(512, 64);
    const ads = ['VELOX', 'AURUM FUEL', 'KAPPA TYRES', 'NOVA BANK', 'ORBITAL', 'ZEPHYR', 'HELIX OIL', 'PRISMA'];
    const cols = ['#0b3d91', '#c8102e', '#111', '#f2a900', '#0a7e3e', '#5b2a86', '#e6e6e6', '#ff6a00'];
    for (let i = 0; i < 4; i++) {
      const k = Math.floor(rng() * ads.length);
      g.fillStyle = cols[k]; g.fillRect(i * 128, 0, 128, 64);
      g.fillStyle = cols[k] === '#e6e6e6' || cols[k] === '#f2a900' ? '#111' : '#fff';
      g.font = 'bold 22px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(ads[k], i * 128 + 64, 32);
    }
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(0, 0, 512, 3); g.fillRect(0, 61, 512, 3);
    T.barrier = tex(c);
  }
  // concrete wall with fence (street)
  {
    const [c, g] = canvas(256, 128);
    g.fillStyle = '#c9c9c9'; g.fillRect(0, 64, 256, 64);
    noise(g, 256, 64, 200, 30, rng, 0.5, 2);
    g.clearRect(0, 0, 256, 64);
    g.strokeStyle = 'rgba(80,80,80,0.9)'; g.lineWidth = 1;
    for (let x = -64; x < 320; x += 8) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 64, 64); g.stroke(); g.beginPath(); g.moveTo(x + 64, 0); g.lineTo(x, 64); g.stroke(); }
    g.fillStyle = '#d02020'; g.fillRect(0, 64, 256, 8);
    T.streetWall = tex(c);
  }
  // crowd
  {
    const [c, g] = canvas(256, 256);
    g.fillStyle = '#2a2d33'; g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 8) for (let x = 0; x < 256; x += 5) {
      if (rng() < 0.85) {
        const hue = Math.floor(rng() * 360);
        g.fillStyle = `hsl(${hue},${40 + rng() * 40}%,${35 + rng() * 35}%)`;
        g.fillRect(x + rng(), y + 2, 4, 5);
        g.fillStyle = '#e0b090'; g.fillRect(x + 1, y, 2, 2);
      }
    }
    T.crowd = tex(c);
  }
  // building windows
  {
    const [c, g] = canvas(128, 256);
    g.fillStyle = '#5b6470'; g.fillRect(0, 0, 128, 256);
    for (let y = 6; y < 256; y += 14) for (let x = 6; x < 128; x += 14) {
      g.fillStyle = rng() < 0.3 ? '#f4e2a8' : `rgb(${40 + rng() * 40},${60 + rng() * 40},${80 + rng() * 50})`;
      g.fillRect(x, y, 9, 9);
    }
    T.windows = tex(c);
  }
  // checker (start line)
  {
    const [c, g] = canvas(64, 64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f2f2f2'; g.fillRect(x * 8, y * 8, 8, 8); }
    T.checker = tex(c);
    T.checker.magFilter = THREE.NearestFilter;
  }
  // soft particle sprite
  {
    const [c, g] = canvas(64, 64);
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.4, 'rgba(255,255,255,0.5)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    T.sprite = tex(c, false);
  }
  // tyre sidewall
  {
    const [c, g] = canvas(256, 32);
    g.fillStyle = '#151515'; g.fillRect(0, 0, 256, 32);
    g.fillStyle = '#2a2a2a';
    for (let x = 0; x < 256; x += 32) g.fillRect(x, 10, 14, 12);
    T.tyre = tex(c);
  }
  // water
  {
    const [c, g] = canvas(256, 256);
    g.fillStyle = theme === 'tropical' ? '#1f6f86' : '#1d4f7a'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(255,255,255,${rng() * 0.12})`; g.fillRect(rng() * 256, rng() * 256, 6 + rng() * 10, 1); }
    T.water = tex(c);
  }
  return T;
}
