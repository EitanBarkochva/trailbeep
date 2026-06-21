/* ============================================================
   מורה דרך — מדריך טיולים שמתריע ברקע (PWA)
   מעקב מיקום ⟶ שאילתת אתרים מ-OpenStreetMap ⟶ צפצוף בקרבה ⟶
   הסבר קצר מויקיפדיה בעברית.
   ============================================================ */

'use strict';

/* ---------- מצב גלובלי ---------- */
const State = {
  map: null,
  tileLayer: null,
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
  driveMode: false,
  driveTarget: null,    // ה-POI שמוצג כרגע בכרטיס הנהיגה
  bearing: null,        // כיוון הנסיעה במעלות
  bearingFrom: null,    // נקודה ממנה מחשבים כיוון
  history: loadHistory(),
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
  camping: {
    emoji: '🏕️', label: 'פיקניק / חניית לילה',
    tags: [['tourism','picnic_site'], ['tourism','camp_site'], ['tourism','caravan_site'], ['leisure','picnic_table']],
  },
  trails: {
    emoji: '🥾', label: 'שביל / שילוט',
    tags: [['highway','trailhead'], ['information','guidepost'], ['tourism','information']],
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
  setNightMode(State.settings.night);
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

  State.tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
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
  updateBearing(lat, lon, p.coords.heading);
  setGps('live', State.tracking ? 'עוקב…' : 'מאותר');
  drawUser(lat, lon, acc);
  if(State.followUser) State.map.setView([lat, lon], Math.max(State.map.getZoom(), 14), { animate:true });
  maybeFetchPOIs(lat, lon);
  checkProximity(lat, lon);
  if(State.driveMode) updateDriveCard();
}

// כיוון נסיעה: מהמכשיר אם זמין, אחרת מחושב מתזוזה של 15 מ׳ ומעלה
function updateBearing(lat, lon, deviceHeading){
  if(deviceHeading != null && !isNaN(deviceHeading) && deviceHeading >= 0){
    State.bearing = deviceHeading; return;
  }
  if(!State.bearingFrom){ State.bearingFrom = { lat, lon }; return; }
  const moved = haversine(State.bearingFrom.lat, State.bearingFrom.lon, lat, lon);
  if(moved >= 15){
    State.bearing = bearing(State.bearingFrom.lat, State.bearingFrom.lon, lat, lon);
    State.bearingFrom = { lat, lon };
  }
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
    if(isDuplicate(name, lat, lon)) continue; // אותו שם קרוב לאתר קיים (node+way כפול)

    const poi = { id, lat, lon, name, cat, tags };
    State.pois.set(id, poi);
    addMarker(poi);
    added++;
  }
  if(added) refreshNearbyBadge();
}

function isDuplicate(name, lat, lon){
  for(const p of State.pois.values()){
    if(p.name === name && haversine(lat, lon, p.lat, p.lon) < 200) return true;
  }
  return false;
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
      if(!(State.settings.onlyNew && isVisited(poi))) fireAlert(poi, d);
    }
    // אם התרחקנו מספיק — מאפסים כדי שיתריע שוב בביקור הבא
    if(d > R * 2.5) State.alerted.delete(poi.id);
  }
}

function fireAlert(poi, dist){
  beep();
  vibrate([180, 80, 180]);
  speak(`מתקרבים ל${poi.name}`);
  showBanner(poi, dist);
  logHistory(poi, dist);
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

  renderNavButtons(poi);
  document.getElementById('shareBtn').onclick = () => shareWhatsApp(poi);

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
      const visited = isVisited(p) ? '<span class="ni-time">✓ כבר עברת כאן</span>' : '';
      return `<div class="nearby-item" onclick="openPlace('${p.id}')">
        <span class="ni-emoji">${c.emoji}</span>
        <span class="ni-body">
          <span class="ni-title">${escapeHtml(p.name)}</span>
          <span class="ni-sub">${c.label}</span>
          ${visited}
        </span>
        <span class="ni-dist">${fmtDist(p._dist)}</span>
      </div>`;
    }).join('');
  }
  panel.classList.add('open');
  showScrim();
}

/* ============================================================
   מצב נהיגה — כרטיס גדול של האתר הבא בדרך
   ============================================================ */
function toggleDriveMode(){
  State.driveMode = !State.driveMode;
  const card = document.getElementById('driveCard');
  const btn = document.getElementById('driveBtn');
  card.classList.toggle('show', State.driveMode);
  btn.classList.toggle('on', State.driveMode);
  if(State.driveMode){
    if(!State.tracking) startTracking(); // מצב נהיגה מפעיל מעקב אוטומטית
    updateDriveCard();
  }
}

function updateDriveCard(){
  const poi = computeNextAhead();
  State.driveTarget = poi;
  const nameEl = document.getElementById('dcName');
  const catEl = document.getElementById('dcCat');
  const distEl = document.getElementById('dcDist');
  const emojiEl = document.getElementById('dcEmoji');
  const arrowEl = document.getElementById('dcArrow');
  if(!poi){
    emojiEl.textContent = '🧭';
    nameEl.textContent = 'מחפש אתרים בדרך…';
    catEl.textContent = ''; distEl.textContent = '';
    arrowEl.style.transform = 'rotate(0deg)'; arrowEl.classList.add('unknown');
    return;
  }
  const c = CATEGORIES[poi.cat];
  emojiEl.textContent = c.emoji;
  nameEl.textContent = poi.name;
  catEl.textContent = c.label;
  distEl.textContent = fmtDist(poi._dist);

  // חץ כיוון: 0° = ישר בכיוון הנסיעה, חיובי = פנייה ימינה
  if(State.bearing != null && State.pos){
    const rel = bearing(State.pos.lat, State.pos.lon, poi.lat, poi.lon) - State.bearing;
    arrowEl.style.transform = `rotate(${rel}deg)`;
    arrowEl.classList.remove('unknown');
  } else {
    arrowEl.style.transform = 'rotate(0deg)';
    arrowEl.classList.add('unknown');
  }
}

// בוחר את האתר הקרוב ביותר שנמצא בערך בכיוון הנסיעה (±80°); אם אין — הקרוב ביותר.
function computeNextAhead(){
  if(!State.pos) return null;
  const list = nearbySorted();
  if(list.length === 0) return null;
  if(State.bearing != null){
    for(const poi of list){
      const b = bearing(State.pos.lat, State.pos.lon, poi.lat, poi.lon);
      if(angleDiff(b, State.bearing) <= 80) return poi;
    }
  }
  return list[0];
}

function openDriveTarget(){ if(State.driveTarget) openPlace(State.driveTarget.id); }
function navDriveTarget(){ if(State.driveTarget) navigateWithPreferred(State.driveTarget); }

/* ============================================================
   ניווט (Waze / Google) ושיתוף
   ============================================================ */
function navUrl(poi, app){
  return app === 'google'
    ? `https://www.google.com/maps/dir/?api=1&destination=${poi.lat},${poi.lon}`
    : `https://waze.com/ul?ll=${poi.lat}%2C${poi.lon}&navigate=yes`;
}
function navigateWithPreferred(poi){
  const app = State.settings.navApp;
  if(app === 'ask'){ openPlace(poi.id); return; } // אין מועדף — נבחר בגיליון
  window.open(navUrl(poi, app), '_blank');
}
function rememberNav(app){
  if(State.settings.navApp === app) return;
  const wasAsk = State.settings.navApp === 'ask';
  State.settings.navApp = app;
  saveSettings();
  const sel = document.getElementById('navAppSel'); if(sel) sel.value = app;
  if(wasAsk) toast('נשמר כברירת מחדל · אפשר לשנות בהגדרות');
}
function renderNavButtons(poi){
  const row = document.getElementById('navRow');
  const app = State.settings.navApp;
  if(app === 'waze' || app === 'google'){
    const cls = app === 'google' ? 'gmaps' : 'waze';
    const label = app === 'google' ? '🗺️ נווט עם Google Maps' : '🚗 נווט עם Waze';
    row.innerHTML = `<button class="primary-btn ${cls}" id="navPref">${label}</button>`;
    document.getElementById('navPref').onclick = () => window.open(navUrl(poi, app), '_blank');
  } else {
    row.innerHTML =
      `<button class="primary-btn waze" id="navWaze">🚗 Waze</button>
       <button class="primary-btn gmaps" id="navGoogle">🗺️ Google Maps</button>`;
    document.getElementById('navWaze').onclick = () => { rememberNav('waze'); window.open(navUrl(poi,'waze'), '_blank'); };
    document.getElementById('navGoogle').onclick = () => { rememberNav('google'); window.open(navUrl(poi,'google'), '_blank'); };
  }
}
function shareWhatsApp(poi){
  const mapsUrl = `https://www.google.com/maps?q=${poi.lat},${poi.lon}`;
  const text = `📍 ${poi.name}\n${mapsUrl}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}

/* ============================================================
   היסטוריה — מקומות שעברנו לידם
   ============================================================ */
function loadHistory(){
  try{ return JSON.parse(localStorage.getItem('moreDerech_history') || '[]'); }
  catch(e){ return []; }
}
function saveHistory(){
  try{ localStorage.setItem('moreDerech_history', JSON.stringify(State.history.slice(0, 200))); }
  catch(e){ /* מלא? נתעלם */ }
}
function logHistory(poi, dist){
  const now = Date.now();
  // לא לרשום שוב את אותו מקום (לפי מזהה או שם) אם נרשם ב-3 השעות האחרונות
  const recent = State.history.find(h =>
    (h.id === poi.id || h.name === poi.name) && (now - h.time) < 3*3600*1000);
  if(recent) return;
  State.history.unshift({
    id: poi.id, name: poi.name, cat: poi.cat,
    lat: poi.lat, lon: poi.lon, dist: Math.round(dist), time: now,
  });
  State.history = State.history.slice(0, 200);
  saveHistory();
}
function openHistory(){
  const panel = document.getElementById('historyPanel');
  const open = panel.classList.contains('open');
  closeAll();
  if(open) return;
  renderHistory();
  panel.classList.add('open');
  showScrim();
}
function renderHistory(){
  const list = document.getElementById('historyList');
  const clearBtn = document.getElementById('clearHistoryBtn');
  if(State.history.length === 0){
    list.innerHTML = '<div class="empty">עוד לא עברת ליד מקומות מסומנים.<br>הפעל מעקב וצא לדרך 🚗</div>';
    clearBtn.hidden = true;
    return;
  }
  clearBtn.hidden = false;
  list.innerHTML = State.history.map(h => {
    const c = CATEGORIES[h.cat] || { emoji:'📍', label:'' };
    return `<div class="nearby-item" onclick="openFromHistory('${h.id}')">
      <span class="ni-emoji">${c.emoji}</span>
      <span class="ni-body">
        <span class="ni-title">${escapeHtml(h.name)}</span>
        <span class="ni-sub">${c.label}</span>
        <span class="ni-time">${fmtTime(h.time)} · עברת ב-${fmtDist(h.dist)}</span>
      </span>
    </div>`;
  }).join('');
}
function openFromHistory(id){
  // אם המקום לא טעון כרגע במפה — נשחזר אותו מההיסטוריה כדי לפתוח פרטים
  if(!State.pois.has(id)){
    const h = State.history.find(x => x.id === id);
    if(h) State.pois.set(id, { id:h.id, name:h.name, cat:h.cat, lat:h.lat, lon:h.lon, tags:{} });
  }
  openPlace(id);
}
function clearHistory(){
  if(!confirm('למחוק את כל ההיסטוריה?')) return;
  State.history = [];
  saveHistory();
  renderHistory();
}
function isVisited(poi){
  return State.history.some(h => h.id === poi.id || h.name === poi.name);
}

/* ============================================================
   מצב לילה — החלפת אריחי מפה כהים
   ============================================================ */
function setNightMode(on){
  document.body.classList.toggle('night', on);
  if(!State.map) return;
  if(State.tileLayer) State.map.removeLayer(State.tileLayer);
  const url = on
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'
    : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  State.tileLayer = L.tileLayer(url, {
    maxZoom: 19,
    attribution: on ? '© OpenStreetMap © CARTO' : '© OpenStreetMap',
  }).addTo(State.map);
}

/* ============================================================
   הגדרות
   ============================================================ */
function loadSettings(){
  const def = { cats:{springs:true,historic:true,nature:true,camping:false,trails:false,tourism:false}, radius:350, sound:true, speak:true, vibrate:true, wake:true, onlyNew:false, night:false, navApp:'ask' };
  try{
    const saved = JSON.parse(localStorage.getItem('moreDerech') || '{}');
    const cats = Object.assign({}, def.cats, saved.cats || {});
    return Object.assign(def, saved, { cats });
  }catch(e){ return def; }
}
function saveSettings(){ localStorage.setItem('moreDerech', JSON.stringify(State.settings)); }

function applySettingsToUI(){
  document.querySelectorAll('[data-cat]').forEach(chk => {
    chk.checked = !!State.settings.cats[chk.dataset.cat];
    chk.addEventListener('change', onCatChange);
  });
  document.getElementById('radiusRange').value = State.settings.radius;
  document.getElementById('radiusVal').textContent = State.settings.radius;
  bindToggle('soundChk','sound'); bindToggle('speakChk','speak'); bindToggle('vibrateChk','vibrate');
  bindToggle('wakeChk','wake'); bindToggle('onlyNewChk','onlyNew'); bindToggle('nightChk','night');
  const navSel = document.getElementById('navAppSel');
  navSel.value = State.settings.navApp;
  navSel.addEventListener('change', () => { State.settings.navApp = navSel.value; saveSettings(); });
}
function bindToggle(elId, key){
  const el = document.getElementById(elId);
  el.checked = State.settings[key];
  el.addEventListener('change', () => {
    State.settings[key] = el.checked; saveSettings();
    if(key === 'wake'){ el.checked && State.tracking ? requestWakeLock() : releaseWakeLock(); }
    if(key === 'night'){ setNightMode(el.checked); }
    if(key === 'speak' && el.checked){ speak('הקראת שם המקום מופעלת'); }
    if(key === 'onlyNew'){ refreshNearbyBadge(); }
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

/* ---------- הקראה קולית (קריין) ---------- */
let heVoice = null;
function pickVoice(){
  if(!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices();
  heVoice = vs.find(v => /^(he|iw)/i.test(v.lang)) || heVoice;
}
if('speechSynthesis' in window){
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
function speak(text){
  if(!State.settings.speak || !('speechSynthesis' in window)) return;
  try{
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'he-IL';
    if(heVoice) u.voice = heVoice;
    u.rate = 1; u.pitch = 1; u.volume = 1;
    speechSynthesis.speak(u);
  }catch(e){ /* אין הקראה */ }
}

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
function bearing(lat1, lon1, lat2, lon2){
  const toRad = d => d*Math.PI/180;
  const y = Math.sin(toRad(lon2-lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lon2-lon1));
  return (Math.atan2(y, x)*180/Math.PI + 360) % 360;
}
function angleDiff(a, b){
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
function fmtTime(ts){
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  if(sameDay) return 'היום ' + hm;
  const yest = new Date(now); yest.setDate(now.getDate()-1);
  if(d.toDateString() === yest.toDateString()) return 'אתמול ' + hm;
  return d.toLocaleDateString('he-IL', { day:'2-digit', month:'2-digit' }) + ' ' + hm;
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
