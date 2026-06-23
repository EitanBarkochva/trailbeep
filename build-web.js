// מעתיק את נכסי האתר ל-www/ (התיקייה ש-Capacitor אורז לתוך האפליקציה)
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'www');
const FILES = ['index.html', 'app.js', 'style.css', 'manifest.webmanifest'];
const DIRS = ['icons'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const f of FILES) {
  fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
}
for (const d of DIRS) {
  fs.cpSync(path.join(ROOT, d), path.join(OUT, d), { recursive: true });
}

// בגרסת ה-native אין צורך ב-Service Worker (גורם לבעיות מטמון ב-WebView) — לא מעתיקים sw.js
console.log('✓ web assets copied to www/');
