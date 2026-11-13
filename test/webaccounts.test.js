// Ядро аккаунтов (HOM-39): identities, cookie-сессии, привязка, слияние, бан по identity,
// Telegram Login Widget и отсутствие регрессии телеграмного пути.
// Внешних сетей тесты не трогают: провайдер — локальный http-сервер (OAuth 2.0 + PKCE).
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
import { Db } from '../src/db.js';
import { validateLoginWidget } from '../src/auth.js';
import { providersFrom, parseCookies } from '../src/webauth.js';

const TOKEN = '123456:TEST-token';
const fresh = () => String(Math.floor(Date.now() / 1000));

// ---------- подпись Telegram Login Widget ----------
function signWidget(fields, token = TOKEN) {
  const params = new URLSearchParams(fields);
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHash('sha256').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params;
}

// ---------- тестовый провайдер входа: authorize → code → token → userinfo ----------
async function fakeProvider() {
  const codes = new Map();
  const state = { profile: { sub: 'fake-1', email: 'one@example.com', email_verified: true, name: 'Fake One', picture: 'https://example.com/a.png' } };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/authorize') {
      const code = 'code-' + crypto.randomBytes(6).toString('hex');
      codes.set(code, { challenge: url.searchParams.get('code_challenge'), profile: { ...state.profile } });
      const to = new URL(url.searchParams.get('redirect_uri'));
      to.searchParams.set('code', code);
      to.searchParams.set('state', url.searchParams.get('state') || '');
      res.writeHead(302, { location: to.href });
      return res.end();
    }
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', c => { body += c; });
      return req.on('end', () => {
        const p = new URLSearchParams(body);
        const rec = codes.get(p.get('code'));
        if (!rec) return send(400, { error: 'bad_code' });
        codes.delete(p.get('code')); // код одноразовый, как у настоящего провайдера
        const challenge = crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
        if (challenge !== rec.challenge) return send(400, { error: 'pkce' });
        const access = 'at-' + crypto.randomBytes(6).toString('hex');
        codes.set(access, rec);
        send(200, { access_token: access, token_type: 'Bearer' });
      });
    }
    if (url.pathname === '/userinfo') {
      const rec = codes.get(String(req.headers.authorization || '').replace('Bearer ', ''));
      return rec ? send(200, rec.profile) : send(401, { error: 'token' });
    }
    send(404, { error: 'nope' });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { srv, base, state };
}

async function startServer(t, extraEnv = {}) {
  const port = 19000 + Math.floor(Math.random() * 900);
  const srv = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(port), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'aura-auth-')),
      DEV_ALLOW_ANON: '0', WEB_ANON: '1', BOT_TOKEN: '', BOT_POLLING: '0', AUTH_COOKIE_INSECURE: '1',
      NODE_NO_WARNINGS: '1', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => srv.kill());
  await once(srv.stdout, 'data');
  return `http://127.0.0.1:${port}`;
}

// Браузер: своя банка cookie и запросы без автоматических редиректов
function browser(base) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  function absorb(res) {
    for (const raw of res.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (!v || /Max-Age=0/i.test(raw)) jar.delete(k); else jar.set(k, v);
    }
  }
  async function req(url, opts = {}) {
    const res = await fetch(url.startsWith('http') ? url : base + url, {
      redirect: 'manual',
      ...opts,
      headers: { ...(opts.headers || {}), ...(jar.size ? { cookie: cookieHeader() } : {}) },
    });
    absorb(res);
    return res;
  }
  return {
    jar, req, cookieHeader,
    session: () => jar.get('aura_session') || '',
    // Весь поход «кнопка входа → провайдер → колбэк», как его делает браузер
    async login(provider, { anonSession = '', returnTo = '/' } = {}) {
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

// WS-клиент: cookie уходят в заголовках handshake, как у настоящего браузера
async function wsClient(base, { devId = '', session = '', cookie = '', country = '', initData = '', lang = 'ru' } = {}) {
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
    closed: new Promise(resolve => ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }))),
    send: m => ws.send(JSON.stringify(m)),
    next: t => new Promise((resolve, reject) => {
      const i = queue.findIndex(x => x.t === t);
      if (i !== -1) return resolve(queue.splice(i, 1)[0]);
      waiters.push({ t, resolve });
      setTimeout(() => reject(new Error('timeout waiting ' + t)), 4000);
    }),
  };
  await once(ws, 'open');
  c.send({ t: 'auth', initData, devId, session, lang });
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
  const ys = (await y.next('session')).token;
  x.send({ t: 'find' });
  await x.next('waiting');
  y.send({ t: 'find' });
  await Promise.all([x.next('matched'), y.next('matched')]);
  x.ws.close();
  y.ws.close();
  return { xSession: xs, ySession: ys };
}

// ---------- Данные: привязки, слияние, удаление ----------

test('identities: привязка одна на (provider, provider_uid), повторный вход только обновляет профиль', () => {
  const db = new Db(':memory:');
  const a = db.upsertIdentity({ provider: 'fake', providerUid: 'u1', userId: 'web-aaaa', name: 'A', email: 'a@x.y' });
  assert.equal(a.isNew, true);
  const again = db.upsertIdentity({ provider: 'fake', providerUid: 'u1', userId: 'web-bbbb', name: 'A2', email: 'a2@x.y' });
  assert.equal(again.isNew, false);
  // Привязка не переезжает на другой аккаунт сама — иначе чужим входом можно было бы угнать профиль
  assert.equal(db.identity('fake', 'u1').user_id, 'web-aaaa');
  assert.equal(db.identity('fake', 'u1').name, 'A2');
  assert.equal(db.identitiesOf('web-aaaa').length, 1);
  assert.equal(db.hasIdentity('web-aaaa'), true);
  assert.equal(db.hasIdentity('web-bbbb'), false);
  // Разные провайдеры с одинаковым e-mail живут как отдельные привязки одного аккаунта
  db.upsertIdentity({ provider: 'other', providerUid: 'u1', userId: 'web-aaaa', email: 'a@x.y', emailVerified: true });
  assert.equal(db.identitiesOf('web-aaaa').length, 2);
});

test('слияние: нажитое переносится, профиль гасится в merged_into, операция идемпотентна', () => {
  const db = new Db(':memory:');
  const now = Date.now();
  db.user('web-anon', now);
  db.user('web-acct', now);
  db.user('friend-1', now);
  // У анонима: карма, бонус ауры, премиум, друг, штамп, комплимент, серия
  db.rate('rater-1', 'web-anon', 1, now);
  db.addAuraBonus('web-anon', 30);
  db.grantPremium('web-anon', 10, now);
  db.addFriends('web-anon', 'friend-1', now);
  db.stamp('web-anon', 'DE', now);
  db.compliment('friend-1', 'web-anon', 'smile', now);
  db.addSalutes('web-anon', 5);
  // У аккаунта: свой штамп и премиум на день
  db.stamp('web-acct', 'FR', now);
  db.grantPremium('web-acct', 1, now);

  const anonBefore = db.user('web-anon');
  const out = db.mergeAccounts('web-anon', 'web-acct', now);
  assert.deepEqual(out, { merged: true, into: 'web-acct' });

  const acct = db.user('web-acct');
  assert.equal(acct.karma_up, anonBefore.karma_up, 'карма суммируется');
  assert.equal(acct.aura_bonus, 30, 'бонус ауры переносится');
  assert.equal(acct.salutes, 5);
  assert.equal(acct.premium_until, anonBefore.premium_until, 'Premium — максимум из двух');
  assert.deepEqual(db.passport('web-acct').sort(), ['DE', 'FR'], 'паспорта объединяются');
  assert.equal(db.isFriend('web-acct', 'friend-1'), true, 'друзья переносятся');
  assert.equal(db.isFriend('friend-1', 'web-acct'), true, 'и в обратную сторону');
  assert.equal(db.isFriend('web-anon', 'friend-1'), false, 'у слитого профиля друзей не остаётся');
  assert.equal(db.complimentsOf('web-acct').smile, 1, 'комплименты следуют за аккаунтом');
  assert.equal(db.accountRoot('web-anon'), 'web-acct');
  assert.equal(db.isMerged('web-anon'), true);
  assert.equal(db.user('web-anon').premium_until, 0, 'слитый профиль пустой');

  // Повторный вызов ничего не меняет и не удваивает ауру
  const twice = db.mergeAccounts('web-anon', 'web-acct', now);
  assert.equal(twice.merged, false);
  assert.equal(db.user('web-acct').aura_bonus, 30);
  assert.equal(db.mergeAccounts('web-acct', 'web-acct', now).merged, false);
  // Цепочка слияний разворачивается до настоящего аккаунта
  db.user('web-third', now);
  db.mergeAccounts('web-acct', 'web-third', now);
  assert.equal(db.accountRoot('web-anon'), 'web-third');
  assert.equal(db.mergeAccounts('web-anon', 'web-third', now).merged, false);
});

test('слияние: бан не смывается входом в соцсеть — срок берётся максимальный', () => {
  const db = new Db(':memory:');
  const now = Date.now();
  db.ban('web-bad', 7 * 24 * 3600 * 1000, 'reports', now);
  db.user('web-clean', now);
  db.mergeAccounts('web-bad', 'web-clean', now);
  assert.ok(db.bannedUntil('web-clean', now) > now, 'бан анонима переходит на аккаунт');
  assert.equal(db.user('web-clean').ban_reason, 'reports');
});

test('удаление аккаунта: личные данные уходят, события остаются обезличенными', () => {
  const db = new Db(':memory:');
  const now = Date.now();
  db.user('web-del', now);
  db.upsertIdentity({ provider: 'fake', providerUid: 'u9', userId: 'web-del' }, now);
  db.addFriends('web-del', 'friend-9', now);
  db.stamp('web-del', 'DE', now);
  db.event('session', 'web-del', 0, '', now);
  assert.equal(db.deleteAccount('web-del', now), true);
  assert.equal(db.exists('web-del'), false);
  assert.equal(db.identity('fake', 'u9'), null);
  assert.equal(db.isFriend('friend-9', 'web-del'), false);
  assert.deepEqual(db.passport('web-del'), []);
  assert.equal(db.deleteAccount('web-del', now), false, 'повторное удаление безопасно');
});

// ---------- Подпись Telegram Login Widget ----------

test('Telegram Login Widget: своя подпись принимается, подделка и протухшая дата — нет', () => {
  const ok = validateLoginWidget(signWidget({ id: '777', auth_date: fresh(), first_name: 'Ivan', username: 'ivan' }), TOKEN);
  assert.equal(ok.id, '777');
  assert.equal(ok.name, 'Ivan');
  assert.equal(ok.username, 'ivan');
  // Подпись мини-аппа (initData) не подходит для виджета и наоборот: секрет считается иначе
  const tampered = signWidget({ id: '777', auth_date: fresh(), first_name: 'Ivan' });
  tampered.set('id', '778');
  assert.equal(validateLoginWidget(tampered, TOKEN), null);
  assert.equal(validateLoginWidget(signWidget({ id: '777', auth_date: fresh() }), 'other:token'), null);
  const old = signWidget({ id: '777', auth_date: String(Math.floor(Date.now() / 1000) - 2 * 24 * 3600) });
  assert.equal(validateLoginWidget(old, TOKEN), null);
  assert.equal(validateLoginWidget(new URLSearchParams({ id: '777', auth_date: fresh() }), TOKEN), null, 'без hash — отказ');
});

test('флаг AUTH_PROVIDERS: пусто — провайдеров нет, неизвестный провайдер игнорируется', () => {
  assert.deepEqual(providersFrom({}), {});
  assert.deepEqual(Object.keys(providersFrom({ AUTH_PROVIDERS: 'telegram' })), ['telegram']);
  assert.deepEqual(Object.keys(providersFrom({ AUTH_PROVIDERS: 'telegram,google' })), ['telegram'], 'Google — задача E3');
  assert.deepEqual(Object.keys(providersFrom({ AUTH_PROVIDERS: 'fake' })), [], 'тестовый провайдер без эндпоинта не включается');
  assert.deepEqual(parseCookies('a=1; aura_session=x.y.z'), { a: '1', aura_session: 'x.y.z' });
});

// ---------- Вход на сайте целиком ----------

test('пустой AUTH_PROVIDERS = сегодняшнее поведение: /auth/* молчит, анонимный вход работает', async t => {
  const base = await startServer(t);
  for (const p of ['/auth/providers', '/auth/telegram/callback', '/auth/fake/start']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
  const a = await ready(base, { devId: 'web-flagoff1' });
  assert.equal(a.ready.account.providers.length, 0, 'кнопок входа в интерфейсе нет');
  assert.equal(a.ready.me.aura, 100);
  assert.equal((await a.next('session')).token.startsWith('web-flagoff1.'), true, 'сессия выдаётся как раньше');
  a.ws.close();
});

test('аноним → вход → профиль сохранился → другой браузер по cookie → тот же аккаунт', async t => {
  const prov = await fakeProvider();
  t.after(() => prov.srv.close());
  const base = await startServer(t, {
    AUTH_PROVIDERS: 'fake',
    AUTH_FAKE_AUTHORIZE_URL: prov.base + '/authorize',
    AUTH_FAKE_TOKEN_URL: prov.base + '/token',
    AUTH_FAKE_USERINFO_URL: prov.base + '/userinfo',
  });

  // Поиграл анонимно: разговор с человеком из Франции → штамп FR
  const { xSession: anonSession } = await talk(base, 'web-anon0001', 'web-peer0001');

  const b1 = browser(base);
  const cb = await b1.login('fake', { anonSession, returnTo: '/?src=test' });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/?src=test', 'возврат туда, откуда вошли');
  assert.ok(b1.session(), 'cookie aura_session выдана');

  // Экран аккаунта: виден привязанный вход
  const info = await (await b1.req('/auth/providers')).json();
  assert.equal(info.session, true);
  assert.deepEqual(info.logins.map(l => l.provider), ['fake']);

  // Тот же браузер: аккаунт — это апгрейд анонима, аура/паспорт/друзья на месте
  const after = await ready(base, { devId: 'web-anon0001', cookie: b1.cookieHeader() });
  assert.deepEqual(after.ready.me.passport, ['FR'], 'паспорт сохранился');
  assert.equal(after.ready.account.authKind, 'fake');
  assert.equal(after.ready.account.displayName, 'Fake One');
  assert.deepEqual(after.ready.account.logins.map(l => l.provider), ['fake']);
  after.ws.close();

  // Другой браузер: свой аноним со своим штампом DE, затем вход тем же провайдером → слияние
  const { xSession: anon2 } = await talk(base, 'web-anon0002', 'web-peer0002', { mine: 'FR', theirs: 'DE' });
  const b2 = browser(base);
  assert.equal((await b2.login('fake', { anonSession: anon2 })).status, 302);
  const merged = await ready(base, { devId: 'web-anon0002', cookie: b2.cookieHeader() });
  assert.deepEqual(merged.ready.me.passport.sort(), ['DE', 'FR'], 'нажитое анонимом добавилось к аккаунту');
  assert.deepEqual(merged.ready.account.logins.map(l => l.provider), ['fake'], 'привязка одна, аккаунт один');
  merged.ws.close();

  // Третий браузер, вообще без анонима: тот же профиль
  const b3 = browser(base);
  assert.equal((await b3.login('fake')).status, 302);
  const third = await ready(base, { cookie: b3.cookieHeader() });
  assert.deepEqual(third.ready.me.passport.sort(), ['DE', 'FR'], 'тот же аккаунт из чистого браузера');
  third.ws.close();

  // Слитый анонимный id больше не пускает в аккаунт без сессии (чистка localStorage не помогает)
  const impostor = await ready(base, { devId: 'web-anon0002' });
  assert.deepEqual(impostor.ready.me.passport, [], 'подставленный id даёт чистый анонимный профиль');
  impostor.ws.close();
});

test('вход: state одноразовый, чужой state и колбэк без state отклоняются', async t => {
  const prov = await fakeProvider();
  t.after(() => prov.srv.close());
  const base = await startServer(t, {
    AUTH_PROVIDERS: 'fake',
    AUTH_FAKE_AUTHORIZE_URL: prov.base + '/authorize',
    AUTH_FAKE_TOKEN_URL: prov.base + '/token',
    AUTH_FAKE_USERINFO_URL: prov.base + '/userinfo',
  });
  const b = browser(base);
  const start = await b.req('/auth/fake/start?return=/');
  const atProvider = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const callback = atProvider.headers.get('location');

  // Колбэк без cookie состояния — отказ
  const naked = await fetch(callback, { redirect: 'manual' });
  assert.equal(naked.headers.get('location'), '/?auth_error=state');

  // Подменённый state — отказ
  const wrong = new URL(callback);
  wrong.searchParams.set('state', 'x'.repeat(32));
  assert.equal((await b.req(wrong.href)).headers.get('location'), '/?auth_error=state');

  // Правильный вход, затем повторное использование той же ссылки колбэка
  const b2 = browser(base);
  const s2 = await b2.req('/auth/fake/start?return=/');
  const p2 = await fetch(s2.headers.get('location'), { redirect: 'manual' });
  const once2 = await b2.req(p2.headers.get('location'));
  assert.equal(once2.headers.get('location'), '/');
  const replay = await b2.req(p2.headers.get('location'));
  assert.ok(String(replay.headers.get('location')).startsWith('/?auth_error='), 'повтор колбэка не входит');
});

test('бан по identity: повторный вход тем же provider_uid не даёт ни входа, ни слияния', async t => {
  const prov = await fakeProvider();
  t.after(() => prov.srv.close());
  const base = await startServer(t, {
    AUTH_PROVIDERS: 'fake', REPORTS_TO_BAN: '1',
    AUTH_FAKE_AUTHORIZE_URL: prov.base + '/authorize',
    AUTH_FAKE_TOKEN_URL: prov.base + '/token',
    AUTH_FAKE_USERINFO_URL: prov.base + '/userinfo',
  });
  prov.state.profile = { sub: 'fake-ban', email: 'ban@example.com', name: 'Banned One' };

  // Входим, получаем аккаунт, ловим бан по жалобе
  const b = browser(base);
  assert.equal((await b.login('fake')).status, 302);
  const me = await ready(base, { cookie: b.cookieHeader() });
  const other = await ready(base, { devId: 'web-reporter1', lang: 'en' });
  me.send({ t: 'find' });
  await me.next('waiting');
  other.send({ t: 'find' });
  await Promise.all([me.next('matched'), other.next('matched')]);
  other.send({ t: 'report', reason: 'spam' });
  await other.next('reported');
  assert.equal((await me.next('banned')).until > Date.now(), true);
  other.ws.close();

  // Чистый браузер, свежий аноним, вход тем же provider_uid — отказ, аноним не слит
  const { xSession: anonSession } = await talk(base, 'web-anon0003', 'web-peer0003');
  const b2 = browser(base);
  const denied = await b2.login('fake', { anonSession });
  assert.equal(denied.headers.get('location'), '/?auth_error=banned');
  assert.equal(b2.session(), '', 'cookie не выдана');
  const anon = await ready(base, { devId: 'web-anon0003', session: anonSession });
  assert.deepEqual(anon.ready.me.passport, ['FR'], 'анонимный профиль цел и не забанен');
  anon.ws.close();
});

test('Telegram Login Widget: веб-вход попадает в профиль того же Telegram ID, аноним сливается', async t => {
  const base = await startServer(t, { AUTH_PROVIDERS: 'telegram', BOT_TOKEN: TOKEN, BOT_USERNAME: 'you_aura_bot' });

  // Этот человек уже играл в мини-аппе: аккаунт с Telegram ID и штампом в паспорте
  const tgInit = signInitData({ auth_date: fresh(), user: JSON.stringify({ id: 555001, first_name: 'Tg', language_code: 'ru' }) });
  const inApp = await ready(base, { initData: tgInit, country: 'DE' });
  const peer = await ready(base, { devId: 'web-peer0004', country: 'FR' });
  inApp.send({ t: 'find' });
  await inApp.next('waiting');
  peer.send({ t: 'find' });
  await Promise.all([inApp.next('matched'), peer.next('matched')]);
  inApp.ws.close();
  peer.ws.close();

  // В браузере он сначала анонимен, потом входит через Telegram Login Widget
  const { xSession: anonSession } = await talk(base, 'web-anon0004', 'web-peer0005', { mine: 'FR', theirs: 'DE' });
  const b = browser(base);
  const fields = signWidget({ id: '555001', auth_date: fresh(), first_name: 'Tg', username: 'tg_one', photo_url: 'https://example.com/p.jpg' });
  fields.set('anon_session', anonSession);
  const res = await b.req('/auth/telegram/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: fields.toString(),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, merged: true, next: '/' });
  assert.ok(b.session().startsWith('555001.'), 'сессия выдана на тот же users.id, что в мини-аппе');

  const web = await ready(base, { cookie: b.cookieHeader() });
  assert.deepEqual(web.ready.me.passport.sort(), ['DE', 'FR'], 'профиль из мини-аппа плюс нажитое анонимом');
  assert.deepEqual(web.ready.account.logins.map(l => l.provider), ['telegram']);
  web.ws.close();

  // Телеграмный путь не изменился: initData по-прежнему ведёт в тот же аккаунт
  const again = await ready(base, { initData: tgInit });
  assert.deepEqual(again.ready.me.passport.sort(), ['DE', 'FR']);
  assert.equal(again.ready.account.authKind, 'telegram');
  again.ws.close();

  // Подделанная подпись виджета не пускает
  const bad = signWidget({ id: '555002', auth_date: fresh(), first_name: 'Fake' }, 'other:token');
  const badRes = await b.req('/auth/telegram/callback', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: bad.toString(),
  });
  assert.equal(badRes.status, 401);
});

test('привязка второго входа, выход и удаление аккаунта', async t => {
  const prov = await fakeProvider();
  t.after(() => prov.srv.close());
  const base = await startServer(t, {
    AUTH_PROVIDERS: 'telegram,fake', BOT_TOKEN: TOKEN,
    AUTH_FAKE_AUTHORIZE_URL: prov.base + '/authorize',
    AUTH_FAKE_TOKEN_URL: prov.base + '/token',
    AUTH_FAKE_USERINFO_URL: prov.base + '/userinfo',
  });
  prov.state.profile = { sub: 'fake-link', email: 'link@example.com', name: 'Link One' };

  // Вход через Telegram, затем привязка второго провайдера из активной сессии
  const b = browser(base);
  const fields = signWidget({ id: '555100', auth_date: fresh(), first_name: 'Tg' });
  await b.req('/auth/telegram/callback', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: fields.toString(),
  });
  const link = await b.req('/auth/link/fake', { method: 'POST' });
  assert.equal(link.status, 200);
  const { url } = await link.json();
  const start = await b.req(url);
  const atProvider = await fetch(start.headers.get('location'), { redirect: 'manual' });
  assert.equal((await b.req(atProvider.headers.get('location'))).status, 302);
  assert.ok(b.session().startsWith('555100.'), 'аккаунт тот же, новая сессия на него же');

  const info = await (await b.req('/auth/providers')).json();
  assert.deepEqual(info.logins.map(l => l.provider).sort(), ['fake', 'telegram'], 'два входа в один аккаунт');

  // Привязка без сессии невозможна
  assert.equal((await fetch(base + '/auth/link/fake', { method: 'POST' })).status, 401);

  // Повторный вход через второй провайдер из чистого браузера ведёт в тот же аккаунт
  const b2 = browser(base);
  assert.equal((await b2.login('fake')).status, 302);
  assert.ok(b2.session().startsWith('555100.'));

  // Выход гасит cookie, аккаунт остаётся
  assert.equal((await b.req('/auth/logout', { method: 'POST' })).status, 200);
  assert.equal(b.session(), '');
  assert.equal((await (await b.req('/auth/providers')).json()).session, false);

  // Удаление аккаунта: нужна сессия, после — профиль и привязки стёрты
  assert.equal((await b.req('/auth/delete', { method: 'POST' })).status, 401);
  assert.equal((await b2.req('/auth/delete', { method: 'POST' })).status, 200);
  const after = await (await b2.req('/auth/providers')).json();
  assert.equal(after.session, false);
  const b3 = browser(base);
  assert.equal((await b3.login('fake')).status, 302);
  const fresh3 = await ready(base, { cookie: b3.cookieHeader() });
  assert.equal(fresh3.ready.me.passport.length, 0, 'после удаления вход создаёт чистый профиль');
  assert.ok(!fresh3.ready.account.logins.some(l => l.provider === 'telegram'), 'старые привязки не вернулись');
  fresh3.ws.close();
});

// ---------- Интерфейс входа: разметка и переводы ----------

test('интерфейс входа: нужные id в разметке и ключи i18n на всех восьми языках', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const app = fs.readFileSync('public/app.js', 'utf8');
  // Экран входа в онбординге, «Сохранить профиль» в настройках, экран аккаунта
  for (const id of ['login-onboard', 'login-onboard-btns', 'login-onboard-tg', 'account-open', 'account-open-text',
    'sheet-account', 'account-logins', 'account-add', 'account-add-btns', 'account-add-tg', 'account-actions',
    'logout-btn', 'delete-btn']) {
    assert.ok(html.includes(`id="${id}"`), 'в index.html нет id ' + id);
    assert.ok(app.includes(`'${id}'`), 'app.js не использует id ' + id);
  }
  // Внутри Telegram соцкнопок быть не должно (план §4.4) — проверяем само условие
  assert.match(app, /const off = isTg\(\) \|\| !account\.providers\.length/);

  // Словарь грузим как в браузере: это обычный IIFE на window
  const i18n = loadI18n();
  const keys = [...new Set([...html.matchAll(/data-i(?:h|ph|a)?="([\w.]+)"/g)].map(m => m[1]))];
  const added = ['save_profile', 'save_profile_sub', 'account', 'account_sub', 'account_logins', 'account_add',
    'account_none', 'login_via', 'logout', 'delete_account', 'delete_sub', 'delete_confirm', 'logged_in',
    'login_fail', 'login_banned', 'login_taken'];
  for (const lang of ['en', 'ru', 'uk', 'es', 'pt', 'de', 'tr', 'id']) {
    i18n.setLang(lang);
    for (const k of keys) assert.ok(i18n.t(k).length > 0, `${lang}: пустой перевод ${k}`);
    for (const k of added) assert.notEqual(i18n.t(k), k, `${lang}: нет перевода ${k}`);
    assert.match(i18n.t('login_via', { name: 'Telegram' }), /Telegram/);
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

// Подпись initData мини-аппа — та же функция, что в core.test.js
function signInitData(fields, token = TOKEN) {
  const params = new URLSearchParams(fields);
  const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}
