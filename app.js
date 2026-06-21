/* ============================================================
   מורה דרך — מדריך טיולים שמתריע ברקע (PWA)
   מעקב מיקום ⟶ שאילתת אתרים מ-OpenStreetMap ⟶ צפצוף בקרבה ⟶
   הסבר קצר מויקיפדיה בעברית.
   ============================================================ */

'use strict';

/* ---------- מצב גלובלי ---------- */
const State = {
  map: null,
  userMarker: null,
  accuracyCircle: null,
  pos: null,            // {lat, lon, acc}
  watchId: null,
  tracking: false,
  wakeLock: null,
  pois: new Map(),      // id -> poi
  markers: new Map(),   // id -> leaflet marker
  alerted: new Set(),   // ids שכבר התרענו עליהם
  lastFetchPos: null,   // איפה שאבנו נתונים לאחרונה
  fetching: false,
  followUser: true,
  settings: loadSettings(),
};

/* ---------- קטגוריות ⟶ תגיות OSM + אמוji ---------- */
const CATEGORIES = {
  springs: {
    emoji: '💧', label: 'מעיין / מים',
    tags: [['natural','spring'], ['natural','water'], ['waterway','waterfall']],
  },
  historic: {
    emoji: '🏺', label: 'אתר היסטורי',
    tags: [['historic','*'], ['historic','ruins'], ['historic','archaeological_site']],
  },
  nature: {
    emoji: '🌲', label: 'תצפית / טבע',
    tags: [['tourism','viewpoint'], ['leisure','nature_reserve'], ['boundary','national_park']],
  },
  tourism: {
    emoji: '🎯', label: 'אתר תיירות',
    tags: [['tourism','attraction'], ['tourism','museum'], ['historic','monument']],
  },
};

const ISRAEL_CENTER = [31.7, 35.1];

/* ============================================================
   אתחול
   ============================================================ */
function init(){
  initMap();
  applySettingsToUI();
  registerSW();
  // ניסיון לאתר מיקום פעם אחת מיד (גם בלי מעקב מלא)
  locateOnce();
  window.addEventListener('beforeunload', () => releaseWakeLock());
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function initMap(){
  State.map = L.map('map', { zoomControl:false, attributionControl:true })
    .setView(ISRAEL_CENTER, 8);

  L.control.zoom({ position:'bottomright' }).addTo(State.map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(State.map);

  // אם המשתמש גורר את המפה — מפסיקים לעקוב אוטומטית
  State.map.on('dragstart', () => { State.followUser = false; });
}

/* ============================================================
   מיקום
   ============================================================ */
function locateOnce(){
  if(!('geolocation' in navigator)){ setGps('err','אין GPS'); return; }
  navigator.geolocation.getCurrentPosition(
    p => onPosition(p),
    e => onGeoError(e),
    { enableHighAccuracy:true, timeout:10000, maximumAge:30000 }
  );
}

function toggleTracking(){
  State.tracking ? stopTracking() : startTracking();
}

function startTracking(){
  if(!('geolocation' in navigator)){ toast('המכשיר לא תומך באיתור מיקום'); return; }
  primeAudio(); // לפתוח אודיו מתוך פעולת משתמש
  State.followUser = true;
  State.watchId = navigator.geolocation.watchPosition(
    p => onPosition(p),
    e => onGeoError(e),
    { enableHighAccuracy:true, timeout:15000, maximumAge:5000 }
  );
  State.tracking = true;
  if(State.settings.wake) requestWakeLock();
  const btn = document.getElementById('trackBtn');
  btn.classList.add('on');
  btn.textContent = '⏹ עצור מעקב';
  setGps('live','עוקב…');
  toast('מעקב הופעל — סע בזהירות 🚗');
}

function stopTracking(){
  if(State.watchId != null){ navigator.geolocation.clearWatch(State.watchId); State.watchId = null; }
  State.tracking = false;
  releaseWakeLock();
  const btn = document.getElementById('trackBtn');
  btn.classList.remove('on');
  btn.textContent = '▶ התחל מעקב';
  setGps('','מושהה');
}

function onPosition(p){
  const { latitude:lat, longitude:lon, accuracy:acc } = p.coords;
  State.pos = { lat, lon, acc };
  setGps('live', State.tracking ? 'עוקב…' : 'מאותר');
  drawUser(lat, lon, acc);
  if(State.followUser) State.map.setView([lat, lon], Math.max(State.map.getZoom(), 14), { animate:true });
  maybeFetchPOIs(lat, lon);
  checkProximity(lat, lon);
}

function onGeoError(e){
  console.warn('geo error', e);
  if(e.code === 1) setGps('err','אין הרשאה');
  else if(e.code === 3) setGps('err','איטי…');
  else setGps('err','שגיאה');
}

function drawUser(lat, lon, acc){
  if(!State.userMarker){
    const icon = L.divIcon({ className:'', html:'<div class="user-dot user-pulse"></div>', iconSize:[22,22], iconAnchor:[11,11] });
    State.userMarker = L.marker([lat,lon], { icon, zIndexOffset:1000 }).addTo(State.map);
    State.accuracyCircle = L.circle([lat,lon], { radius:acc||30, color:'#2563eb', weight:1, fillColor:'#2563eb', fillOpacity:.08 }).addTo(State.map);
  } else {
    State.userMarker.setLatLng([lat,lon]);
    State.accuracyCircle.setLatLng([lat,lon]).setRadius(acc||30);
  }
}

function recenter(){
  State.followUser = true;
  if(State.pos) State.map.setView([State.pos.lat, State.pos.lon], 15, { animate:true });
  else { locateOnce(); toast('מאתר מיקום…'); }
}

/* ============================================================
   שליפת אתרים מ-Overpass (OpenStreetMap)
   ============================================================ */
const SEARCH_RADIUS = 4000; // מטרים — סביב המיקום שואבים נתונים
const REFETCH_DIST  = 1500; // מטרים — אחרי כמה תזוזה לשאוב מחדש

function maybeFetchPOIs(lat, lon){
  if(State.fetching) return;
  if(State.lastFetchPos){
    const moved = haversine(lat, lon, State.lastFetchPos.lat, State.lastFetchPos.lon);
    if(moved < REFETCH_DIST) return;
  }
  fetchPOIs(lat, lon);
}

async function fetchPOIs(lat, lon){
  const cats = activeCategories();
  if(cats.length === 0) return;
  State.fetching = true;
  State.lastFetchPos = { lat, lon };

  const query = buildOverpassQuery(lat, lon, cats);
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];

  for(const url of endpoints){
    try{
      const res = await fetch(url, { method:'POST', body:'data='+encodeURIComponent(query) });
      if(!res.ok) throw new Error('HTTP '+res.status);
      const data = await res.json();
      ingestOverpass(data, cats);
      State.fetching = false;
      return;
    }catch(err){
      console.warn('overpass failed', url, err);
    }
  }
  State.fetching = false;
}

function buildOverpassQuery(lat, lon, cats){
  const around = `(around:${SEARCH_RADIUS},${lat},${lon})`;
  const lines = [];
  for(const cat of cats){
    for(const [k,v] of CATEGORIES[cat].tags){
      const sel = v === '*' ? `["${k}"]` : `["${k}"="${v}"]`;
      lines.push(`  node${sel}${around};`);
      lines.push(`  way${sel}${around};`);
    }
  }
  return `[out:json][timeout:25];\n(\n${lines.join('\n')}\n);\nout center tags 120;`;
}

function ingestOverpass(data, cats){
  let added = 0;
  for(const el of (data.elements || [])){
    const id = el.type + el.id;
    if(State.pois.has(id)) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const tags = el.tags || {};
    const name = tags['name:he'] || tags.name || tags['name:en'];
    if(lat == null || lon == null || !name) continue; // בלי שם — לא מעניין להתריע

    const cat = classify(tags, cats);
    if(!cat) continue;

    const poi = { id, lat, lon, name, cat, tags };
    State.pois.set(id, poi);
    addMarker(poi);
    added++;
  }
  if(added) refreshNearbyBadge();
}

function classify(tags, cats){
  for(const cat of cats){
    for(const [k,v] of CATEGORIES[cat].tags){
      if(tags[k] != null && (v === '*' || tags[k] === v)) return cat;
    }
  }
  return null;
}

function addMarker(poi){
  const c = CATEGORIES[poi.cat];
  const icon = L.divIcon({
    className:'',
    html:`<div style="font-size:24px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))">${c.emoji}</div>`,
    iconSize:[28,28], iconAnchor:[14,28], popupAnchor:[0,-26],
  });
  const m = L.marker([poi.lat, poi.lon], { icon }).addTo(State.map);
  m.on('click', () => openPlace(poi.id));
  State.markers.set(poi.id, m);
}

/* ============================================================
   בדיקת קרבה + התראה
   ============================================================ */
function checkProximity(lat, lon){
  const R = State.settings.radius;
  let nearest = null, nearestD = Infinity;

  for(const poi of State.pois.values()){
    const d = haversine(lat, lon, poi.lat, poi.lon);
    poi._dist = d;
    if(d < nearestD){ nearest = poi; nearestD = d; }

    if(d <= R && !State.alerted.has(poi.id)){
      State.alerted.add(poi.id);
      fireAlert(poi, d);
    }
    // אם התרחקנו מספיק — מאפסים כדי שיתריע שוב בביקור הבא
    if(d > R * 2.5) State.alerted.delete(poi.id);
  }
}

function fireAlert(poi, dist){
  beep();
  vibrate([180, 80, 180]);
  showBanner(poi, dist);
  refreshNearbyBadge();
}

function showBanner(poi, dist){
  const c = CATEGORIES[poi.cat];
  const el = document.getElementById('alertBanner');
  el.innerHTML = `
    <span class="ab-emoji">${c.emoji}</span>
    <span class="ab-text">
      <span class="ab-title">${escapeHtml(poi.name)}</span>
      <span class="ab-sub">${c.label} · ${fmtDist(dist)} · הקש לפרטים</span>
    </span>`;
  el.dataset.poi = poi.id;
  el.classList.add('show');
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => el.classList.remove('show'), 9000);
}

function openNearestFromBanner(){
  const id = document.getElementById('alertBanner').dataset.poi;
  if(id) openPlace(id);
  document.getElementById('alertBanner').classList.remove('show');
}

/* ============================================================
   פרטי מקום + הסבר מויקיפדיה
   ============================================================ */
async function openPlace(id){
  const poi = State.pois.get(id);
  if(!poi) return;
  const c = CATEGORIES[poi.cat];

  document.getElementById('sheetIcon').textContent = c.emoji;
  document.getElementById('sheetTitle').textContent = poi.name;
  document.getElementById('sheetCat').textContent = c.label;
  const dist = poi._dist != null ? fmtDist(poi._dist)
             : (State.pos ? fmtDist(haversine(State.pos.lat,State.pos.lon,poi.lat,poi.lon)) : '');
  document.getElementById('sheetDist').textContent = dist ? '📍 ' + dist : '';
  const body = document.getElementById('sheetBody');
  body.innerHTML = '<p class="muted">טוען הסבר…</p>';

  // כפתור ניווט (Google Maps / אפליקציית מפות במכשיר)
  document.getElementById('navBtn').onclick = () =>
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${poi.lat},${poi.lon}`, '_blank');

  openSheet();

  const info = await fetchWikipedia(poi);
  if(info){
    body.innerHTML = `
      ${info.thumb ? `<img src="${info.thumb}" alt="">` : ''}
      <div>${escapeHtml(info.extract)}</div>
      <div class="src">מקור: <a href="${info.url}" target="_blank" rel="noopener">ויקיפדיה</a></div>`;
  } else {
    const q = encodeURIComponent(poi.name);
    body.innerHTML = `
      <p class="muted">לא נמצא הסבר מוכן למקום הזה.</p>
      <div class="src"><a href="https://he.wikipedia.org/w/index.php?search=${q}" target="_blank" rel="noopener">🔍 חפש "${escapeHtml(poi.name)}" בויקיפדיה</a></div>`;
  }
}

async function fetchWikipedia(poi){
  // 1) אם ל-OSM יש תגית wikipedia ישירה — נשתמש בה
  let title = null, lang = 'he';
  const wp = poi.tags.wikipedia || poi.tags['wikipedia:he'];
  if(wp && wp.includes(':')){ const [l,t] = wp.split(/:(.+)/); lang = l || 'he'; title = t; }
  else if(wp){ title = wp; }

  // 2) אחרת — חיפוש גאוגרפי בקרבת הנקודה (ויקיפדיה עברית)
  if(!title){
    try{
      const geo = `https://he.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${poi.lat}%7C${poi.lon}&gsradius=600&gslimit=1&format=json&origin=*`;
      const r = await fetch(geo);
      const j = await r.json();
      const hit = j?.query?.geosearch?.[0];
      if(hit) title = hit.title;
    }catch(e){ console.warn('wiki geosearch', e); }
  }
  // 3) ואם עדיין כלום — חיפוש לפי שם
  if(!title){
    try{
      const s = `https://he.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(poi.name)}&srlimit=1&format=json&origin=*`;
      const r = await fetch(s);
      const j = await r.json();
      const hit = j?.query?.search?.[0];
      if(hit) title = hit.title;
    }catch(e){ console.warn('wiki search', e); }
  }
  if(!title) return null;

  try{
    const sum = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const r = await fetch(sum);
    if(!r.ok) return null;
    const j = await r.json();
    if(!j.extract) return null;
    return {
      extract: j.extract,
      thumb: j.thumbnail?.source || null,
      url: j.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    };
  }catch(e){ console.warn('wiki summary', e); return null; }
}

/* ============================================================
   רשימת "קרוב אליי"
   ============================================================ */
function refreshNearbyBadge(){
  if(!State.pos){ document.getElementById('nearbyCount').textContent = State.pois.size; return; }
  const list = nearbySorted();
  document.getElementById('nearbyCount').textContent = list.length;
}

function nearbySorted(){
  const out = [];
  for(const poi of State.pois.values()){
    const d = State.pos ? haversine(State.pos.lat, State.pos.lon, poi.lat, poi.lon) : (poi._dist ?? Infinity);
    poi._dist = d;
    out.push(poi);
  }
  return out.sort((a,b) => a._dist - b._dist);
}

function openNearbyList(){
  const panel = document.getElementById('nearbyPanel');
  const open = panel.classList.contains('open');
  closeAll();
  if(open) return;
  const list = document.getElementById('nearbyList');
  const items = nearbySorted().slice(0, 40);
  if(items.length === 0){
    list.innerHTML = '<div class="empty">עדיין לא נמצאו מקומות בקרבת מקום.<br>הפעילו מעקב והתחילו לנסוע 🚗</div>';
  } else {
    list.innerHTML = items.map(p => {
      const c = CATEGORIES[p.cat];
      return `<div class="nearby-item" onclick="openPlace('${p.id}')">
        <span class="ni-emoji">${c.emoji}</span>
        <span class="ni-body">
          <span class="ni-title">${escapeHtml(p.name)}</span>
          <span class="ni-sub">${c.label}</span>
        </span>
        <span class="ni-dist">${fmtDist(p._dist)}</span>
      </div>`;
    }).join('');
  }
  panel.classList.add('open');
  showScrim();
}

/* ============================================================
   הגדרות
   ============================================================ */
function loadSettings(){
  const def = { cats:{springs:true,historic:true,nature:true,tourism:false}, radius:350, sound:true, vibrate:true, wake:true };
  try{ return Object.assign(def, JSON.parse(localStorage.getItem('moreDerech') || '{}')); }
  catch(e){ return def; }
}
function saveSettings(){ localStorage.setItem('moreDerech', JSON.stringify(State.settings)); }

function applySettingsToUI(){
  document.querySelectorAll('[data-cat]').forEach(chk => {
    chk.checked = !!State.settings.cats[chk.dataset.cat];
    chk.addEventListener('change', onCatChange);
  });
  document.getElementById('radiusRange').value = State.settings.radius;
  document.getElementById('radiusVal').textContent = State.settings.radius;
  bindToggle('soundChk','sound'); bindToggle('vibrateChk','vibrate'); bindToggle('wakeChk','wake');
}
function bindToggle(elId, key){
  const el = document.getElementById(elId);
  el.checked = State.settings[key];
  el.addEventListener('change', () => {
    State.settings[key] = el.checked; saveSettings();
    if(key === 'wake'){ el.checked && State.tracking ? requestWakeLock() : releaseWakeLock(); }
  });
}
function onCatChange(e){
  State.settings.cats[e.target.dataset.cat] = e.target.checked;
  saveSettings();
  State.lastFetchPos = null; // לאלץ שאיבה מחדש
  if(State.pos) fetchPOIs(State.pos.lat, State.pos.lon);
}
function onRadiusChange(v){
  State.settings.radius = +v;
  document.getElementById('radiusVal').textContent = v;
  saveSettings();
}
function activeCategories(){ return Object.keys(State.settings.cats).filter(k => State.settings.cats[k]); }

/* ============================================================
   אודיו / רטט / Wake Lock
   ============================================================ */
let audioCtx = null;
function primeAudio(){
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if(audioCtx.state === 'suspended') audioCtx.resume();
  }catch(e){ /* אין אודיו */ }
}
function beep(){
  if(!State.settings.sound) return;
  try{
    primeAudio();
    const t = audioCtx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      o.connect(g); g.connect(audioCtx.destination);
      const s = t + i*0.18;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.35, s+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s+0.16);
      o.start(s); o.stop(s+0.18);
    });
  }catch(e){ /* התעלם */ }
}
function vibrate(pattern){ if(State.settings.vibrate && navigator.vibrate) navigator.vibrate(pattern); }

async function requestWakeLock(){
  if(!('wakeLock' in navigator)) return;
  try{
    State.wakeLock = await navigator.wakeLock.request('screen');
    State.wakeLock.addEventListener('release', () => { State.wakeLock = null; });
  }catch(e){ console.warn('wakeLock', e); }
}
function releaseWakeLock(){ if(State.wakeLock){ State.wakeLock.release().catch(()=>{}); State.wakeLock = null; } }
function onVisibilityChange(){
  if(document.visibilityState === 'visible' && State.tracking && State.settings.wake) requestWakeLock();
}

/* ============================================================
   UI כללי
   ============================================================ */
function toggleSettings(){
  const p = document.getElementById('settingsPanel');
  const open = p.classList.contains('open');
  closeAll();
  if(!open){ p.classList.add('open'); showScrim(); }
}
function openSheet(){ document.getElementById('placeSheet').classList.add('open'); showScrim(); }
function closeSheet(){ document.getElementById('placeSheet').classList.remove('open'); maybeHideScrim(); }
function showScrim(){ document.getElementById('scrim').classList.add('show'); }
function maybeHideScrim(){
  const anyOpen = document.querySelector('.panel.open') || document.querySelector('.sheet.open');
  if(!anyOpen) document.getElementById('scrim').classList.remove('show');
}
function closeAll(){
  document.querySelectorAll('.panel.open').forEach(p => p.classList.remove('open'));
  document.getElementById('placeSheet').classList.remove('open');
  document.getElementById('scrim').classList.remove('show');
}
function setGps(cls, text){
  const el = document.getElementById('gpsStatus');
  el.className = 'gps-status' + (cls ? ' ' + cls : '');
  el.querySelector('.gps-text').textContent = text;
}
function toast(msg){
  let t = document.getElementById('toast');
  if(!t){ t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ============================================================
   עזרי חישוב
   ============================================================ */
function haversine(lat1, lon1, lat2, lon2){
  const R = 6371000, toRad = d => d*Math.PI/180;
  const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function fmtDist(m){
  if(m == null || !isFinite(m)) return '';
  return m < 1000 ? Math.round(m/10)*10 + ' מ׳' : (m/1000).toFixed(1) + ' ק״מ';
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ---------- Service Worker ---------- */
function registerSW(){
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
}

window.addEventListener('DOMContentLoaded', init);
