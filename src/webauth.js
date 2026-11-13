// Вход на сайте: cookie-сессия, внешние провайдеры, привязка и слияние профилей (HOM-39, план HOM-35 §4).
//
// Принципы:
// - вход необязателен: при пустом AUTH_PROVIDERS весь модуль молчит (404) и поведение прода не меняется;
// - cookie aura_session несёт тот же HMAC-токен, что уже умеет checkSession — старые сессии живы;
// - state+PKCE лежат в подписанной cookie aura_oauth: TTL 10 минут, одноразовая;
// - провайдер добавляется одной записью в PROVIDERS (Google/Yandex/VK/e-mail — задачи E3–E5);
// - привязка никогда не переносит identity на другой аккаунт: это делает только явное слияние.
import crypto from 'node:crypto';
import { validateLoginWidget } from './auth.js';
import { createJwks, verifyIdToken } from './oidc.js';

const MIN = 60 * 1000;
const OAUTH_TTL_MS = 10 * MIN;
const SESSION_DAYS = 30;
const FETCH_TIMEOUT_MS = 8000;

// Реестр провайдеров. kind:
//   telegram — Login Widget (подпись ботом, без редиректов);
//   oauth2   — authorization code + PKCE + профиль отдельным запросом (Yandex, VK, тестовый fake);
//   oidc     — authorization code + PKCE, профиль берётся из проверенного id_token (Google).
export function providersFrom(env = {}) {
  const enabled = String(env.AUTH_PROVIDERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const out = {};
  for (const name of enabled) {
    if (name === 'telegram') { out.telegram = { name, kind: 'telegram' }; continue; }
    // Google (HOM-40): OIDC. Без client id/secret провайдер молча не включается — лучше, чем битый редирект.
    // Эндпоинты переопределяются только для тестов, в прод-конфиге их указывать не нужно.
    if (name === 'google' && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
      out.google = {
        name, kind: 'oidc',
        authorizeUrl: env.AUTH_GOOGLE_AUTHORIZE_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: env.AUTH_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
        jwksUrl: env.AUTH_GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs',
        issuers: env.AUTH_GOOGLE_ISSUER ? [env.AUTH_GOOGLE_ISSUER] : ['https://accounts.google.com', 'accounts.google.com'],
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: 'openid email profile',
        // select_account — чтобы на общем компьютере человек видел, каким аккаунтом входит;
        // offline-доступ нам не нужен: refresh-токены мы не храним
        authParams: { access_type: 'online', prompt: 'select_account' },
      };
      continue;
    }
    // Тестовый провайдер: только когда явно задан эндпоинт (локальный http-сервер в тестах)
    if (name === 'fake' && env.AUTH_FAKE_AUTHORIZE_URL) {
      out.fake = {
        name, kind: 'oauth2',
        authorizeUrl: env.AUTH_FAKE_AUTHORIZE_URL,
        tokenUrl: env.AUTH_FAKE_TOKEN_URL || '',
        userinfoUrl: env.AUTH_FAKE_USERINFO_URL || '',
        clientId: env.AUTH_FAKE_CLIENT_ID || 'aura-test',
        clientSecret: env.AUTH_FAKE_CLIENT_SECRET || 'secret',
        scope: env.AUTH_FAKE_SCOPE || 'openid email profile',
      };
      continue;
    }
    // Провайдер назван во флаге, но его ветка ещё не реализована — честно молчим вместо битого редиректа
  }
  return out;
}

const b64url = buf => Buffer.from(buf).toString('base64url');
const randomId = (n = 32) => crypto.randomBytes(n).toString('base64url');
const s256 = v => b64url(crypto.createHash('sha256').update(v).digest());

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!out[k]) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); } }
  }
  return out;
}

export function createWebAuth({ db, cfg, env = process.env, makeSession, checkSession, onAccountGone = () => {} }) {
  const providers = providersFrom(env);
  const enabled = Object.keys(providers).length > 0;
  const secure = env.AUTH_COOKIE_INSECURE !== '1';
  const cookieKey = crypto.createHash('sha256').update('aura-oauth:' + (cfg.botToken || '') + (env.SESSION_SALT || '')).digest();
  const usedStates = new Map(); // одноразовость state: nonce -> срок
  const hits = new Map();       // rate limit: «шаг входа + ip» -> { n, reset }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of usedStates) if (v < now) usedStates.delete(k);
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, MIN).unref();

  const ipOf = req => String(req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || '');
  // Счётчик — на каждый шаг входа отдельно: один общий на ip съедал бы бюджет вдвое быстрее
  // (старт + колбэк = два запроса одного входа), а за одним ip сидит целый оператор мобильной связи.
  function rateOk(req, bucket, limit, windowMs) {
    const key = bucket + ':' + ipOf(req);
    const now = Date.now();
    const h = hits.get(key);
    if (h && now < h.reset) {
      h.n += 1;
      return h.n <= limit;
    }
    hits.set(key, { n: 1, reset: now + windowMs });
    if (hits.size > 50_000) hits.clear();
    return true;
  }

  // ---------- cookies ----------
  function putCookie(res, name, value, { maxAgeSec, path = '/' } = {}) {
    const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
    if (secure) parts.push('Secure');
    parts.push(`Max-Age=${maxAgeSec}`);
    const prev = res.getHeader('Set-Cookie');
    const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
    res.setHeader('Set-Cookie', [...list, parts.join('; ')]);
  }
  const dropCookie = (res, name, path = '/') => putCookie(res, name, '', { maxAgeSec: 0, path });
  const sessionCookie = (res, token) => putCookie(res, 'aura_session', token, { maxAgeSec: SESSION_DAYS * 24 * 60 * 60 });

  function sign(payload) {
    const body = b64url(JSON.stringify(payload));
    return `${body}.${crypto.createHmac('sha256', cookieKey).update(body).digest('base64url')}`;
  }
  function unsign(token) {
    const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(String(token || ''));
    if (!m) return null;
    const want = crypto.createHmac('sha256', cookieKey).update(m[1]).digest('base64url');
    if (want.length !== m[2].length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[2]))) return null;
    try { return JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return null; }
  }

  function userFromToken(token) {
    const id = checkSession(token);
    if (!id) return null;
    const root = db.accountRoot(id);
    return db.exists(root) ? root : null;
  }
  // Пользователь текущей cookie-сессии (с разворотом слияния), либо null
  const sessionUser = req => userFromToken(parseCookies(req.headers.cookie).aura_session);
  // Анонимный профиль из браузера: он живёт в localStorage, поэтому клиент передаёт его токен
  // сессии в запрос входа. Просто «id анонима» не принимаем — иначе чужой профиль можно было бы
  // затянуть в своё слияние. Токен — та же подпись, что уже проверяет checkSession.
  const claimedAnon = params => userFromToken(params.get('anon_session'));

  // ---------- ответы ----------
  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  function redirect(res, to) {
    res.writeHead(302, { location: to, 'cache-control': 'no-store' });
    res.end();
  }
  // Ошибку возвращаем туда, откуда пришли: экран входа покажет честный текст по ?auth_error=
  function fail(res, returnTo, code, status = 400) {
    db.event('web_login_fail', '', 0, String(code).slice(0, 40));
    if (!returnTo) return json(res, status, { error: code });
    const sep = returnTo.includes('?') ? '&' : '?';
    return redirect(res, `${returnTo}${sep}auth_error=${encodeURIComponent(code)}`);
  }

  // Только свой сайт: относительный путь либо абсолютный адрес с нашего PUBLIC_URL (allowlist §4.4)
  function safeReturn(raw) {
    const v = String(raw || '').trim();
    if (!v) return '/';
    if (v.startsWith('/') && !v.startsWith('//')) return v.slice(0, 300);
    const base = cfg.publicUrl || '';
    if (base && v.startsWith(base + '/')) return v.slice(0, 300);
    if (base && v === base) return '/';
    return '/';
  }

  async function readBody(req, limit = 4000) {
    let body = '';
    for await (const c of req) {
      body += c;
      if (body.length > limit) throw new Error('big');
    }
    return body;
  }
  async function readFields(req, url) {
    if (req.method !== 'POST') return new URLSearchParams(url.search);
    const raw = await readBody(req);
    const type = String(req.headers['content-type'] || '');
    if (type.includes('application/json')) {
      const obj = JSON.parse(raw || '{}');
      return new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v ?? '')]));
    }
    return new URLSearchParams(raw);
  }

  // ---------- вход, привязка, слияние (план §4.3) ----------
  // anonId   — профиль, который открыт в браузере сейчас (cookie-сессия или присланный анонимный id)
  // linkTo   — явная привязка к активному аккаунту
  // fixedId  — провайдер диктует users.id (Telegram: id в вебе и в мини-аппе должен быть один)
  function completeLogin({ provider, profile, anonId = null, linkTo = null, fixedId = null }, now = Date.now()) {
    const ident = db.identity(provider, profile.uid);
    const anon = anonId && db.exists(anonId) && !db.isMerged(anonId) ? db.accountRoot(anonId) : null;

    if (linkTo) {
      if (ident && db.accountRoot(ident.user_id) !== linkTo) return { error: 'linked_elsewhere' };
      if (fixedId && fixedId !== linkTo && db.exists(fixedId)) return { error: 'linked_elsewhere' };
    }

    // Куда войдём: известная привязка → её аккаунт; Telegram → свой id; иначе апгрейд анонима или новый профиль
    const target = linkTo
      || (ident ? db.accountRoot(ident.user_id) : null)
      || fixedId
      || (anon && !db.hasIdentity(anon) ? anon : 'web-' + crypto.randomUUID().slice(0, 10));

    // Бан распространяется на все identity аккаунта и на повторный вход тем же provider_uid (§4.4).
    // Проверяем до слияния, чтобы забаненный не затягивал в бан свежий анонимный профиль.
    const banned = db.exists(target) ? db.bannedUntil(target, now) : 0;
    if (banned) return { error: 'banned', until: banned };

    db.user(target, now);
    let merged = null;
    // Анонимный профиль апгрейдится, а не создаётся заново; два полноценных аккаунта молча не сливаем
    if (anon && anon !== target && !db.hasIdentity(anon)) merged = db.mergeAccounts(anon, target, now);

    const up = db.upsertIdentity({
      provider, providerUid: profile.uid, userId: target,
      email: profile.email || '', emailVerified: Boolean(profile.emailVerified),
      name: profile.name || '', avatar: profile.avatar || '',
    }, now);
    db.setWebProfile(target, { name: profile.name, avatar: profile.avatar });
    db.setAuthKind(target, provider);
    db.event(up.isNew && (linkTo || db.identitiesOf(target).length > 1) ? 'account_link' : 'web_login_ok', target, 0, provider, now);
    return { userId: target, merged: merged?.merged ? merged.into : null, linked: up.isNew };
  }

  // ---------- OAuth 2.0 + PKCE ----------
  async function exchange(p, code, verifier, redirectUri) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: redirectUri,
    });
    const r = await fetch(p.tokenUrl, {
      method: 'POST', body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error('token_' + r.status);
    return r.json();
  }
  // ---------- OIDC: профиль из id_token (Google, §4.2) ----------
  const jwksByProvider = new Map();
  const jwksFor = p => {
    if (!jwksByProvider.has(p.name)) jwksByProvider.set(p.name, createJwks(p.jwksUrl));
    return jwksByProvider.get(p.name);
  };
  // При скоупах openid email profile Google отдаёт e-mail, имя и аватар прямо в id_token —
  // отдельный запрос к userinfo не нужен, а подписанный токен надёжнее ответа по Bearer.
  function profileFrom(claims) {
    return {
      uid: String(claims.sub),
      email: String(claims.email || '').toLowerCase().slice(0, 190),
      // Автосвязка разных провайдеров по e-mail запрещена и при verified=1 (§4.3) — флаг только для профиля
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      name: String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || '').slice(0, 64),
      avatar: String(claims.picture || '').slice(0, 300),
    };
  }

  async function userinfo(p, token) {
    const r = await fetch(p.userinfoUrl, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error('userinfo_' + r.status);
    const u = await r.json();
    const uid = String(u.sub ?? u.id ?? u.user_id ?? '');
    if (!uid) throw new Error('no_uid');
    return {
      uid,
      email: String(u.email || u.default_email || '').toLowerCase().slice(0, 190),
      // Автосвязка разных провайдеров по e-mail запрещена и при verified=1 (§4.3) — флаг только для профиля
      emailVerified: u.email_verified === true || u.email_verified === 1,
      name: String(u.name || u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || '').slice(0, 64),
      avatar: String(u.picture || u.avatar || u.photo_url || '').slice(0, 300),
    };
  }

  const callbackUrl = (req, provider) => `${cfg.publicUrl || `http://${req.headers.host}`}/auth/${provider}/callback`;
  const redirectKind = p => p && (p.kind === 'oauth2' || p.kind === 'oidc');

  function onStart(req, res, url, provider) {
    const p = providers[provider];
    if (!redirectKind(p)) return json(res, 404, { error: 'provider' });
    if (!rateOk(req, 'start', 20, 5 * MIN)) return json(res, 429, { error: 'rate' });
    const returnTo = safeReturn(url.searchParams.get('return'));
    const link = url.searchParams.get('link') === '1' ? sessionUser(req) : null;
    if (url.searchParams.get('link') === '1' && !link) return fail(res, returnTo, 'no_session', 401);
    const state = randomId(24);
    const verifier = randomId(48);
    const nonce = randomId(12);
    // nonce протокола OIDC — отдельная величина: она уходит провайдеру и возвращается внутри id_token
    const oidcNonce = p.kind === 'oidc' ? randomId(16) : '';
    const anon = link ? '' : (sessionUser(req) || claimedAnon(url.searchParams) || '');
    putCookie(res, 'aura_oauth', sign({ p: provider, s: state, v: verifier, r: returnTo, l: link || '', a: anon, n: nonce, o: oidcNonce, t: Date.now() }), {
      maxAgeSec: OAUTH_TTL_MS / 1000, path: '/auth',
    });
    const to = new URL(p.authorizeUrl);
    to.searchParams.set('response_type', 'code');
    to.searchParams.set('client_id', p.clientId);
    to.searchParams.set('redirect_uri', callbackUrl(req, provider));
    to.searchParams.set('state', state);
    to.searchParams.set('code_challenge', s256(verifier));
    to.searchParams.set('code_challenge_method', 'S256');
    if (p.scope) to.searchParams.set('scope', p.scope);
    if (oidcNonce) to.searchParams.set('nonce', oidcNonce);
    for (const [k, v] of Object.entries(p.authParams || {})) to.searchParams.set(k, v);
    db.event('web_login_start', link || '', 0, provider);
    return redirect(res, to.href);
  }

  async function onCallback(req, res, url, provider) {
    const p = providers[provider];
    if (!redirectKind(p)) return json(res, 404, { error: 'provider' });
    if (!rateOk(req, 'callback', 40, 5 * MIN)) return json(res, 429, { error: 'rate' });
    const st = unsign(parseCookies(req.headers.cookie).aura_oauth);
    dropCookie(res, 'aura_oauth', '/auth');
    const returnTo = safeReturn(st?.r);
    if (!st || st.p !== provider || Date.now() - Number(st.t || 0) > OAUTH_TTL_MS) return fail(res, returnTo, 'state');
    const given = String(url.searchParams.get('state') || '');
    if (given.length !== st.s.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(st.s))) return fail(res, returnTo, 'state');
    if (usedStates.has(st.n)) return fail(res, returnTo, 'state_used');
    usedStates.set(st.n, Date.now() + OAUTH_TTL_MS);
    // Человек нажал «Отмена» у провайдера — это не ошибка, и экран должен звучать иначе
    const denied = String(url.searchParams.get('error') || '');
    if (denied) {
      const soft = denied === 'access_denied' || denied === 'user_cancelled_authorize' || denied === 'consent_required';
      return fail(res, returnTo, soft ? 'provider_denied' : 'provider_error', soft ? 400 : 502);
    }
    const code = String(url.searchParams.get('code') || '');
    if (!code) return fail(res, returnTo, 'no_code');

    let profile;
    try {
      const tok = await exchange(p, code, st.v, callbackUrl(req, provider));
      if (p.kind === 'oidc') {
        if (!tok?.id_token) throw new Error('no_id_token');
        const claims = await verifyIdToken(tok.id_token, {
          jwks: jwksFor(p), audience: p.clientId, issuers: p.issuers, nonce: st.o || '',
        });
        profile = profileFrom(claims);
      } else {
        if (!tok?.access_token) throw new Error('no_token');
        profile = await userinfo(p, tok.access_token);
      }
    } catch (e) {
      console.error('auth callback:', provider, e.message);
      return fail(res, returnTo, 'provider_error', 502);
    }
    const out = completeLogin({ provider, profile, anonId: st.l ? null : (st.a || null), linkTo: st.l || null });
    if (out.error) return fail(res, returnTo, out.error, out.error === 'banned' ? 403 : 409);
    sessionCookie(res, makeSession(out.userId));
    return redirect(res, returnTo);
  }

  async function onTelegram(req, res, url) {
    if (!providers.telegram) return json(res, 404, { error: 'provider' });
    if (!rateOk(req, 'callback', 40, 5 * MIN)) return json(res, 429, { error: 'rate' });
    let fields;
    try { fields = await readFields(req, url); } catch { return json(res, 413, { error: 'big' }); }
    const returnTo = safeReturn(fields.get('return') || url.searchParams.get('return'));
    const link = fields.get('link') === '1';
    const anon = claimedAnon(fields);
    // Служебные поля не участвуют в проверке подписи Telegram
    for (const k of ['return', 'link', 'anon_session']) fields.delete(k);
    const tg = validateLoginWidget(fields, cfg.botToken);
    if (!tg) return fail(res, req.method === 'POST' ? '' : returnTo, 'bad_signature', 401);
    const linkTo = link ? sessionUser(req) : null;
    if (link && !linkTo) return fail(res, req.method === 'POST' ? '' : returnTo, 'no_session', 401);
    // Telegram ID — он же users.id: телеграмный пользователь в браузере попадает в свой профиль (§4.3 п.4)
    const out = completeLogin({
      provider: 'telegram', fixedId: tg.id, linkTo,
      profile: { uid: tg.id, name: tg.name, avatar: tg.avatar, email: '' },
      anonId: linkTo ? null : (sessionUser(req) || anon),
    });
    if (out.error) return fail(res, req.method === 'POST' ? '' : returnTo, out.error, out.error === 'banned' ? 403 : 409);
    // Telegram отдаёт имя и username — кладём их в профиль тем же путём, что мини-апп
    db.touch(out.userId, { name: tg.name, username: tg.username, allowsPm: false, lang: db.langOf(out.userId) });
    sessionCookie(res, makeSession(out.userId));
    if (req.method === 'POST') return json(res, 200, { ok: true, merged: Boolean(out.merged), next: returnTo });
    return redirect(res, returnTo);
  }

  function onProviders(req, res) {
    const list = Object.values(providers).map(p => ({ name: p.name, kind: p.kind }));
    const me = sessionUser(req);
    return json(res, 200, {
      providers: list,
      telegramBot: providers.telegram ? cfg.botUsername || '' : '',
      session: Boolean(me),
      logins: me ? db.identitiesOf(me).map(i => ({ provider: i.provider, name: i.name, email: i.email, at: i.created_at })) : [],
    });
  }

  async function handle(req, res, url) {
    if (!enabled) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return true; }
    const path = url.pathname;
    const m = /^\/auth\/([a-z0-9_-]{1,20})\/(start|callback)$/.exec(path);
    try {
      if (path === '/auth/providers' && req.method === 'GET') { onProviders(req, res); return true; }
      if (path === '/auth/telegram/callback' && (req.method === 'POST' || req.method === 'GET')) { await onTelegram(req, res, url); return true; }
      if (m && m[2] === 'start' && req.method === 'GET') { onStart(req, res, url, m[1]); return true; }
      if (m && m[2] === 'callback') { await onCallback(req, res, url, m[1]); return true; }

      const link = /^\/auth\/link\/([a-z0-9_-]{1,20})$/.exec(path);
      if (link) {
        if (!sessionUser(req)) { json(res, 401, { error: 'no_session' }); return true; }
        if (!providers[link[1]]) { json(res, 404, { error: 'provider' }); return true; }
        const returnTo = safeReturn(url.searchParams.get('return'));
        const to = `/auth/${link[1]}/start?link=1&return=${encodeURIComponent(returnTo)}`;
        if (req.method === 'POST') json(res, 200, { url: to });
        else if (req.method === 'GET') redirect(res, to);
        else json(res, 405, { error: 'method' });
        return true;
      }
      if (path === '/auth/logout' && req.method === 'POST') {
        const me = sessionUser(req);
        dropCookie(res, 'aura_session');
        if (me) db.event('web_logout', me);
        json(res, 200, { ok: true });
        return true;
      }
      if (path === '/auth/delete' && req.method === 'POST') {
        const me = sessionUser(req);
        if (!me) { json(res, 401, { error: 'no_session' }); return true; }
        db.deleteAccount(me);
        dropCookie(res, 'aura_session');
        onAccountGone(me);
        json(res, 200, { ok: true });
        return true;
      }
      res.writeHead(404, { 'cache-control': 'no-store' });
      res.end();
      return true;
    } catch (e) {
      console.error('auth:', path, e.message);
      if (!res.headersSent) json(res, 500, { error: 'server' });
      return true;
    }
  }

  return {
    enabled, providers, handle, sessionUser, sessionCookie, completeLogin, safeReturn,
    // для WS: id пользователя из cookie запроса handshake (с разворотом слияния)
    userFromCookie: req => sessionUser(req),
  };
}
