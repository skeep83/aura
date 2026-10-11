import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { validateInitData, turnCredentials } from './auth.js';
import { Matchmaker } from './matchmaker.js';
import { Db } from './db.js';
import { Moderation } from './moderation.js';
import { createBot } from './bot.js';
import { normalizeLangs, LANGS } from './langs.js';
import { EventSchedule, localDay } from './events.js';
import { StoryStore } from './stories.js';
import { note } from './bot-profile.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const env = process.env;

const cfg = {
  port: Number(env.PORT || 8080),
  appName: env.APP_NAME || 'Aura',
  botToken: env.BOT_TOKEN || '',
  botUsername: env.BOT_USERNAME || '',
  miniAppShortName: env.MINIAPP_SHORT_NAME || '',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  adminIds: (env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  supportContact: env.SUPPORT_CONTACT || '@support',
  turnUrls: (env.TURN_URLS || (env.TURN_HOST
    ? `turn:${env.TURN_HOST}:3478?transport=udp,turn:${env.TURN_HOST}:3478?transport=tcp` : ''))
    .split(',').map(s => s.trim()).filter(Boolean),
  turnSecret: env.TURN_SECRET || '',
  reportsToBan: Number(env.REPORTS_TO_BAN || 3),
  strikesToBan: Number(env.STRIKES_TO_BAN || 3),
  strikeBanHours: Number(env.STRIKE_BAN_HOURS || 24),
  frameIntervalMs: Number(env.FRAME_INTERVAL_MS || 4000),
  tzOffset: Number(env.TZ_OFFSET_HOURS || 3),
  freeFilterPerDay: Number(env.FREE_FILTER_PER_DAY || 10),
  referralDays: Number(env.REFERRAL_PREMIUM_DAYS || 1),
  streakRewardEvery: Number(env.STREAK_REWARD_EVERY || 7),
  rateMinSeconds: Number(env.RATE_MIN_SECONDS || 15),
  emojiStatusId: env.EMOJI_STATUS_ID || '',
  ageBlockHours: Number(env.AGE_BLOCK_HOURS || 24),
  cfTurnKeyId: env.CF_TURN_KEY_ID || '',
  cfTurnToken: env.CF_TURN_TOKEN || '',
  devAnon: env.DEV_ALLOW_ANON === '1',
};

const plans = {
  week: { title: '7 дней', days: 7, stars: Number(env.PRICE_WEEK_STARS || 75) },
  month: { title: '30 дней', days: 30, stars: Number(env.PRICE_MONTH_STARS || 199) },
};

// Без токена сервер не падает (иначе контейнер уходит в цикл перезапусков), а ждёт настройки:
// страницы открываются, но войти нельзя — initData без токена не проверить.
if (!cfg.botToken && !cfg.devAnon) {
  console.error('BOT_TOKEN не задан: режим настройки, вход в чат закрыт. Задайте токен и перезапустите.');
}

const db = new Db(path.join(DATA_DIR, 'roulette.db'), { reportsToBan: cfg.reportsToBan });
const stories = new StoryStore(path.join(DATA_DIR, 'stories'));
const moderation = new Moderation({
  url: env.MODERATION_URL, token: env.MODERATION_TOKEN || '', threshold: Number(env.NSFW_THRESHOLD || 0.85),
  minorThreshold: Number(env.MINOR_THRESHOLD || 0.8),
});
const schedule = new EventSchedule({
  time: env.EVENT_TIME || '21:00', tzOffsetHours: cfg.tzOffset,
  minutes: Number(env.EVENT_MINUTES || 60), roundSeconds: Number(env.ROUND_SECONDS || 180),
});
const clients = new Map(); // userId -> client (одно активное окно на пользователя)

const today = (now = Date.now()) => localDay(now, cfg.tzOffset);
const yesterday = (now = Date.now()) => localDay(now - DAY, cfg.tzOffset);

// Ссылка, открывающая Mini App с параметром (комната, реферал)
function appLink(param) {
  const bot = cfg.botUsername || bot_?.username || 'your_bot';
  return cfg.miniAppShortName
    ? `https://t.me/${bot}/${cfg.miniAppShortName}?startapp=${param}`
    : `https://t.me/${bot}?startapp=${param}`;
}

// Аура: очки для показа и уровень для матчинга (тролли сводятся с троллями)
function auraOf(u) {
  const votes = u.karma_up + u.karma_down;
  return {
    points: Math.max(0, 100 + u.karma_up * 10 - u.karma_down * 15),
    tier: votes >= 6 && db.karma(u) < 0.4 ? 'low' : 'ok',
  };
}

// ---------- Матчинг: что происходит при начале и конце разговора ----------
const mm = new Matchmaker({
  onPair(a, b, now, waits = [0, 0]) {
    [a, b].forEach((c, i) => db.event('match', c.id, waits[i]));
    // Паспорт: штамп страны собеседника
    for (const [c, o] of [[a, b], [b, a]]) {
      if (o.country && db.stamp(c.id, o.country, now)) {
        c.send({ t: 'stamp', country: o.country, total: db.passport(c.id).length });
      }
    }
    for (const c of [a, b]) {
      c.vibe = null;
      const { streak, bumped } = db.bumpStreak(c.id, today(now), yesterday(now));
      if (bumped) {
        const reward = cfg.streakRewardEvery > 0 && streak % cfg.streakRewardEvery === 0;
        if (reward) {
          db.grantPremium(c.id, 1, now);
          c.premium = true;
        }
        c.send({ t: 'streak', streak, reward });
        c.send({ t: 'me', me: profileOf(c) });
      }
      // Бесплатные подборы по фильтру: тратим один, когда фильтр реально применился
      if (!c.premium && c.want !== 'any') {
        db.useFilter(c.id, today(now));
        if (!db.filterLeft(c.id, today(now), cfg.freeFilterPerDay)) c.want = 'any';
        c.send({ t: 'me', me: profileOf(c) });
      }
    }
    if (a.room) db.roomMatch(a.room);
  },
  onUnpair(a, b, durationMs) {
    a.vibe = b.vibe = null;
    db.event('call_end', a.id, durationMs);
    if (durationMs < cfg.rateMinSeconds * 1000) return;
    const until = Date.now() + 3 * 60 * 1000;
    a.rateTarget = { id: b.id, until };
    b.rateTarget = { id: a.id, until };
    a.send({ t: 'rate_prompt' });
    b.send({ t: 'rate_prompt' });
  },
});

let bot_ = null;
const bot = cfg.botToken ? (bot_ = createBot({
  token: cfg.botToken, site: { get url() { return cfg.publicUrl; } }, stateFile: path.join(DATA_DIR, 'bot-profile.hash'), appName: cfg.appName, adminIds: cfg.adminIds,
  supportContact: cfg.supportContact, plans, db, appLink, schedule,
  stats: () => ({ online: clients.size, ...mm.stats(), ...db.stats(), ...db.funnel() }),
  kick: id => kick(id),
  onPremium: (id, until) => {
    const c = clients.get(id);
    if (!c) return;
    c.premium = until > Date.now();
    c.send({ t: 'me', me: profileOf(c) });
  },
})) : null;

// TURN от Cloudflare Realtime: временные учётки на сутки, кэшируем на час (они общие, не на пользователя)
let cfTurn = { at: 0, servers: null };
async function cloudflareTurn() {
  if (!cfg.cfTurnKeyId || !cfg.cfTurnToken) return null;
  if (cfTurn.servers && Date.now() - cfTurn.at < HOUR) return cfTurn.servers;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${cfg.cfTurnKeyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.cfTurnToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    const servers = json.iceServers ? [].concat(json.iceServers) : null;
    if (servers) cfTurn = { at: Date.now(), servers };
    return servers;
  } catch (e) {
    console.error('cloudflare turn:', e.message);
    return cfTurn.servers;
  }
}

async function iceServers(userId) {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  if (cfg.turnUrls.length && cfg.turnSecret) {
    list.push({ urls: cfg.turnUrls, ...turnCredentials(userId, cfg.turnSecret) });
  }
  const cf = await cloudflareTurn();
  if (cf) list.push(...cf);
  return list;
}

function profileOf(c) {
  const u = db.user(c.id);
  const aura = auraOf(u);
  return {
    gender: c.gender, want: c.want, langs: c.langs, premium: c.premium, premiumUntil: u.premium_until,
    strikes: u.strikes, aura: aura.points, streak: db.streakOf(c.id, today(), yesterday()),
    filterLeft: c.premium ? null : db.filterLeft(c.id, today(), cfg.freeFilterPerDay),
    notifyEvents: Boolean(u.notify_events), allowsPm: Boolean(u.allows_pm),
    refLink: appLink(`ref_${c.id}`), referrals: u.referrals,
    reveal: Boolean(c.reveal), country: c.country || null, passport: db.passport(c.id),
  };
}

function roomInfo(c) {
  if (!c.room) return null;
  const r = db.room(c.room);
  return r ? { slug: r.slug, title: r.title } : null;
}

function onlineFor(c) {
  if (!c.room) return clients.size;
  let n = 0;
  for (const o of clients.values()) if (o.room === c.room) n++;
  return n;
}

function eventInfo(now = Date.now()) {
  const s = schedule.state(now);
  return { active: s.active, startsAt: s.startsAt, endsAt: s.endsAt, roundMs: s.roundMs, time: env.EVENT_TIME || '21:00' };
}

function kick(id) {
  const c = clients.get(id);
  if (!c) return;
  mm.leave(c);
  c.send({ t: 'banned', until: db.bannedUntil(id) });
  c.close('banned');
}

// Бывший собеседник автоматически ищет дальше
function requeue(c) { if (c) mm.enqueue(c); }

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
};

function sendFile(res, file, cache = 'no-cache') {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    // Картинки бренда можно забирать с других сайтов (например, загрузить в @BotFather из Telegram Web)
    const cors = file.includes(`${path.sep}brand${path.sep}`) ? { 'access-control-allow-origin': '*' } : {};
    res.writeHead(200, {
      ...cors,
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': cache,
      'permissions-policy': 'camera=(self), microphone=(self)',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(buf);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function onStoryUpload(req, res) {
  const user = validateInitData(req.headers['x-init-data'], cfg.botToken)
    || (cfg.devAnon ? { id: 'dev' } : null);
  if (!user) return json(res, 401, { error: 'auth' });
  try {
    const name = await stories.save(req);
    const base = cfg.publicUrl || `http://${req.headers.host}`;
    json(res, 200, { url: `${base}/s/${name}` });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    return json(res, 200, { ok: true, online: clients.size, ...mm.stats(), moderation: moderation.enabled, event: eventInfo().active });
  }
  if (url.pathname === '/api/story' && req.method === 'POST') return onStoryUpload(req, res);
  if (url.pathname.startsWith('/s/')) {
    const file = stories.file(url.pathname.slice(3));
    if (!file) { res.writeHead(404); return res.end(); }
    return sendFile(res, file, 'public, max-age=86400');
  }
  // В продакшене статику отдаёт nginx (контейнер web), бэкенд — только API
  if (env.SERVE_STATIC === '0') { res.writeHead(404); return res.end(); }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  sendFile(res, file);
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (ws, req) => {
  // Страна пользователя — заголовок Cloudflare (через туннель и nginx)
  const country = String(req.headers['cf-ipcountry'] || '').toUpperCase().slice(0, 2);
  let client = null;
  let lastNext = 0, lastChat = 0, lastFrame = 0, lastGame = 0;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 10_000);
  const send = msg => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

  async function auth(msg) {
    let user = validateInitData(msg.initData, cfg.botToken);
    if (!user && cfg.devAnon) {
      user = {
        id: msg.devId?.match?.(/^dev-[\w-]{4,40}$/) ? msg.devId : 'dev-' + crypto.randomUUID().slice(0, 8),
        lang: 'ru', name: 'Dev', username: '', allowsPm: false, startParam: String(msg.startParam || ''),
      };
    }
    if (!user) return ws.close(4003, 'bad initData');
    clearTimeout(authTimer);

    const isNew = !db.exists(user.id);
    const until = db.bannedUntil(user.id);
    if (until) { send({ t: 'banned', until }); return ws.close(4004, 'banned'); }

    db.touch(user.id, user);
    const sp = user.startParam || '';
    let referred = false;
    if (isNew && sp.startsWith('ref_')) {
      const refId = sp.slice(4);
      referred = db.applyReferral(user.id, refId, { days: cfg.referralDays });
      if (referred) {
        const ref = clients.get(refId);
        if (ref) { ref.premium = true; ref.send({ t: 'me', me: profileOf(ref) }); ref.send({ t: 'referral' }); }
        bot?.notify(refId, note(db.langOf(refId), 'referral', { n: cfg.referralDays }));
      }
    }
    let room = null;
    if (cfg.devAnon && sp.startsWith('room_')) db.ensureRoom(sp.slice(5).slice(0, 16), 'Dev room');
    if (sp.startsWith('room_') && db.room(sp.slice(5))) {
      room = sp.slice(5);
      db.roomVisit(room);
    }

    clients.get(user.id)?.close('replaced');
    const u = db.user(user.id);
    client = {
      id: user.id, name: user.name || '', username: user.username || '',
      gender: u.gender, want: u.want, langs: normalizeLangs(u.langs, user.lang),
      premium: db.isPremium(u), room, tier: auraOf(u).tier, vibe: null, rateTarget: null,
      reveal: Boolean(u.reveal), country: /^[A-Z]{2}$/.test(country) && !['XX', 'T1'].includes(country) ? country : '',
      minorHist: [],
      send, close: reason => ws.close(4005, reason),
    };
    if (!client.premium && !db.filterLeft(client.id, today(), cfg.freeFilterPerDay)) client.want = 'any';
    clients.set(user.id, client);
    if (client.country) db.setCountry(client.id, client.country);
    db.event('session', client.id, 0, sp.startsWith('room_') ? `room:${room || '?'}` : sp.startsWith('ref_') ? 'ref' : '');
    const ice = await iceServers(user.id);
    if (clients.get(user.id) !== client) return;
    send({
      t: 'ready', appName: cfg.appName, ice, me: profileOf(client), online: onlineFor(client),
      isNew, referred, room: roomInfo(client), event: eventInfo(), langs: LANGS,
      moderation: moderation.enabled ? { intervalMs: cfg.frameIntervalMs } : null,
      plans: Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, { title: p.title, stars: p.stars }])),
      payments: Boolean(bot) || cfg.devAnon, emojiStatusId: cfg.emojiStatusId || null,
      freeFilterPerDay: cfg.freeFilterPerDay,
    });
  }

  async function onFrame(msg) {
    const now = Date.now();
    if (!moderation.enabled || now - lastFrame < cfg.frameIntervalMs * 0.75) return;
    if (typeof msg.jpg !== 'string' || msg.jpg.length > 200_000 || !mm.peerOf(client)) return;
    lastFrame = now;
    const r = await moderation.score(msg.jpg);
    if (!r || clients.get(client.id) !== client) return;

    // Возраст: 2 срабатывания из 3 последних кадров с лицом — закрываем доступ на сутки
    if (r.minor !== null) {
      client.minorHist = [...client.minorHist, moderation.isMinor(r)].slice(-3);
      if (client.minorHist.filter(Boolean).length >= 2) {
        console.log(`age block ${client.id} minor=${r.minor.toFixed(2)}`);
        db.event('age_block', client.id, r.minor);
        requeue(mm.leave(client, { t: 'peer_left', reason: 'moderation' }));
        const until = db.ban(client.id, cfg.ageBlockHours * HOUR, 'age');
        send({ t: 'banned', until, reason: 'age' });
        return client.close('banned');
      }
    }
    if (!moderation.isViolation(r)) return;

    const strikes = db.strike(client.id);
    db.event('nsfw', client.id, r.nsfw);
    console.log(`nsfw ${client.id} score=${r.nsfw.toFixed(2)} strikes=${strikes}`);
    requeue(mm.leave(client, { t: 'peer_left', reason: 'moderation' }));
    if (strikes >= cfg.strikesToBan) {
      db.ban(client.id, cfg.strikeBanHours * HOUR, 'nsfw');
      return kick(client.id);
    }
    send({ t: 'warning', strikes, max: cfg.strikesToBan });
  }

  async function onInvoice(msg) {
    if (!plans[msg.plan]) return;
    if (bot) {
      try { send({ t: 'invoice', url: await bot.createInvoiceLink(client.id, msg.plan) }); }
      catch (e) { console.error('invoice:', e.message); send({ t: 'error', code: 'pay_unavailable', text: 'Payments are temporarily unavailable' }); }
    } else if (cfg.devAnon) {
      // Локальная отладка: премиум без оплаты
      const until = db.addPayment({ chargeId: 'dev-' + crypto.randomUUID(), userId: client.id, plan: msg.plan, stars: 0, days: plans[msg.plan].days });
      client.premium = until > Date.now();
      send({ t: 'me', me: profileOf(client) });
      send({ t: 'invoice', dev: true });
    }
  }

  // «Вайб»: взаимное желание продолжить общение. Раскрываем контакты, только если нажали оба.
  function onVibe() {
    const peer = mm.peerOf(client);
    if (!peer || client.vibe === peer.id) return;
    client.vibe = peer.id;
    db.event('vibe', client.id);
    if (peer.vibe !== client.id) return send({ t: 'vibe_sent' });
    db.event('vibe_match', client.id);
    const card = c => ({ name: c.name || 'Собеседник', username: c.username || null, id: c.id });
    send({ t: 'vibe_match', peer: card(peer) });
    peer.send({ t: 'vibe_match', peer: card(client) });
    for (const [a, b] of [[client, peer], [peer, client]]) {
      const who = b.username ? `@${b.username}` : `<a href="tg://user?id=${b.id}">${escapeHtml(b.name || 'собеседник')}</a>`;
      bot?.notify(a.id, note(db.langOf(a.id), 'vibe', { app: cfg.appName, who }));
    }
  }

  function onRate(msg) {
    const t = client.rateTarget;
    client.rateTarget = null;
    if (!t || Date.now() > t.until) return;
    if (db.rate(client.id, t.id, msg.v > 0 ? 1 : -1)) {
      const target = clients.get(t.id);
      if (target) target.tier = auraOf(db.user(t.id)).tier;
    }
    send({ t: 'rated' });
  }

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!client) return msg.t === 'auth' ? auth(msg).catch(e => { console.error('auth:', e.message); ws.close(1011, 'error'); }) : ws.close(4001, 'auth required');

    switch (msg.t) {
      case 'profile': {
        if (['m', 'f', 'x'].includes(msg.gender)) client.gender = msg.gender;
        if (msg.langs) client.langs = normalizeLangs(msg.langs, client.langs[0]);
        if (['any', 'm', 'f'].includes(msg.want)) {
          const canFilter = client.premium || db.filterLeft(client.id, today(), cfg.freeFilterPerDay) > 0;
          client.want = canFilter ? msg.want : 'any';
        }
        if (typeof msg.notifyEvents === 'boolean') db.setNotify(client.id, msg.notifyEvents);
        if (typeof msg.reveal === 'boolean') { client.reveal = msg.reveal; db.setReveal(client.id, msg.reveal); }
        db.setProfile(client.id, client);
        send({ t: 'me', me: profileOf(client) });
        break;
      }
      case 'allow_pm':
        db.setAllowsPm(client.id);
        break;
      case 'room':
        // Выйти из комнаты канала в общую рулетку
        if (msg.slug === null) {
          client.room = null;
          if (mm.isWaiting(client)) mm.enqueue(client);
          send({ t: 'room', room: null, online: onlineFor(client) });
        }
        break;
      case 'find':
      case 'next': {
        const now = Date.now();
        if (now - lastNext < 800) return; // антиспам «Далее»
        lastNext = now;
        requeue(mm.leave(client));
        mm.enqueue(client);
        break;
      }
      case 'stop':
        requeue(mm.leave(client));
        send({ t: 'stopped' });
        break;
      case 'signal': {
        const peer = mm.peerOf(client);
        if (peer && msg.data && typeof msg.data === 'object') peer.send({ t: 'signal', data: msg.data });
        break;
      }
      case 'chat': {
        const peer = mm.peerOf(client);
        const text = String(msg.text || '').trim().slice(0, 300);
        const now = Date.now();
        if (!peer || !text || now - lastChat < 400) return;
        lastChat = now;
        peer.send({ t: 'chat', text });
        break;
      }
      case 'game': {
        // Игры и маска: логика на клиентах, сервер только пересылает собеседнику
        const peer = mm.peerOf(client);
        const now = Date.now();
        if (!peer || !msg.data || typeof msg.data !== 'object' || now - lastGame < 80) return;
        if (JSON.stringify(msg.data).length > 2000) return;
        lastGame = now;
        peer.send({ t: 'game', data: msg.data });
        break;
      }
      case 'vibe':
        onVibe();
        break;
      case 'conn': {
        // Итог WebRTC-соединения (без IP): для диагностики NAT/TURN и метрики «доля несоединившихся»
        const clean = v => String(v || '').replace(/[^a-z,>]/g, '').slice(0, 40);
        const tag = msg.ok ? clean(msg.chosen) : `${clean(msg.why)} local=${clean(msg.local)} remote=${clean(msg.remote)}`;
        db.event(msg.ok ? 'conn_ok' : 'conn_fail', client.id, 0, tag);
        console.log(`conn ${msg.ok ? 'ok' : 'FAIL'} ${tag} turn=${Boolean(msg.turn)}`);
        break;
      }
      case 'rate':
        onRate(msg);
        break;
      case 'frame':
        onFrame(msg).catch(e => console.error('frame:', e.message));
        break;
      case 'report': {
        const peer = mm.peerOf(client);
        if (!peer) return;
        const reason = String(msg.reason || 'other').slice(0, 32);
        const until = db.report(peer.id, client.id, reason);
        db.event('report', client.id, 0, reason);
        db.rate(client.id, peer.id, -1);
        console.log(`report ${client.id} -> ${peer.id} (${reason})${until ? ' => BANNED' : ''}`);
        mm.leave(client);
        client.rateTarget = null;
        if (until) kick(peer.id); else requeue(peer);
        send({ t: 'reported' });
        mm.enqueue(client);
        break;
      }
      case 'invoice':
        onInvoice(msg);
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!client) return;
    requeue(mm.leave(client));
    if (clients.get(client.id) === client) clients.delete(client.id);
  });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// ---------- Фоновые задачи ----------
// Отваливаем мёртвые соединения (мобильные сети)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

setInterval(() => mm.tick(), 3_000).unref();

setInterval(() => {
  for (const c of clients.values()) c.send({ t: 'online', n: onlineFor(c) });
}, 5_000).unref();

// Aura Hour: старт/конец события, раунды, напоминания
let eventActive = schedule.state().active;
let remindedKey = null;
setInterval(() => {
  const now = Date.now();
  const s = schedule.state(now);
  if (s.active !== eventActive) {
    eventActive = s.active;
    const msg = { t: 'event', event: eventInfo(now) };
    for (const c of clients.values()) c.send(msg);
  }
  if (s.active) {
    for (const [a, b] of mm.pairsOlderThan(s.roundMs, now)) {
      a.send({ t: 'round_end' });
      mm.leave(a, { t: 'round_end' }, now); // b получит round_end как уведомление о разрыве
      mm.enqueue(a, now);
      mm.enqueue(b, now);
    }
  }
  const key = schedule.reminderDue(now);
  if (key && key !== remindedKey && bot) {
    remindedKey = key;
    bot.remindEvent(db.eventAudience(now).filter(u => !clients.has(u.id)));
  }
}, 1_000).unref();

// Адрес быстрого туннеля Cloudflare меняется при каждом перезапуске — узнаём его у cloudflared
// (метрики --metrics …:2000, путь /quicktunnel) и обновляем кнопку меню бота.
async function discoverPublicUrl() {
  try {
    const res = await fetch(env.PUBLIC_URL_DISCOVER, { signal: AbortSignal.timeout(3000) });
    const { hostname } = await res.json();
    const url = hostname ? `https://${hostname}` : '';
    if (url && url !== cfg.publicUrl) {
      cfg.publicUrl = url;
      console.log('публичный адрес:', url);
      bot?.setMenu();
    }
  } catch {}
}
if (env.PUBLIC_URL_DISCOVER) {
  discoverPublicUrl();
  setInterval(discoverPublicUrl, 15_000).unref();
}

server.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Порт ${cfg.port} занят другим процессом. Освободите его или запустите с PORT=8081`);
  process.exit(1);
});

server.listen(cfg.port, () => {
  console.log(`${cfg.appName} on :${cfg.port}${cfg.devAnon ? ' (DEV_ALLOW_ANON — без проверки Telegram!)' : ''}`);
  if (!cfg.turnSecret) console.warn('TURN не настроен: часть пользователей за NAT не соединится');
  if (!moderation.enabled) console.warn('MODERATION_URL не задан: автомодерация выключена');
  bot?.start();
});
