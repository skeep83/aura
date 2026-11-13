// Вход через Google (HOM-40, план HOM-35 §4.2, §5): OIDC authorization code + PKCE и проверка id_token по JWKS.
// Внешних сетей тесты не трогают: «Google» — локальный http-сервер, который подписывает id_token
// настоящим RS256 на сгенерированной паре ключей и отдаёт свой JWKS.
// Хелперы здесь свои, а не из webaccounts.test.js: соседние задачи E4/E5 правят тот файл параллельно.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { providersFrom } from '../src/webauth.js';
import { createJwks, verifyIdToken } from '../src/oidc.js';

const CLIENT_ID = '1234567890-aura.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-secret';
const ISSUER = 'https://accounts.google.com';

// ---------- «Google»: /authorize → code → /token (id_token RS256) → /certs ----------
async function fakeGoogle() {
  const keys = ['k1', 'k2'].map(kid => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
  });
  const codes = new Map();
  // Что отдаём на следующем входе: профиль, подмены claims, ключ подписи и поведение эндпоинтов
  const state = {
    profile: { sub: 'google-1', email: 'one@gmail.com', email_verified: true, name: 'Гугл Один', picture: 'https://lh3.googleusercontent.com/a/one' },
    claims: {}, signKid: 'k1', signWith: null, publish: ['k1', 'k2'], deny: '', tokenStatus: 0, lastAuthorize: null,
  };

  function idToken(nonce) {
    const key = keys.find(k => k.kid === state.signKid);
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: state.signKid, typ: 'JWT' };
    const claims = {
      iss: ISSUER, aud: CLIENT_ID, azp: CLIENT_ID, iat: now, exp: now + 3600, nonce,
      ...state.profile, ...state.claims,
    };
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${b64(header)}.${b64(claims)}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(input), state.signWith || key.privateKey);
    return `${input}.${sig.toString('base64url')}`;
  }

  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/authorize') {
      state.lastAuthorize = url;
      const to = new URL(url.searchParams.get('redirect_uri'));
      to.searchParams.set('state', url.searchParams.get('state') || '');
      if (state.deny) {
        to.searchParams.set('error', state.deny);
        res.writeHead(302, { location: to.href });
        return res.end();
      }
      if (url.searchParams.get('client_id') !== CLIENT_ID) return send(400, { error: 'client' });
      if (url.searchParams.get('code_challenge_method') !== 'S256') return send(400, { error: 'pkce' });
      const code = 'code-' + crypto.randomBytes(6).toString('hex');
      codes.set(code, { challenge: url.searchParams.get('code_challenge'), nonce: url.searchParams.get('nonce') || '' });
      to.searchParams.set('code', code);
      res.writeHead(302, { location: to.href });
      return res.end();
    }
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', c => { body += c; });
      return req.on('end', () => {
        if (state.tokenStatus) return send(state.tokenStatus, { error: 'provider_down' });
        const p = new URLSearchParams(body);
        const rec = codes.get(p.get('code'));
        if (!rec) return send(400, { error: 'bad_code' });
        codes.delete(p.get('code')); // код одноразовый, как у настоящего Google
        if (p.get('client_secret') !== CLIENT_SECRET) return send(401, { error: 'client_secret' });
        const challenge = crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
        if (challenge !== rec.challenge) return send(400, { error: 'pkce' });
        send(200, { access_token: 'at-' + crypto.randomBytes(6).toString('hex'), token_type: 'Bearer', expires_in: 3599, id_token: idToken(rec.nonce) });
      });
    }
    if (url.pathname === '/certs') {
      return send(200, { keys: keys.filter(k => state.publish.includes(k.kid)).map(k => k.jwk) }, { 'cache-control': 'public, max-age=21600' });
    }
    send(404, { error: 'nope' });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { srv, base, state, keys };
}

const googleEnv = prov => ({
  AUTH_PROVIDERS: 'google',
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  AUTH_GOOGLE_AUTHORIZE_URL: prov.base + '/authorize',
  AUTH_GOOGLE_TOKEN_URL: prov.base + '/token',
  AUTH_GOOGLE_JWKS_URL: prov.base + '/certs',
  AUTH_GOOGLE_ISSUER: ISSUER,
});

// Порты выдаём по порядку от случайной базы: два сервера на одном порту дали бы
// запросы в живой сервер прошлого теста — с его базой и его счётчиком rate limit
const PORT_BASE = 20300 + Math.floor(Math.random() * 60) * 10;
let portOffset = 0;

async function startServer(t, extraEnv = {}) {
  const port = PORT_BASE + portOffset++;
  const srv = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(port), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'aura-google-')),
      DEV_ALLOW_ANON: '0', WEB_ANON: '1', BOT_TOKEN: '', BOT_POLLING: '0', AUTH_COOKIE_INSECURE: '1',
      NODE_NO_WARNINGS: '1', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => srv.kill());
  await once(srv.stdout, 'data');
  return `http://127.0.0.1:${port}`;
}

// Браузер: своя банка cookie, редиректы руками
function browser(base) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const raws = [];
  async function req(url, opts = {}) {
    const res = await fetch(url.startsWith('http') ? url : base + url, {
      redirect: 'manual', ...opts,
      headers: { ...(opts.headers || {}), ...(jar.size ? { cookie: cookieHeader() } : {}) },
    });
    for (const raw of res.headers.getSetCookie?.() || []) {
      raws.push(raw);
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (!v || /Max-Age=0/i.test(raw)) jar.delete(k); else jar.set(k, v);
    }
    return res;
  }
  return {
    jar, req, raws, cookieHeader,
    session: () => jar.get('aura_session') || '',
    // Весь поход «кнопка Google → consent → колбэк», как его делает браузер
    async login(provider = 'google', { anonSession = '', returnTo = '/' } = {}) {
      const q = new URLSearchParams({ return: returnTo });
      if (anonSession) q.set('anon_session', anonSession);
      const start = await req(`/auth/${provider}/start?${q}`);
      assert.equal(start.status, 302, 'start → 302 к провайдеру');
      const atProvider = await fetch(start.headers.get('location'), { redirect: 'manual' });
      assert.equal(atProvider.status, 302, 'провайдер → 302 на колбэк');
      return req(atProvider.headers.get('location'));
    },
  };
}

// WS-клиент: cookie уходят в заголовках handshake, как у браузера
async function wsClient(base, { devId = '', session = '', cookie = '', country = '', lang = 'ru' } = {}) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', {
    headers: { ...(cookie ? { cookie } : {}), ...(country ? { 'cf-ipcountry': country } : {}) },
  });
  const queue = [], waiters = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    const w = waiters.findIndex(x => x.t === m.t);
    if (w !== -1) waiters.splice(w, 1)[0].resolve(m);
    else queue.push(m);
  });
  const c = {
    ws,
    send: m => ws.send(JSON.stringify(m)),
    next: t => new Promise((resolve, reject) => {
      const i = queue.findIndex(x => x.t === t);
      if (i !== -1) return resolve(queue.splice(i, 1)[0]);
      waiters.push({ t, resolve });
      setTimeout(() => reject(new Error('timeout waiting ' + t)), 4000);
    }),
  };
  await once(ws, 'open');
  c.send({ t: 'auth', initData: '', devId, session, lang });
  return c;
}
const ready = async (...a) => {
  const c = await wsClient(...a);
  c.ready = await c.next('ready');
  return c;
};

// Два анонима из разных стран разговаривают: в паспорт первого попадает штамп страны второго
async function talk(base, a, b, { mine = 'DE', theirs = 'FR' } = {}) {
  const x = await ready(base, { devId: a, country: mine });
  const y = await ready(base, { devId: b, country: theirs });
  const xs = (await x.next('session')).token;
  await y.next('session');
  x.send({ t: 'find' });
  await x.next('waiting');
  y.send({ t: 'find' });
  await Promise.all([x.next('matched'), y.next('matched')]);
  x.ws.close();
  y.ws.close();
  return { xSession: xs };
}

// ---------- Реестр: Google включается только с ключами ----------

test('google в AUTH_PROVIDERS без client id/secret молча не включается', () => {
  assert.deepEqual(Object.keys(providersFrom({ AUTH_PROVIDERS: 'google' })), []);
  assert.deepEqual(Object.keys(providersFrom({ AUTH_PROVIDERS: 'google', GOOGLE_CLIENT_ID: 'x' })), []);
  const p = providersFrom({ AUTH_PROVIDERS: 'telegram,google', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' });
  assert.deepEqual(Object.keys(p).sort(), ['google', 'telegram']);
  assert.equal(p.google.kind, 'oidc');
  // Прод-конфигу хватает двух переменных: адреса Google зашиты
  assert.equal(p.google.authorizeUrl, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(p.google.tokenUrl, 'https://oauth2.googleapis.com/token');
  assert.equal(p.google.jwksUrl, 'https://www.googleapis.com/oauth2/v3/certs');
  assert.deepEqual(p.google.issuers, ['https://accounts.google.com', 'accounts.google.com']);
  assert.equal(p.google.scope, 'openid email profile');
});

// ---------- Запрос авторизации ----------

test('google: /auth/google/start уводит к Google с PKCE, nonce и нужными скоупами', async t => {
  const prov = await fakeGoogle();
  t.after(() => prov.srv.close());
  const base = await startServer(t, googleEnv(prov));
  const b = browser(base);

  const start = await b.req('/auth/google/start?return=/%3Fsrc%3Dtest');
  assert.equal(start.status, 302);
  assert.equal(start.headers.get('cache-control'), 'no-store', '/auth/* не кэшируется');
  const to = new URL(start.headers.get('location'));
  assert.equal(to.origin + to.pathname, prov.base + '/authorize');
  assert.equal(to.searchParams.get('response_type'), 'code');
  assert.equal(to.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(to.searchParams.get('redirect_uri'), `${base}/auth/google/callback`);
  assert.equal(to.searchParams.get('scope'), 'openid email profile');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(to.searchParams.get('code_challenge')?.length >= 43, 'есть code_challenge');
  assert.ok(to.searchParams.get('state')?.length >= 24, 'есть state');
  assert.ok(to.searchParams.get('nonce')?.length >= 16, 'есть nonce протокола OIDC');
  assert.equal(to.searchParams.get('prompt'), 'select_account');
  assert.equal(to.searchParams.get('access_type'), 'online');

  // Состояние лежит в подписанной cookie на /auth, недоступной скриптам
  const oauth = b.raws.find(r => r.startsWith('aura_oauth='));
  assert.match(oauth, /HttpOnly/);
  assert.match(oauth, /SameSite=Lax/);
  assert.match(oauth, /Path=\/auth/);
  // В адресе Google нет ни нашего состояния, ни секрета
  assert.ok(!start.headers.get('location').includes(CLIENT_SECRET));
});

// ---------- Живой вход ----------

test('google: вход даёт аккаунт с профилем из id_token, повторный вход — тот же аккаунт', async t => {
  const prov = await fakeGoogle();
  t.after(() => prov.srv.close());
  const base = await startServer(t, googleEnv(prov));

  const b = browser(base);
  const done = await b.login();
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/', 'возврат туда, откуда пришли');
  assert.ok(b.session(), 'cookie сессии выдана');
  const cookie = b.raws.find(r => r.startsWith('aura_session='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=2592000/);

  const me = await ready(base, { cookie: b.cookieHeader() });
  assert.equal(me.ready.account.authKind, 'google');
  assert.equal(me.ready.account.displayName, 'Гугл Один');
  assert.deepEqual(me.ready.account.logins.map(l => l.provider), ['google']);
  assert.equal(me.ready.account.logins[0].email, 'one@gmail.com');
  // Реферальная ссылка завязана на users.id — по ней и видно, тот же это аккаунт или новый
  const first = me.ready.me.refLink;
  assert.ok(first, 'профиль отдаёт реферальную ссылку');
  me.ws.close();

  // Второй вход в чистом браузере — тот же аккаунт, вторая привязка не создаётся
  const b2 = browser(base);
  assert.equal((await b2.login()).status, 302);
  const again = await ready(base, { cookie: b2.cookieHeader() });
  assert.equal(again.ready.me.refLink, first, 'повторный вход ведёт в тот же профиль');
  assert.equal(again.ready.account.logins.length, 1);
  again.ws.close();

  // Другой человек с другим sub — отдельный аккаунт
  prov.state.profile = { sub: 'google-2', email: 'two@gmail.com', email_verified: true, name: 'Гугл Два' };
  const b3 = browser(base);
  assert.equal((await b3.login()).status, 302);
  const other = await ready(base, { cookie: b3.cookieHeader() });
  assert.notEqual(other.ready.me.refLink, first, 'другой Google-аккаунт — другой профиль');
  assert.equal(other.ready.account.displayName, 'Гугл Два');
  other.ws.close();
});

test('google: привязка к анонимному профилю не теряет нажитое, в другом браузере тот же аккаунт', async t => {
  const prov = await fakeGoogle();
  t.after(() => prov.srv.close());
  const base = await startServer(t, googleEnv(prov));
  prov.state.profile = { sub: 'google-link', email: 'link@gmail.com', email_verified: true, name: 'Линк' };

  // Аноним поиграл: в паспорте появился штамп страны собеседника
  const { xSession: anon } = await talk(base, 'web-ganon001', 'web-gpeer001', { mine: 'DE', theirs: 'FR' });
  const before = await ready(base, { devId: 'web-ganon001', session: anon });
  assert.deepEqual(before.ready.me.passport, ['FR']);
  const anonId = before.ready.me.refLink;
  before.ws.close();

  const b = browser(base);
  assert.equal((await b.login('google', { anonSession: anon })).status, 302);
  const after = await ready(base, { devId: 'web-ganon001', cookie: b.cookieHeader() });
  assert.equal(after.ready.me.refLink, anonId, 'анонимный профиль апгрейднут, а не заменён');
  assert.deepEqual(after.ready.me.passport, ['FR'], 'паспорт на месте');
  assert.deepEqual(after.ready.account.logins.map(l => l.provider), ['google']);
  after.ws.close();

  // Другой браузер со своим анонимом и своим штампом: вход тем же Google → слияние без потерь
  const { xSession: anon2 } = await talk(base, 'web-ganon002', 'web-gpeer002', { mine: 'FR', theirs: 'DE' });
  const b2 = browser(base);
  assert.equal((await b2.login('google', { anonSession: anon2 })).status, 302);
  const merged = await ready(base, { devId: 'web-ganon002', cookie: b2.cookieHeader() });
  assert.equal(merged.ready.me.refLink, anonId, 'тот же аккаунт');
  assert.deepEqual(merged.ready.me.passport.sort(), ['DE', 'FR'], 'нажитое вторым анонимом добавилось');
  assert.deepEqual(merged.ready.account.logins.map(l => l.provider), ['google'], 'привязка одна');
  merged.ws.close();

  // Третий браузер вообще без анонима — тот же профиль
  const b3 = browser(base);
  assert.equal((await b3.login()).status, 302);
  const third = await ready(base, { cookie: b3.cookieHeader() });
  assert.equal(third.ready.me.refLink, anonId);
  assert.deepEqual(third.ready.me.passport.sort(), ['DE', 'FR']);
  third.ws.close();
});

// ---------- Честный экран при отказе и ошибке ----------

test('google: отказ в consent и ошибка провайдера различимы на экране входа', async t => {
  const prov = await fakeGoogle();
  t.after(() => prov.srv.close());
  const base = await startServer(t, googleEnv(prov));

  // Человек нажал «Отмена» у Google
  prov.state.deny = 'access_denied';
  const b = browser(base);
  const denied = await b.login();
  assert.equal(denied.headers.get('location'), '/?auth_error=provider_denied');
  assert.equal(b.session(), '', 'cookie не выдана');

  // Сам Google ответил ошибкой протокола — это уже не отказ человека
  prov.state.deny = 'server_error';
  const b2 = browser(base);
  assert.equal((await b2.login()).headers.get('location'), '/?auth_error=provider_error');

  // Эндпоинт токена лежит
  prov.state.deny = '';
  prov.state.tokenStatus = 503;
  const b3 = browser(base);
  const broken = await b3.login();
  assert.equal(broken.headers.get('location'), '/?auth_error=provider_error');
  assert.equal(b3.session(), '', 'cookie не выдана');

  // Провайдер поднялся — вход работает, состояние прошлых попыток не мешает
  prov.state.tokenStatus = 0;
  const b4 = browser(base);
  assert.equal((await b4.login()).headers.get('location'), '/');
  assert.ok(b4.session());
});

// ---------- id_token должен быть настоящим ----------

// Каждая проверка — один проход входа, а на /auth/*/start стоит rate limit 20 за 5 минут,
// поэтому случаи разложены по двум серверам: claims и подпись.
async function rejects(base, prov, cases) {
  for (const [what, patch] of cases) {
    prov.state.claims = {};
    prov.state.signWith = null;
    prov.state.signKid = 'k1';
    prov.state.publish = ['k1', 'k2'];
    Object.assign(prov.state, patch);
    const b = browser(base);
    const res = await b.login();
    assert.equal(res.headers.get('location'), '/?auth_error=provider_error', what + ': вход отклонён');
    assert.equal(b.session(), '', what + ': cookie не выдана');
  }
  // После подмен честный токен по-прежнему входит
  prov.state.claims = {};
  prov.state.signWith = null;
  prov.state.signKid = 'k1';
  prov.state.publish = ['k1', 'k2'];
  const ok = browser(base);
  assert.equal((await ok.login()).headers.get('location'), '/', 'честный токен входит');
  assert.ok(ok.session());
}

test('google: id_token с чужими claims не пускает в аккаунт', async t => {
  const prov = await fakeGoogle();
  t.after(() => prov.srv.close());
  const base = await startServer(t, googleEnv(prov));
  await rejects(base, prov, [
    ['чужой aud', { claims: { aud: 'other-client.apps.googleusercontent.com' } }],
    ['чужой iss', { claims: { iss: 'https://evil.example.com' } }],
    ['истёкший срок', { claims: { exp: Math.floor(Date.now() / 1000) - 600 } }],
    ['чужой nonce', { claims: { nonce: 'not-our-nonce' } }],
    ['пустой sub', { claims: { sub: '' } }],
  ]);
});

test('google: id_token, подписанный не ключом Google, не пускает в аккаунт', async t => {
  const prov = await fakeGoogle();
  t.after(() => prov.srv.close());
  const base = await startServer(t, googleEnv(prov));
  const alien = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await rejects(base, prov, [
    ['подпись чужим ключом', { signWith: alien }],
    ['azp другого клиента', { claims: { azp: 'other-client.apps.googleusercontent.com' } }],
  ]);
});

test('google: id_token с kid, которого нет в JWKS, не пускает в аккаунт', async t => {
  const prov = await fakeGoogle();
  t.after(() => prov.srv.close());
  // JWKS этого сервера с самого начала знает только k1 — иначе ключ попал бы в кэш законным входом
  prov.state.publish = ['k1'];
  prov.state.signKid = 'k2';
  const base = await startServer(t, googleEnv(prov));

  const b = browser(base);
  assert.equal((await b.login()).headers.get('location'), '/?auth_error=provider_error');
  assert.equal(b.session(), '', 'cookie не выдана');

  // Тот же сервер и тот же кэш: вход ключом из JWKS работает
  prov.state.signKid = 'k1';
  const ok = browser(base);
  assert.equal((await ok.login()).headers.get('location'), '/');
  assert.ok(ok.session());
});

test('verifyIdToken: alg none и HS256 на той же полезной нагрузке отклоняются', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const jwks = { get: async kid => (kid === 'k1' ? jwk : null) };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Date.now();
  const claims = { iss: ISSUER, aud: CLIENT_ID, sub: 'google-1', nonce: 'n1', exp: Math.floor(now / 1000) + 600, iat: Math.floor(now / 1000) };
  const opts = { jwks, audience: CLIENT_ID, issuers: [ISSUER], nonce: 'n1', now };

  const input = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64(claims)}`;
  const good = `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  assert.equal((await verifyIdToken(good, opts)).sub, 'google-1');

  const none = `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims)}.`;
  await assert.rejects(verifyIdToken(none, opts), /alg|jwt_parts/);

  // Классическая подмена: алгоритм меняют на симметричный и подписывают публичным ключом
  const hsInput = `${b64({ alg: 'HS256', kid: 'k1', typ: 'JWT' })}.${b64(claims)}`;
  const hs = `${hsInput}.${crypto.createHmac('sha256', JSON.stringify(jwk)).update(hsInput).digest('base64url')}`;
  await assert.rejects(verifyIdToken(hs, opts), /alg/);

  // Сдвинутая на один байт подпись
  const bad = good.slice(0, -4) + (good.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  await assert.rejects(verifyIdToken(bad, opts), /signature/);

  // Мусор вместо токена
  await assert.rejects(verifyIdToken('not-a-token', opts), /jwt_parts/);
  await assert.rejects(verifyIdToken('', opts), /jwt_size/);
});

test('JWKS: кэш по max-age, ротация ключа перечитывается не чаще раза в минуту', async () => {
  let clock = Date.now();
  const keys = { k1: { kid: 'k1', kty: 'RSA', n: 'aaa', e: 'AQAB', alg: 'RS256', use: 'sig' } };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      headers: { get: h => (h === 'cache-control' ? 'public, max-age=600' : null) },
      json: async () => ({ keys: Object.values(keys) }),
    };
  };
  const jwks = createJwks('https://example.test/certs', { fetchImpl, now: () => clock });

  assert.equal((await jwks.get('k1')).kid, 'k1');
  assert.equal(calls, 1);
  await jwks.get('k1');
  assert.equal(calls, 1, 'живой кэш не дёргает провайдера');

  // Google выкатил новый ключ: сразу не перечитываем (иначе мусорный токен — рычаг на их эндпоинт)
  keys.k2 = { kid: 'k2', kty: 'RSA', n: 'bbb', e: 'AQAB', alg: 'RS256', use: 'sig' };
  assert.equal(await jwks.get('k2'), null);
  assert.equal(calls, 1);

  // Через минуту — перечитываем и находим
  clock += 61_000;
  assert.equal((await jwks.get('k2')).kid, 'k2');
  assert.equal(calls, 2);

  // По истечении max-age кэш обновляется сам
  clock += 601_000;
  await jwks.get('k1');
  assert.equal(calls, 3);
});

// ---------- Интерфейс: знак Google, тексты на восьми языках, внутри мини-аппа кнопок нет ----------

test('интерфейс: знак Google вместо эмодзи, честные тексты отказа и ошибки на восьми языках', () => {
  const app = fs.readFileSync('public/app.js', 'utf8');
  const html = fs.readFileSync('public/index.html', 'utf8');

  // Официальный знак «G» на белом круге — не эмодзи
  assert.match(app, /PROVIDER_MARK = \{[\s\S]*google:/);
  assert.match(app, /#4285F4/);
  assert.ok(!/google: '🔎'/.test(app), 'эмодзи вместо знака Google не осталось');
  // Внутри Telegram Mini App кнопок соцсетей нет вовсе (Google и сам блокирует WebView)
  assert.match(app, /const off = isTg\(\) \|\| !account\.providers\.length/);
  assert.ok(!/telegram-widget[\s\S]*google/i.test(html), 'кнопка Google не зашита в разметку — она из /auth/providers');
  // Причины различимы на экране входа
  for (const code of ['provider_denied', 'provider_error', 'state_used']) assert.ok(app.includes(code), 'нет разбора ' + code);

  const i18n = loadI18n();
  const added = ['login_denied', 'login_provider', 'login_expired'];
  for (const lang of ['en', 'ru', 'uk', 'es', 'pt', 'de', 'tr', 'id']) {
    i18n.setLang(lang);
    for (const k of added) {
      assert.notEqual(i18n.t(k), k, `${lang}: нет перевода ${k}`);
      assert.ok(i18n.t(k).length > 5, `${lang}: пустой перевод ${k}`);
    }
    // «Войти через Google» собирается из того же ключа, что и остальные входы
    const label = i18n.t('login_via', { name: 'Google' });
    assert.match(label, /Google/);
    assert.ok(!label.includes('{name}'), `${lang}: подстановка имени провайдера не сработала`);
  }
});

// Словарь интерфейса в Node: подставляем минимальные браузерные объекты
function loadI18n() {
  const sandbox = {
    window: {},
    navigator: { languages: ['en'], language: 'en' },
    location: { search: '' },
    document: { documentElement: {}, querySelectorAll: () => [], title: '' },
  };
  new Function('window', 'navigator', 'location', 'document', fs.readFileSync('public/i18n.js', 'utf8'))(
    sandbox.window, sandbox.navigator, sandbox.location, sandbox.document);
  return sandbox.window.AuraI18n;
}
