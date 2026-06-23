// מזריק הגדרות חתימה ל-android/app/build.gradle (לבניית AAB חתום ל-Google Play).
// המפתח והסיסמאות מגיעים ממשתני סביבה (GitHub Secrets) — לא נשמרים בקוד.
const fs = require('fs');

const GRADLE = 'android/app/build.gradle';
let g = fs.readFileSync(GRADLE, 'utf8');

if (g.includes('signingConfigs')) {
  console.log('✓ signingConfigs already present');
  process.exit(0);
}

const signing = `    signingConfigs {
        release {
            storeFile file(System.getenv("KEYSTORE_PATH") ?: "upload.keystore")
            storePassword System.getenv("KEYSTORE_PASSWORD")
            keyAlias System.getenv("KEY_ALIAS")
            keyPassword System.getenv("KEY_PASSWORD")
        }
    }
`;

// 1) מוסיף signingConfig לבלוק release שבתוך buildTypes
g = g.replace(/(buildTypes\s*\{\s*release\s*\{)/, `$1\n            signingConfig signingConfigs.release`);

// 2) מזריק את בלוק signingConfigs ממש לפני buildTypes
g = g.replace(/(\n\s*buildTypes\s*\{)/, `\n${signing}$1`);

fs.writeFileSync(GRADLE, g);
console.log('✓ injected signingConfigs into build.gradle');
