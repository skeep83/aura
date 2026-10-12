// Aura Admin — панель управления в домашней сети (TrueNAS). Без зависимостей: node admin/server.js
// Хранит токен админ-API у себя (браузер его не видит), пускает по паролю, проксирует /api/* → <AURA_API>/api/admin/*.
//   AURA_API              https://aura-life.online
//   ADMIN_API_TOKEN       токен из .env продакшена (тот же)
//   ADMIN_PASSWORD_HASH   scrypt-хэш пароля «salt:hash» (hex) — задаётся скриптом set_admin_password.py
//   PORT                  8090
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const env = process.env;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const API = (env.AURA_API || 'https://aura-life.online').replace(/\/$/, '');
const TOKEN = env.ADMIN_API_TOKEN || '';
const HASH = env.ADMIN_PASSWORD_HASH || '';
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map(); // id -> expires
const fails = new Map();    // ip -> { n, until }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'",
};

function checkPassword(pw) {
  const [salt, hash] = HASH.split(':');
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function sessionOf(req) {
  const m = /(?:^|;\s*)aura_admin=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) { sessions.delete(m[1]); return null; }
  return m[1];
}

const json = (res, code, data, extra = {}) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY, ...extra });
  res.end(JSON.stringify(data));
};

async function body(req, max = 20_000) {
  let b = '';
  for await (const c of req) { b += c; if (b.length > max) throw new Error('too large'); }
  return b;
}

async function login(req, res) {
  const ip = req.socket.remoteAddress || '';
  const f = fails.get(ip);
  if (f && f.n >= 5 && Date.now() < f.until) return json(res, 429, { error: 'locked', retryAfterSec: Math.ceil((f.until - Date.now()) / 1000) });
  if (!HASH) return json(res, 503, { error: 'no_password' });
  let pw = '';
  try { pw = JSON.parse(await body(req)).password || ''; } catch {}
  if (!checkPassword(pw)) {
    const n = (f && Date.now() < f.until ? f.n : 0) + 1;
    fails.set(ip, { n, until: Date.now() + 5 * 60 * 1000 });
    await new Promise(r => setTimeout(r, 600));
    return json(res, 401, { error: 'bad_password' });
  }
  fails.delete(ip);
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, Date.now() + SESSION_MS);
  json(res, 200, { ok: true }, { 'set-cookie': `aura_admin=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
}

// Прокси к продакшену с токеном; ответ передаём как есть
async function proxy(req, res, url) {
  if (!TOKEN) return json(res, 503, { error: 'no_token' });
  const target = `${API}/api/admin/${url.pathname.slice('/api/'.length)}${url.search}`;
  try {
    const r = await fetch(target, {
      method: req.method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'user-agent': 'aura-admin/1.0' },
      body: req.method === 'POST' ? await body(req) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY });
    res.end(text);
  } catch (e) {
    json(res, 502, { error: 'upstream', detail: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, token: Boolean(TOKEN), password: Boolean(HASH) });
  if (url.pathname === '/auth/login' && req.method === 'POST') return login(req, res);
  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    const s = sessionOf(req); if (s) sessions.delete(s);
    return json(res, 200, { ok: true }, { 'set-cookie': 'aura_admin=; Path=/; Max-Age=0' });
  }
  if (url.pathname === '/auth/me') return json(res, 200, { authed: Boolean(sessionOf(req)), password: Boolean(HASH), token: Boolean(TOKEN), api: API });
  if (url.pathname.startsWith('/api/')) {
    if (!sessionOf(req)) return json(res, 401, { error: 'login' });
    // Защита от CSRF: изменяющие запросы только со своей страницы
    if (req.method !== 'GET' && req.headers['x-aura-admin'] !== '1') return json(res, 403, { error: 'csrf' });
    return proxy(req, res, url);
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY });
    res.end(buf);
  });
});

setInterval(() => { const now = Date.now(); for (const [k, v] of sessions) if (v < now) sessions.delete(k); }, 10 * 60 * 1000).unref();

server.listen(Number(env.PORT || 8090), () => {
  console.log(`Aura Admin on :${env.PORT || 8090} → ${API}`);
  if (!TOKEN) console.warn('ADMIN_API_TOKEN не задан');
  if (!HASH) console.warn('Пароль не задан — set_admin_password.py');
});
