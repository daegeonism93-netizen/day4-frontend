// 로컬 개발 서버: 정적 파일 + /api/chat (Vercel 함수와 같은 코드 사용)
//   node dev-server.js   →  http://localhost:5173
// Vercel CLI(`vercel dev`)를 쓰면 이 파일은 필요 없습니다.
const http = require("http");
const fs = require("fs");
const path = require("path");

// .env.local 간단 로더
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env.local"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
} catch { /* .env.local 없음 */ }

const chat = require("./api/chat.js");
const PORT = Number(process.env.PORT) || 5173;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/chat") {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 100_000) req.destroy(); });
    req.on("end", () => {
      try { req.body = raw ? JSON.parse(raw) : undefined; } catch { req.body = undefined; }
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); };
      chat(req, res);
    });
    return;
  }

  let file = path.normalize(path.join(__dirname, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
  const rel = path.relative(__dirname, file);
  const blocked = rel.startsWith("..") || rel.split(path.sep).some((p) => p.startsWith(".") || p === "api" || p === "node_modules");
  if (blocked || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
