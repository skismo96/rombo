// Rombo BETA — service worker separato: scope /rombo/beta/, cache propria (rombo-beta-*).
// Non tocca mai le cache della versione principale e ignora qualsiasi richiesta fuori dalla cartella beta.
const CACHE = 'rombo-beta-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'engine-core.js', 'engine-worklet.js', 'presets.js', 'drivetrain.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'assets/loops/cc0_i4_idle_837.wav', 'assets/loops/cc0_i4_low_1476.wav', 'assets/loops/cc0_i4_med_2010.wav', 'assets/loops/cc0_i4_high_2550.wav'];
const SCOPE = self.registration.scope; // es. https://skismo96.github.io/rombo/beta/
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  // elimina solo le vecchie cache della beta
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('rombo-beta-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(SCOPE)) return; // fuori dalla beta: non intercettare
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
