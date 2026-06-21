// שרת סטטי מינימלי לתצוגה מקדימה (ללא תלויות חיצוניות)
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8766;
const ROOT = path.resolve(__dirname, "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml"
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);

  // נקודת שמירה לפיתוח בלבד: כתיבת PNG מבסיס64 (לרסטור אייקונים מהדפדפן)
  if (req.method === "POST" && urlPath === "/__save") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const { path: p, b64 } = JSON.parse(body);
        const out = path.join(ROOT, p);
        if (!out.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
        fs.writeFileSync(out, Buffer.from(b64, "base64"));
        res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
        res.end("ok");
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    return;
  }

  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log("Static server on http://localhost:" + PORT));
