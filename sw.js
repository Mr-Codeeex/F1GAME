// Offline cache for the installable (PWA) build. Bump VERSION when shipping changes.
const VERSION = 'apexgp-v1.0.0';
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'assets/icon.svg', 'assets/icon-192.png', 'assets/icon-512.png',
  'vendor/three.module.min.js',
  'src/main.js', 'src/input.js', 'src/audio.js', 'src/career.js',
  'src/data/tracks.js', 'src/data/teams.js',
  'src/sim/util.js', 'src/sim/track.js', 'src/sim/car.js', 'src/sim/tyres.js', 'src/sim/setup.js', 'src/sim/profile.js',
  'src/sim/ai.js', 'src/sim/weather.js', 'src/sim/strategy.js', 'src/sim/session.js',
  'src/render/renderer.js', 'src/render/trackView.js', 'src/render/carView.js', 'src/render/effects.js', 'src/render/textures.js',
  'src/ui/hud.js', 'src/ui/menus.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('index.html'))),
  );
});
