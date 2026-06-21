/* Service Worker — מורה דרך
   מטמון "מעטפת אפליקציה" כדי שתיפתח גם בלי רשת.
   נתוני המפה/אתרים/ויקיפדיה תמיד מהרשת (לא נשמרים כאן). */

const CACHE = 'more-derech-v4';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);

  // אריחי מפה, Overpass, ויקיפדיה — תמיד מהרשת
  const networkOnly = /tile\.openstreetmap|basemaps\.cartocdn|overpass|wikipedia\.org/.test(url.host + url.pathname);
  if(networkOnly){
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // קבצי המעטפת — network first (כדי שעדכונים יגיעו מיד), עם נפילה למטמון במצב לא-מקוון
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
