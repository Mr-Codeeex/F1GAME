// Renders every circuit to an SVG (and reports closure / length stats) for layout design.
// Usage: node tools/preview-tracks.mjs [outDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { TRACKS } from '../src/data/tracks.js';
import { Track, closeSegments } from '../src/sim/track.js';

const outDir = process.argv[2] ?? 'tools/out';
mkdirSync(outDir, { recursive: true });

for (const def of TRACKS) {
  let t;
  try { t = new Track(def); } catch (e) { console.log(def.id, 'ERROR', e.message); continue; }
  const changes = def.segments ? closeSegments(def.segments).map((s, i) => (s[0] === 'S' ? s[1] - def.segments[i][1] : s[2] - def.segments[i][2])) : [];
  const b = t.bounds();
  const pad = 80;
  const w = b.maxX - b.minX + pad * 2, h = b.maxZ - b.minZ + pad * 2;
  let path = '', line = '', left = '', right = '';
  for (let i = 0; i < t.n; i += 2) {
    const c = i === 0 ? 'M' : 'L';
    path += `${c}${(t.px[i] - b.minX + pad).toFixed(1)},${(t.pz[i] - b.minZ + pad).toFixed(1)} `;
    line += `${c}${(t.lx[i] - b.minX + pad).toFixed(1)},${(t.lz[i] - b.minZ + pad).toFixed(1)} `;
    const l = t.toWorld(i * t.step, -t.barrierAt(i * t.step, -1));
    const r = t.toWorld(i * t.step, t.barrierAt(i * t.step, 1));
    left += `${c}${(l.x - b.minX + pad).toFixed(1)},${(l.z - b.minZ + pad).toFixed(1)} `;
    right += `${c}${(r.x - b.minX + pad).toFixed(1)},${(r.z - b.minZ + pad).toFixed(1)} `;
  }
  const marks = [];
  const mark = (s, color, label) => {
    const p = t.toWorld(s, 0);
    marks.push(`<circle cx="${p.x - b.minX + pad}" cy="${p.z - b.minZ + pad}" r="12" fill="${color}"/><text x="${p.x - b.minX + pad + 14}" y="${p.z - b.minZ + pad}" font-size="34" fill="#fff">${label}</text>`);
  };
  mark(0, '#fff', 'S/F');
  mark(t.pit.entryS, '#f80', 'PitIn');
  mark(t.pit.exitS, '#f80', 'PitOut');
  t.sectors.slice(1).forEach((s, k) => mark(s, '#ff0', 'S' + (k + 2)));
  t.drsZones.forEach((z, k) => { mark(z.start, '#0f0', 'DRS' + (k + 1)); mark(z.end, '#080', ''); mark(z.detect, '#0ff', 'D'); });
  t.corners.forEach((c) => { const p = t.toWorld(c.s, 0); marks.push(`<text x="${p.x - b.minX + pad}" y="${p.z - b.minZ + pad - 16}" font-size="28" fill="#f66">T${c.number}</text>`); });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="880" height="680" style="background:#123"><path d="${left}Z" fill="none" stroke="#555" stroke-width="2"/><path d="${right}Z" fill="none" stroke="#555" stroke-width="2"/><path d="${path}Z" fill="none" stroke="#999" stroke-width="${t.width}"/><path d="${line}Z" fill="none" stroke="#e33" stroke-width="2"/>${marks.join('')}</svg>`;
  writeFileSync(`${outDir}/${def.id}.svg`, svg);
  console.log(`${def.id.padEnd(12)} length ${(t.length / 1000).toFixed(3)} km  corners ${t.corners.length}  maxRun ${Math.max(...t.runL).toFixed(0)}  adjust ${changes.map((c) => c.toFixed(0)).join(',')}`);
}
