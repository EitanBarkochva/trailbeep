// מוודא שב-AndroidManifest יש את כל ההרשאות הדרושות למעקב מיקום ברקע.
// רץ ב-CI אחרי "cap add android" (הפרויקט נוצר מחדש בכל בנייה).
const fs = require('fs');

const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
let m = fs.readFileSync(MANIFEST, 'utf8');

const PERMS = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
];

const missing = PERMS.filter(p => !m.includes(p))
  .map(p => `    <uses-permission android:name="${p}" />`)
  .join('\n');

if (missing) {
  m = m.replace(/<application/, missing + '\n\n    <application');
  fs.writeFileSync(MANIFEST, m);
  console.log('✓ added missing permissions to AndroidManifest');
} else {
  console.log('✓ all permissions already present');
}
