// Rombo — service worker: funziona offline dopo il primo caricamento.
const CACHE = 'rombo-v3';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'engine-core.js', 'engine-worklet.js', 'presets.js', 'drivetrain.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'assets/loops/cc0_i4_idle_837.wav', 'assets/loops/cc0_i4_low_1476.wav', 'assets/loops/cc0_i4_med_2010.wav', 'assets/loops/cc0_i4_high_2550.wav'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // rete prima (per gli aggiornamenti), cache se offline
  e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
