import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { validateInitData, turnCredentials } from './auth.js';
import { Matchmaker, exchangeMirror } from './matchmaker.js';
import { Db } from './db.js';
import { Moderation } from './moderation.js';
import { createBot } from './bot.js';
import { normalizeLangs, LANGS } from './langs.js';
import { EventSchedule, localDay } from './events.js';
import { StoryStore } from './stories.js';
import { note } from './bot-profile.js';
import { DuoManager } from './duo.js';
import { LiveManager } from './live.js';
import { createAdmin } from './admin.js';
import { ChatFilter } from './chatfilter.js';
import { createAI } from './ai.js';
import { createJev } from './jev.js';

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
  // Салюты — пачки для реакции «🎆» в звонке; получатель копит счётчик (+aura, каждые 10 — сутки Premium)
  salute5: { kind: 'salute', title: '5 салютов', count: 5, stars: Number(env.PRICE_SALUTE5_STARS || 25) },
  salute20: { kind: 'salute', title: '20 салютов', count: 20, stars: Number(env.PRICE_SALUTE20_STARS || 79) },
};
const FREE_REACTIONS = ['heart', 'laugh', 'fire', 'clap'];
const COMPLIMENTS = ['smile', 'funny', 'smart', 'kind', 'voice', 'world'];
const GUESS_MS = 20_000;
const EXCHANGE_HALF_SEC = Number(env.EXCHANGE_HALF_SEC || 300); // языковой обмен: минут на каждый язык
const validExchange = ex => ex && LANGS.includes(ex.native) && LANGS.includes(ex.learn) && ex.native !== ex.learn
  ? { native: ex.native, learn: ex.learn } : null;
function applyLangs(c) { c.langs = c.exchange ? [c.exchange.native, c.exchange.learn] : c.baseLangs; }
// Что показать паре участников обмена: какой язык первый, какой второй (одинаково для обоих)
function exchangeInfo(self, o) {
  if (exchangeMirror(self, o)) {
    const first = self.id < o.id ? self : o;
    return { first: first.exchange.learn, second: first.exchange.native, halfSec: EXCHANGE_HALF_SEC };
  }
  const x = self.exchange ? self : o.exchange ? o : null;
  return x ? { first: x.exchange.learn, second: null, halfSec: EXCHANGE_HALF_SEC } : null;
}
// «Позовите, когда соберутся»: порог людей онлайн на языке подписчика
const CROWD_MIN = Number(env.CROWD_MIN || 8);
// Варианты для «Угадай, откуда он»: популярные страны аудитории
const GUESS_POOL = ['RU', 'UA', 'KZ', 'BY', 'UZ', 'MD', 'RO', 'PL', 'DE', 'FR', 'IT', 'ES', 'PT', 'GB', 'US', 'BR', 'MX', 'AR', 'TR', 'IN', 'ID', 'VN', 'EG', 'GE', 'AM', 'AZ', 'KG', 'IL', 'CZ', 'NL'];

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
const chatFilter = new ChatFilter();
const ai = createAI({ db });
const jev = createJev({ db });
const FRAME_GRACE_MS = Number(env.FRAME_GRACE_MS || 25_000);  // после начала разговора кадры обязательны
const FRAME_MAX_GAP_MS = Number(env.FRAME_MAX_GAP_MS || 20_000); // дольше без кадра — разговор прерывается (модифицированный клиент или камера выключена)
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
    points: Math.max(0, 100 + u.karma_up * 10 - u.karma_down * 15 + (u.aura_bonus || 0)),
    tier: votes >= 6 && db.karma(u) < 0.4 ? 'low' : 'ok',
  };
}

// Новичок — первые 3 разговора: его сводим с «хорошими» (аура ≥ 110, не новички, без плохой репутации)
const NEWBIE_MATCHES = 3;
function setStanding(c, u = db.user(c.id)) {
  const a = auraOf(u);
  c.tier = a.tier;
  c.newbie = (c.matches || 0) < NEWBIE_MATCHES;
  c.good = !c.newbie && a.tier === 'ok' && a.points >= 110;
}

// ---------- «Угадай, откуда он»: первые 20 с страна собеседника скрыта ----------
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function guessOptions(answer, mine) {
  const pool = shuffle(GUESS_POOL.filter(c => c !== answer && c !== mine));
  return shuffle([answer, ...pool.slice(0, 3)]);
}
function finishGuess(c, pick) {
  const g = c.guess;
  if (!g || g.done) return;
  g.done = true;
  clearTimeout(g.timer);
  const ok = pick === null ? null : pick === g.answer;
  if (ok) { db.addAuraBonus(c.id, 10); db.event('guess_ok', c.id); }
  c.send({ t: 'guess_result', ok, country: g.answer, stamp: g.stamp || null });
  if (ok) c.send({ t: 'me', me: profileOf(c) });
}

// ---------- Матчинг: что происходит при начале и конце разговора ----------
const duos = new DuoManager({
  onGroupEnd(g, ms) {
    for (const m of g.members) db.event('talk', m.c.id, ms);
    db.event('duo_call', '', ms);
  },
});

const mm = new Matchmaker({
  peerInfo(self, o, common) {
    clearTimeout(self.guess?.timer);
    self.guess = null;
    // Звонок другу или стримеру: собеседник известен, игра «Угадай» не нужна
    if (self.direct) {
      const hideName = self.direct === 'live' && self.live?.role === 'host'; // имя зрителя не попадает в трансляцию
      return { gender: o.gender, langs: common, country: o.country || null, direct: self.direct, name: hideName ? '' : o.name || '' };
    }
    const exchange = exchangeInfo(self, o);
    if (exchange) {
      const base = { gender: o.gender, langs: common, country: o.country || null, exchange };
      return base;
    }
    if (self.country && o.country && self.country !== o.country) {
      self.guess = { answer: o.country, options: guessOptions(o.country, self.country), done: false, stamp: null };
      return { gender: o.gender, langs: common, country: null, guess: { options: self.guess.options, seconds: GUESS_MS / 1000 } };
    }
    return { gender: o.gender, langs: common, country: o.country || null };
  },
  onPair(a, b, now, waits = [0, 0]) {
    [a, b].forEach((c, i) => db.event('match', c.id, waits[i], c.newbie ? 'newbie' : ''));
    for (const c of [a, b]) { c.matches = (c.matches || 0) + 1; setStanding(c); }
    // Паспорт: штамп страны собеседника
    for (const [c, o] of [[a, b], [b, a]]) {
      if (o.country && db.stamp(c.id, o.country, now)) {
        const stamp = { country: o.country, total: db.passport(c.id).length };
        // Во время игры «Угадай» штамп покажем вместе с ответом, иначе он раскроет страну
        if (c.guess) c.guess.stamp = stamp; else c.send({ t: 'stamp', ...stamp });
      }
      if (c.guess) c.guess.timer = setTimeout(() => finishGuess(c, null), GUESS_MS);
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
    if (a.direct || b.direct) {
      const kind = a.direct || b.direct;
      for (const c of [a, b]) { c.direct = null; c.directEnded = true; }
      db.event(`${kind}_end`, a.id, durationMs);
      live.onUnpair(a, b);
    }
    for (const c of [a, b]) { clearTimeout(c.guess?.timer); c.guess = null; }
    db.event('call_end', a.id, durationMs);
    db.event('talk', a.id, durationMs);
    db.event('talk', b.id, durationMs);
    if (durationMs < cfg.rateMinSeconds * 1000) return;
    const until = Date.now() + 3 * 60 * 1000;
    a.rateTarget = { id: b.id, until };
    b.rateTarget = { id: a.id, until };
    // Окно для комплимента — те же 3 минуты после разговора
    a.complTarget = { id: b.id, until };
    b.complTarget = { id: a.id, until };
    a.send({ t: 'rate_prompt' });
    b.send({ t: 'rate_prompt' });
  },
});

let bot_ = null;
const bot = cfg.botToken ? (bot_ = createBot({
  token: cfg.botToken, site: { get url() { return cfg.publicUrl; } }, stateFile: path.join(DATA_DIR, 'bot-profile.hash'), appName: cfg.appName, adminIds: cfg.adminIds,
  supportContact: cfg.supportContact, plans, db, appLink, schedule,
  stats: () => ({ online: clients.size, ...mm.stats(), ...duos.stats(), ...live.stats(), ...db.stats(), ...db.funnel() }),
  kick: id => kick(id),
  onSalutes: id => {
    const c = clients.get(id);
    if (c) c.send({ t: 'me', me: profileOf(c) });
  },
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
    gender: c.gender, want: c.want, langs: c.baseLangs || c.langs, exchange: c.exchange || null, premium: c.premium, premiumUntil: u.premium_until,
    strikes: u.strikes, aura: aura.points, streak: db.streakOf(c.id, today(), yesterday()),
    filterLeft: c.premium ? null : db.filterLeft(c.id, today(), cfg.freeFilterPerDay),
    notifyEvents: Boolean(u.notify_events), allowsPm: Boolean(u.allows_pm),
    refLink: appLink(`ref_${db.refCode(c.id)}`), shareLink: `${cfg.publicUrl || ''}/r/${db.refCode(c.id)}`, referrals: u.referrals,
    reveal: Boolean(c.reveal), country: c.country || null, passport: db.passport(c.id),
    salutes: u.salutes, salutesReceived: u.salutes_received, compliments: db.complimentsOf(c.id),
    crowd: u.crowd_until > Date.now(), crowdMin: CROWD_MIN,
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

// Aura Hour идёт в EVENT_TIME по местному времени каждого человека (часовой пояс присылает клиент)
const DEFAULT_TZ = Math.round(cfg.tzOffset * 60);
const schedules = new Map();
function scheduleFor(tz = DEFAULT_TZ) {
  if (!schedules.has(tz)) {
    schedules.set(tz, new EventSchedule({
      time: env.EVENT_TIME || '21:00', tzOffsetHours: tz / 60,
      minutes: Number(env.EVENT_MINUTES || 60), roundSeconds: Number(env.ROUND_SECONDS || 180),
    }));
  }
  return schedules.get(tz);
}
const tzOf = c => (Number.isInteger(c?.tz) ? c.tz : DEFAULT_TZ);
const inEvent = (c, now = Date.now()) => scheduleFor(tzOf(c)).state(now).active;
function eventInfo(c = null, now = Date.now()) {
  const s = scheduleFor(tzOf(c)).state(now);
  return { active: s.active, startsAt: s.startsAt, endsAt: s.endsAt, roundMs: s.roundMs, time: env.EVENT_TIME || '21:00' };
}

function kick(id, banned = true) {
  const c = clients.get(id);
  if (!c) return;
  requeue(mm.leave(c));
  duos.leave(c);
  if (banned) c.send({ t: 'banned', until: db.bannedUntil(id) });
  c.close(banned ? 'banned' : 'kicked');
}

// Админ-API для панели на TrueNAS (/api/admin/*, Bearer ADMIN_API_TOKEN)
const admin = createAdmin({
  db, ai, jev, appLink, botUsername: () => cfg.botUsername || bot_?.username || '', token: env.ADMIN_API_TOKEN || '',
  cfg: {
    ...cfg, moderationUrl: env.MODERATION_URL || '', nsfwThreshold: Number(env.NSFW_THRESHOLD || 0.85),
    minorThreshold: Number(env.MINOR_THRESHOLD || 0.8),
  },
  live: () => ({ online: clients.size, ...mm.stats(), ...duos.stats(), event: eventInfo() }),
  isOnline: id => clients.has(id),
  kick,
  refresh: id => {
    const c = clients.get(id);
    if (!c) return;
    const u = db.user(id);
    c.premium = db.isPremium(u);
    setStanding(c, u);
    c.send({ t: 'me', me: profileOf(c) });
  },
  refund: async chargeId => {
    if (!bot) return { error: 'bot_off' };
    try { return await bot.refund(chargeId); } catch (e) { return { error: e.message }; }
  },
  notify: (id, text) => bot?.notify(id, text),
});

// Откуда пришёл пользователь: рекламная кампания (ad_<код>), комната канала, приглашение, Duo
function sourceOf(sp, room) {
  if (/^ad_[\w-]{1,40}$/.test(sp)) return `ad:${sp.slice(3)}`;
  if (sp.startsWith('room_')) return `room:${room || '?'}`;
  if (sp.startsWith('ref_')) return 'ref';
  if (sp.startsWith('duo_')) return 'duo';
  if (sp.startsWith('_tgr_')) return 'affiliate';
  return 'direct';
}

// Jev разбирает жалобу: рекомендация для админки, при уверенности ≥ 90% и повторных жалобах — автобан (если включён)
const BAN_HOURS = { ban_24h: 24, ban_7d: 168 };
async function triageReport(targetId, reason) {
  if (!jev.on('reportTriage')) return;
  try {
    const d = admin.userDetail(targetId);
    if (!d) return;
    const u = d.user;
    const state = JSON.stringify({
      newReport: reason, reportsAgainst: d.reportsAgainst.map(r => r.reason), aura: u.aura, karmaUp: u.karmaUp, karmaDown: u.karmaDown,
      nsfwStrikes: u.strikes, accountAgeDays: Math.round((Date.now() - u.createdAt) / DAY), premium: u.premiumUntil > Date.now(),
      recentEvents: d.events.filter(e => ['nsfw', 'age_block', 'chat_block', 'no_frames', 'report'].includes(e.type)).slice(0, 20).map(e => e.type),
      chatsLast7d: d.wrapped.chats,
    });
    const r = await jev.triageReport(state);
    if (!r) return;
    db.event('jev_triage', targetId, r.confidence, r.action);
    console.log(`jev triage ${targetId}: ${r.action} (${Math.round(r.confidence * 100)}%)`);
    if (jev.on('autoBan') && BAN_HOURS[r.action] && r.confidence >= 0.9 && d.reportsAgainst.length >= 2) {
      db.ban(targetId, BAN_HOURS[r.action] * HOUR, `jev:${r.action}`);
      db.event('jev_autoban', targetId, r.confidence, r.action);
      kick(targetId);
    }
  } catch (e) { console.error('jev triage:', e.message); }
}

// Бывший собеседник автоматически ищет дальше
// После прямого звонка (друг, стример) человек не уходит в общую рулетку — ему приходит «звонок завершён».
// Стример в эфире ждёт следующего зрителя из очереди.
function requeue(c) {
  if (!c) return;
  if (c.live?.role === 'host') return;
  if (c.live?.role === 'viewer') return;
  if (c.directEnded) { c.directEnded = false; c.send({ t: 'call_ended' }); return; }
  mm.enqueue(c);
}

// ---------- Комнаты стримеров ----------
const live = new LiveManager({
  mm,
  requeue: c => requeue(c),
  linkFor: code => appLink(`live_${code}`),
  onLive: room => {
    db.event('live_start', room.host.id, room.roundMs / 1000);
    const subs = db.liveSubscribers(room.code).filter(id => !clients.has(id));
    if (!bot || !subs.length) return;
    (async () => {
      for (const id of subs) {
        const lang = db.langOf(id);
        await bot.notify(id, note(lang, 'live_on', { title: escapeHtml(room.title), app: cfg.appName }),
          { reply_markup: { inline_keyboard: [[{ text: note(lang, 'live_join'), url: appLink(`live_${room.code}`) }]] } });
        await new Promise(r => setTimeout(r, 40));
      }
    })().catch(e => console.error('live notify:', e.message));
  },
});

function liveInviteInfo(code) {
  const room = live.room(code);
  const hostId = db.resolveRef(code);
  return { code, online: Boolean(room), title: room?.title || (hostId ? db.user(hostId).name : '') || 'Aura Live', subscribed: false };
}

// ---------- Звонки друзьям ----------
const CALL_RING_MS = 30_000;       // онлайн-друг: сколько звонит входящий
const CALL_OFFLINE_MS = 120_000;   // друг не в сети: сколько ждём, пока он откроет ссылку из бота
const cardOf = c => ({ code: db.refCode(c.id), name: c.name || '', country: c.country || null });
function cancelCall(c, reason = 'cancelled') {
  const call = c?.call;
  if (!call) return;
  clearTimeout(call.timer);
  c.call = null;
  const other = clients.get(call.with);
  if (other?.call?.with === c.id) {
    clearTimeout(other.call.timer);
    other.call = null;
    other.send({ t: 'call_cancelled', reason });
  }
}
function startCall(caller, code) {
  const id = db.resolveRef(code);
  if (!id || !db.isFriend(caller.id, id)) return caller.send({ t: 'call_error', code: 'not_friend' });
  const target = clients.get(id);
  if (target && (target.call || target.direct || target.live)) return caller.send({ t: 'call_error', code: 'busy' });
  cancelCall(caller);
  requeue(mm.leave(caller));
  const name = target ? target.name : db.user(id).name;
  caller.call = { with: id, role: 'caller', timer: setTimeout(() => { cancelCall(caller, 'timeout'); caller.send({ t: 'call_timeout' }); }, target ? CALL_RING_MS : CALL_OFFLINE_MS) };
  db.event('friend_call', caller.id, target ? 1 : 0);
  if (target) {
    target.call = { with: caller.id, role: 'callee', timer: null };
    target.send({ t: 'call_incoming', from: cardOf(caller) });
  } else {
    const lang = db.langOf(id);
    bot?.notify(id, note(lang, 'call_invite', { who: escapeHtml(caller.name || '?'), app: cfg.appName }),
      { reply_markup: { inline_keyboard: [[{ text: note(lang, 'call_answer'), url: appLink(`call_${db.refCode(caller.id)}`) }]] } });
  }
  caller.send({ t: 'calling', to: { name: name || '', online: Boolean(target) } });
}
function acceptCall(callee, callerId = callee.call?.with) {
  const caller = clients.get(callerId);
  if (!caller || caller.call?.with !== callee.id) { callee.call = null; return callee.send({ t: 'call_cancelled', reason: 'gone' }); }
  clearTimeout(caller.call.timer);
  caller.call = callee.call = null;
  caller.direct = callee.direct = 'friend';
  for (const c of [caller, callee]) c.directEnded = false;
  if (callee.duo) duos.leave(callee);
  live.drop(callee);
  mm.forcePair(caller, callee).forEach(requeue);
  db.event('friend_call_ok', caller.id);
}
function friendsList(c) {
  return db.friendsOf(c.id).map(f => {
    const o = clients.get(f.id);
    return { code: db.refCode(f.id), name: f.name || '', country: f.country || null, online: Boolean(o),
      busy: Boolean(o && (mm.peerOf(o) || o.call || o.live)), lastSeen: f.lastSeen };
  });
}

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

// ---------- Вход в браузере (компьютер): Telegram Desktop/Web не дают Mini App камеру ----------
// Mini App выдаёт одноразовый код на 5 минут → aura-life.online/?login=<код> в браузере →
// сервер меняет его на сессию на 30 дней (подпись HMAC от токена бота, без хранения на сервере).
const handoffs = new Map(); // code -> { userId, exp }
const SESSION_DAYS = 30;
const sessionKey = () => crypto.createHash('sha256').update('aura-session:' + cfg.botToken).digest();
function makeSession(userId, now = Date.now()) {
  const body = `${userId}.${now + SESSION_DAYS * DAY}`;
  return `${body}.${crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url')}`;
}
function checkSession(token, now = Date.now()) {
  const m = /^([\w-]{1,40})\.(\d{13})\.([\w-]{43})$/.exec(String(token || ''));
  if (!m || Number(m[2]) < now) return null;
  const want = crypto.createHmac('sha256', sessionKey()).update(`${m[1]}.${m[2]}`).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[3])) ? m[1] : null;
}
function userFromSession(id, startParam = '') {
  if (!id || !db.exists(id)) return null;
  const u = db.user(id);
  return { id, lang: u.lang || 'en', name: u.name || '', username: u.username || '', allowsPm: Boolean(u.allows_pm), startParam, web: true };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of handoffs) if (v.exp < now) handoffs.delete(k); }, 60_000).unref();

async function onStoryUpload(req, res) {
  const user = validateInitData(req.headers['x-init-data'], cfg.botToken)
    || (checkSession(req.headers['x-session']) ? { id: checkSession(req.headers['x-session']) } : null)
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

// Отправка карточки в чат Telegram: сервер готовит inline-сообщение с кнопкой «Открыть Aura» (реферальная ссылка автора)
const SHARE_TEXT = {
  ru: ['✨ Залетай в Aura — видеочат со всем миром прямо в Telegram', '🎥 Открыть Aura'],
  uk: ['✨ Залітай в Aura — відеочат з усім світом прямо в Telegram', '🎥 Відкрити Aura'],
  es: ['✨ Únete a Aura — videochat con todo el mundo dentro de Telegram', '🎥 Abrir Aura'],
  pt: ['✨ Vem pro Aura — videochat com o mundo inteiro dentro do Telegram', '🎥 Abrir Aura'],
  de: ['✨ Komm zu Aura — Videochat mit der ganzen Welt direkt in Telegram', '🎥 Aura öffnen'],
  tr: ['✨ Aura’ya katıl — Telegram içinde tüm dünyayla görüntülü sohbet', '🎥 Aura’yı aç'],
  id: ['✨ Gabung Aura — video chat dengan seluruh dunia di Telegram', '🎥 Buka Aura'],
  en: ['✨ Join me on Aura — video chat with the whole world right inside Telegram', '🎥 Open Aura'],
};
async function onSharePrepare(req, res) {
  const user = validateInitData(req.headers['x-init-data'], cfg.botToken);
  if (!user || !bot) return json(res, 401, { error: 'auth' });
  let body = '';
  try { for await (const c of req) { body += c; if (body.length > 2000) throw new Error('big'); } } catch { return json(res, 413, { error: 'big' }); }
  try {
    const { photoUrl } = JSON.parse(body);
    const base = (cfg.publicUrl || '') + '/s/';
    if (typeof photoUrl !== 'string' || !photoUrl.startsWith(base) || !stories.file(photoUrl.slice(base.length))) return json(res, 400, { error: 'photo' });
    const [caption, button] = SHARE_TEXT[String(user.lang || '').slice(0, 2)] || SHARE_TEXT.en;
    const code = db.refCode(String(user.id));
    const id = await bot.prepareShare(user.id, { photoUrl, caption: `${caption}\n${cfg.publicUrl}/r/${code}`, button, url: appLink(`ref_${code}`) });
    db.event('share_prepare', String(user.id));
    json(res, 200, { id });
  } catch (e) {
    console.error('share prepare:', e.message);
    json(res, 500, { error: 'prepare' });
  }
}

// Посадочная страница рекламы (/go?c=…): просмотр и клик «Открыть в Telegram». Без cookies и личных данных.
const landingHits = new Map(); // ip -> { n, reset }
async function onLanding(req, res) {
  const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
  const now = Date.now();
  const h = landingHits.get(ip);
  if (h && now < h.reset && h.n >= 20) { res.writeHead(429); return res.end(); }
  landingHits.set(ip, h && now < h.reset ? { n: h.n + 1, reset: h.reset } : { n: 1, reset: now + 60_000 });
  if (landingHits.size > 50_000) landingHits.clear();
  let body = '';
  try { for await (const c of req) { body += c; if (body.length > 500) throw new Error('big'); } } catch { res.writeHead(413); return res.end(); }
  try {
    const { c, ev } = JSON.parse(body);
    const code = String(c || '').replace(/[^\w-]/g, '').slice(0, 40);
    if (code && (ev === 'view' || ev === 'click')) db.event(`landing_${ev}`, '', 0, `ad_${code}`);
  } catch {}
  res.writeHead(204); res.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    return json(res, 200, {
      ok: true, online: clients.size, ...mm.stats(), moderation: moderation.enabled,
      moderationUp: moderation.enabled ? moderation.up !== false : null, turn: Boolean(cfg.turnSecret || cfg.cfTurnKeyId), event: eventInfo().active,
    });
  }
  if (url.pathname === '/api/story' && req.method === 'POST') return onStoryUpload(req, res);
  if (url.pathname === '/api/landing' && req.method === 'POST') return onLanding(req, res);
  if (url.pathname === '/api/share/prepare' && req.method === 'POST') return onSharePrepare(req, res);
  if (url.pathname.startsWith('/api/admin/')) {
    admin.handle(req, res, url).catch(e => { console.error('admin:', e.message); if (!res.headersSent) { res.writeHead(500); res.end(); } });
    return;
  }
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
  let lastNext = 0, lastChat = 0, lastFrame = 0, lastGame = 0, lastReact = 0, lastTopic = 0;
  const translations = []; // время переводов за последний час (лимит)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 10_000);
  const send = msg => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

  async function auth(msg) {
    let user = validateInitData(msg.initData, cfg.botToken);
    let session = null;
    if (!user && msg.login) {
      // Одноразовый код из Mini App → сессия браузера
      const h = handoffs.get(String(msg.login));
      handoffs.delete(String(msg.login));
      if (h && h.exp > Date.now()) { user = userFromSession(h.userId, String(msg.startParam || '')); if (user) session = makeSession(user.id); }
    }
    if (!user && msg.session) user = userFromSession(checkSession(msg.session), String(msg.startParam || ''));
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

    if (!user.web) db.touch(user.id, user); else db.touch(user.id, { ...user, lang: user.lang });
    const sp = user.startParam || '';
    let referred = false;
    if (isNew && sp.startsWith('ref_')) {
      const refId = db.resolveRef(sp.slice(4));
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
      gender: u.gender, want: u.want, baseLangs: normalizeLangs(u.langs, user.lang),
      exchange: validExchange({ native: u.ex_native, learn: u.ex_learn }),
      premium: db.isPremium(u), room, tier: auraOf(u).tier, vibe: null, rateTarget: null,
      matches: db.matchCount(user.id),
      reveal: Boolean(u.reveal), country: /^[A-Z]{2}$/.test(country) && !['XX', 'T1'].includes(country) ? country
        : cfg.devAnon && /^[A-Z]{2}$/.test(msg.devCountry || '') ? msg.devCountry : '',
      minorHist: [], fromTelegram: !user.web && !String(user.id).startsWith('dev-') || (cfg.devAnon && !user.web),
      send, close: reason => ws.close(4005, reason),
    };
    if (!client.premium && !db.filterLeft(client.id, today(), cfg.freeFilterPerDay)) client.want = 'any';
    setStanding(client, u);
    applyLangs(client);
    // Часовой пояс устройства (минуты к UTC) — для Aura Hour по местному времени
    const tz = Number(msg.tz);
    if (Number.isInteger(tz) && tz >= -720 && tz <= 840) { client.tz = tz; if (tz !== u.tz_min) db.setTz(user.id, tz); }
    else if (u.tz_min !== -10000) client.tz = u.tz_min;
    client.eventActive = inEvent(client);
    clients.set(user.id, client);
    if (client.country) db.setCountry(client.id, client.country);
    if (sp.startsWith('duo_')) setTimeout(() => clients.get(client.id) === client && onDuo({ t: 'duo_join', code: sp.slice(4) }), 0);
    // Друг открыл приглашение на звонок из бота — соединяем, если звонящий ещё ждёт
    if (sp.startsWith('call_')) {
      const callerId = db.resolveRef(sp.slice(5));
      const caller = callerId && clients.get(callerId);
      if (caller?.call?.with === user.id) client.callFrom = callerId;
    }
    const source = sourceOf(sp, room);
    if (isNew) db.setSource(client.id, source);
    db.event('session', client.id, 0, source === 'direct' ? '' : source);
    const ice = await iceServers(user.id);
    if (clients.get(user.id) !== client) return;
    send({
      t: 'ready', appName: cfg.appName, ice, me: profileOf(client), online: onlineFor(client),
      isNew, referred, room: roomInfo(client), event: eventInfo(client), langs: LANGS,
      moderation: moderation.enabled ? { intervalMs: cfg.frameIntervalMs } : null,
      plans: Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, { title: p.title, stars: p.stars, kind: p.kind || 'premium', count: p.count || 0 }])),
      payments: Boolean(bot) || cfg.devAnon, emojiStatusId: cfg.emojiStatusId || null,
      freeFilterPerDay: cfg.freeFilterPerDay, reactions: FREE_REACTIONS, compliments: COMPLIMENTS,
      openWrapped: sp === 'wrapped', ai: ai.clientFeatures(),
      liveInvite: sp.startsWith('live_') ? liveInviteInfo(sp.slice(5)) : null,
      callInvite: sp.startsWith('call_') ? { code: sp.slice(5) } : null,
    });
    if (session) { send({ t: 'session', token: session }); db.event('web_login', user.id); }
    if (client.callFrom) {
      const caller = clients.get(client.callFrom);
      if (caller?.call?.with === client.id) { client.call = { with: caller.id, role: 'callee', timer: null }; send({ t: 'call_incoming', from: cardOf(caller) }); }
      client.callFrom = null;
    }
  }

  async function onFrame(msg) {
    const now = Date.now();
    if (typeof msg.jpg === 'string' && msg.jpg.length > 1000) client.lastFrameAt = now;
    if (!moderation.enabled || now - lastFrame < cfg.frameIntervalMs * 0.75) return;
    if (typeof msg.jpg !== 'string' || msg.jpg.length > 200_000 || (!mm.peerOf(client) && !duos.groupOf(client))) return;
    client.lastFrameAt = now;
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
        duos.leave(client);
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
    if (client.duo?.group) duos.endGroup(client.duo, 'moderation');
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
      // Локальная отладка: покупки без оплаты
      const chargeId = 'dev-' + crypto.randomUUID(), plan = plans[msg.plan];
      if (plan.kind === 'salute') {
        db.recordPayment({ chargeId, userId: client.id, plan: msg.plan, stars: 0 });
        db.addSalutes(client.id, plan.count);
      } else {
        const until = db.addPayment({ chargeId, userId: client.id, plan: msg.plan, stars: 0, days: plan.days });
        client.premium = until > Date.now();
      }
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
    db.event('vibe_match', peer.id);
    // Взаимный вайб = друзья в Aura: можно звонить напрямую
    if (db.addFriends(client.id, peer.id)) {
      send({ t: 'friend_added', name: peer.name || '' });
      peer.send({ t: 'friend_added', name: client.name || '' });
    }
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
      if (target) setStanding(target);
    }
    send({ t: 'rated' });
  }

  // Тяжёлое нарушение в чате: сообщение не доставлено, страйк; 3 за сутки — бан на сутки
  function onChatViolation(reason, text) {
    const now = Date.now();
    client.chatStrikes = [...(client.chatStrikes || []).filter(t => now - t < DAY), now];
    db.event('chat_block', client.id, client.chatStrikes.length, reason);
    console.log(`chat block ${client.id} (${reason}) strikes=${client.chatStrikes.length}: ${text.slice(0, 60).replace(/\s+/g, ' ')}`);
    if (client.chatStrikes.length >= 3) {
      db.ban(client.id, 24 * HOUR, 'chat');
      return kick(client.id);
    }
    send({ t: 'chat_blocked', reason: /^(ai|jev):/.test(reason) ? 'severe' : reason, strikes: client.chatStrikes.length, max: 3 });
  }

  // Комплимент после разговора: анонимно, один в сутки на пару, заодно +aura
  function onCompliment(msg) {
    const t = client.complTarget;
    if (!t || Date.now() > t.until || !COMPLIMENTS.includes(msg.kind)) return;
    client.complTarget = null;
    if (!db.compliment(client.id, t.id, msg.kind)) return send({ t: 'complimented', dup: true });
    db.event('compliment', client.id, 0, msg.kind);
    if (client.rateTarget?.id === t.id) onRate({ v: 1 }); else db.rate(client.id, t.id, 1);
    send({ t: 'complimented' });
    const target = clients.get(t.id);
    if (target) {
      target.send({ t: 'compliment', kind: msg.kind });
      target.send({ t: 'me', me: profileOf(target) });
    } else {
      const lang = db.langOf(t.id);
      bot?.notify(t.id, note(lang, 'compliment', { app: cfg.appName, what: note(lang, `c_${msg.kind}`) }));
    }
  }

  // Реакции поверх видео собеседника; «салют» — платный, получатель копит бонусы
  function onReact(msg) {
    const now = Date.now();
    if (now - lastReact < 300) return;
    const kind = String(msg.kind);
    const group = duos.groupOf(client);
    const peer = group ? null : mm.peerOf(client);
    if (!group && !peer) return;
    if (kind === 'salute') {
      if (!db.spendSalute(client.id)) return send({ t: 'need_salutes' });
      lastReact = now;
      db.event('salute', client.id);
      const targets = group ? group.members.filter(m => m.c !== client).map(m => m.c) : [peer];
      for (const tc of targets) {
        const n = db.receiveSalute(tc.id);
        db.addAuraBonus(tc.id, 5);
        if (n % 10 === 0) {
          db.grantPremium(tc.id, 1);
          tc.premium = true;
          bot?.notify(tc.id, note(db.langOf(tc.id), 'salute_premium', { n }));
        }
        tc.send({ t: 'me', me: profileOf(tc) });
      }
      send({ t: 'me', me: profileOf(client) });
    } else if (!FREE_REACTIONS.includes(kind)) return;
    lastReact = now;
    if (group) duos.broadcast(client, { t: 'react', kind });
    else peer.send({ t: 'react', kind });
  }

  function onGuess(msg) {
    const g = client.guess;
    if (!g || g.done || !g.options.includes(msg.country)) return;
    finishGuess(client, msg.country);
  }

  // Duo «двое на двое»
  function onDuo(msg) {
    switch (msg.t) {
      case 'duo_create':
        requeue(mm.leave(client));
        duos.create(client);
        db.event('duo_create', client.id);
        break;
      case 'duo_join': {
        requeue(mm.leave(client));
        const r = duos.join(client, msg.code);
        if (r !== 'ok') send({ t: 'duo_error', code: r });
        else db.event('duo_join', client.id);
        break;
      }
      case 'duo_search':
      case 'duo_next': {
        const now = Date.now();
        if (now - lastNext < 800) return;
        lastNext = now;
        requeue(mm.leave(client));
        if (!(msg.t === 'duo_next' ? duos.next(client) : duos.search(client))) send({ t: 'duo_error', code: 'need_partner' });
        break;
      }
      case 'duo_stop':
        if (client.duo) { duos.endGroup(client.duo, 'stopped'); duos.unqueue(client.duo); duos.notify(client.duo); }
        break;
      case 'duo_leave':
        duos.leave(client);
        send({ t: 'duo', duo: null });
        break;
      case 'duo_signal':
        if (msg.data && typeof msg.data === 'object') duos.relay(client, msg.to, msg.data);
        break;
    }
  }

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!client) return msg.t === 'auth' ? auth(msg).catch(e => { console.error('auth:', e.message); ws.close(1011, 'error'); }) : ws.close(4001, 'auth required');

    switch (msg.t) {
      case 'profile': {
        if (['m', 'f', 'x'].includes(msg.gender)) client.gender = msg.gender;
        if (msg.langs) client.baseLangs = normalizeLangs(msg.langs, client.baseLangs[0]);
        if ('exchange' in msg) {
          client.exchange = validExchange(msg.exchange);
          db.setExchange(client.id, client.exchange);
          db.event(client.exchange ? 'exchange_on' : 'exchange_off', client.id, 0, client.exchange ? `${client.exchange.native}>${client.exchange.learn}` : '');
        }
        applyLangs(client);
        if (['any', 'm', 'f'].includes(msg.want)) {
          const canFilter = client.premium || db.filterLeft(client.id, today(), cfg.freeFilterPerDay) > 0;
          client.want = canFilter ? msg.want : 'any';
        }
        if (typeof msg.notifyEvents === 'boolean') db.setNotify(client.id, msg.notifyEvents);
        if (typeof msg.reveal === 'boolean') { client.reveal = msg.reveal; db.setReveal(client.id, msg.reveal); }
        db.setProfile(client.id, { ...client, langs: client.baseLangs });
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
        // Стример: «Далее» — следующий зритель из очереди
        if (client.live?.role === 'host') { mm.leave(client, { t: 'peer_left', reason: 'live_turn' }); break; }
        live.leave(client);
        client.directEnded = false;
        cancelCall(client);
        requeue(mm.leave(client));
        if (client.duo) duos.leave(client);
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
        const inDuo = Boolean(duos.groupOf(client));
        if ((!peer && !inDuo) || !text || now - lastChat < 400) return;
        lastChat = now;
        const r = chatFilter.check(text, { from: client.id, to: inDuo ? 'duo' : peer.id, now });
        if (r.action === 'block') { onChatViolation(r.reason, text); break; }
        if (r.action === 'mask') {
          send({ t: 'chat_masked', reason: r.reason });
          if (r.reason === 'contact') db.event('chat_mask', client.id, 0, r.reason);
        }
        if (inDuo) duos.broadcast(client, { t: 'chat', text: r.text });
        else peer.send({ t: 'chat', text: r.text });
        // Второй слой модерации: Jev (дешёвая модель решений), иначе ИИ-провайдер
        const second = jev.on('chatModeration') ? ['jev', jev.moderateChat(text)] : ['ai', ai.moderateChat(text, client.id)];
        second[1].then(v => { if (v && clients.get(client.id) === client) onChatViolation(`${second[0]}:${v}`, text); }).catch(() => {});
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
      case 'diag': {
        // Почему не включилась камера (имя ошибки, клиент Telegram, ОС) — без личных данных, до 5 на подключение
        if ((client.diags = (client.diags || 0) + 1) > 5) break;
        const clean = (v, n = 40) => String(v ?? '').replace(/[^\w .:,()-]/g, '').slice(0, n);
        const tag = `${clean(msg.name)} ${clean(msg.platform, 12)}/${clean(msg.ver, 8)}/${clean(msg.os, 4)} ${clean(msg.msg, 80)}`.trim();
        db.event('cam_fail', client.id, 0, tag);
        console.log(`cam FAIL ${tag}`);
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
        if (!until) triageReport(peer.id, reason);
        break;
      }
      case 'invoice':
        onInvoice(msg);
        break;
      case 'compliment':
        onCompliment(msg);
        break;
      case 'react':
        onReact(msg);
        break;
      case 'guess':
        onGuess(msg);
        break;
      case 'friends':
        send({ t: 'friends', list: friendsList(client) });
        break;
      case 'friend_remove': {
        const id = db.resolveRef(String(msg.code || ''));
        if (id) db.removeFriend(client.id, id);
        send({ t: 'friends', list: friendsList(client) });
        break;
      }
      case 'call':
        if (Date.now() - (client.lastCallAt || 0) < 3000) return;
        client.lastCallAt = Date.now();
        startCall(client, String(msg.code || ''));
        break;
      case 'call_accept':
        if (client.call?.role === 'callee') acceptCall(client);
        break;
      case 'call_decline': {
        const other = client.call && clients.get(client.call.with);
        if (other?.call?.with === client.id) { clearTimeout(other.call.timer); other.call = null; other.send({ t: 'call_declined' }); }
        client.call = null;
        break;
      }
      case 'call_cancel':
        cancelCall(client);
        break;
      case 'live_start':
        if (client.duo) duos.leave(client);
        cancelCall(client);
        live.start(client, db.refCode(client.id), { title: msg.title, roundSec: msg.roundSec });
        break;
      case 'live_stop':
        live.stop(client);
        send({ t: 'stopped' });
        break;
      case 'live_join': {
        const code = String(msg.code || '').slice(0, 20);
        if (client.duo) duos.leave(client);
        cancelCall(client);
        if (live.join(client, code)) db.event('live_join', client.id, 0, code);
        else send({ t: 'live', state: 'offline', code, title: liveInviteInfo(code).title, subscribed: db.isLiveSub(code, client.id) });
        break;
      }
      case 'live_leave':
        live.leave(client);
        send({ t: 'live', state: 'left' });
        break;
      case 'live_sub':
        db.liveSub(String(msg.code || '').slice(0, 20), client.id, Boolean(msg.on));
        send({ t: 'live', state: 'offline', code: msg.code, title: liveInviteInfo(String(msg.code || '')).title, subscribed: Boolean(msg.on) });
        break;
      case 'handoff': {
        // Ссылка «открыть в браузере» — только из настоящего Mini App, не чаще раза в 10 с
        if (!client.fromTelegram || Date.now() - (client.lastHandoff || 0) < 10_000) return;
        client.lastHandoff = Date.now();
        const code = crypto.randomBytes(16).toString('hex');
        handoffs.set(code, { userId: client.id, exp: Date.now() + 5 * 60_000 });
        send({ t: 'handoff', url: `${cfg.publicUrl || ''}/?login=${code}` });
        db.event('handoff', client.id);
        break;
      }
      case 'crowd':
        db.setCrowd(client.id, Boolean(msg.on));
        db.event(msg.on ? 'crowd_on' : 'crowd_off', client.id);
        send({ t: 'me', me: profileOf(client) });
        break;
      case 'wrapped': {
        const w = db.wrapped(client.id);
        send({ t: 'wrapped', data: w });
        ai.wrappedLine(w, msg.lang || client.langs[0]).then(text => text && send({ t: 'wrapped_line', text })).catch(() => {});
        break;
      }
      case 'ai_topic': {
        // ИИ-тема для разговора: одна на пару, не чаще раза в 5 с; на языке пары, с учётом стран
        const peer = mm.peerOf(client);
        const now = Date.now();
        if (!peer || now - lastTopic < 5000) return;
        lastTopic = now;
        const lang = peer.langs.includes(msg.lang) && client.langs.includes(msg.lang) ? msg.lang : client.langs.find(l => peer.langs.includes(l)) || client.langs[0];
        client.topics = client.topics || [];
        ai.icebreaker({ lang, countries: [client.country, peer.country], recent: client.topics })
          .then(text => {
            if (!text || mm.peerOf(client) !== peer) return send({ t: 'ai_topic_fail' });
            client.topics = [...client.topics, text].slice(-10);
            const data = { g: 'topic_text', text };
            send({ t: 'game', data, mine: true });
            peer.send({ t: 'game', data });
            db.event('ai_topic', client.id);
          })
          .catch(() => send({ t: 'ai_topic_fail' }));
        break;
      }
      case 'translate': {
        // Перевод сообщения из чата: до 40 в час на человека
        const text = String(msg.text || '').slice(0, 300);
        const now = Date.now();
        while (translations.length && now - translations[0] > HOUR) translations.shift();
        if (!text || translations.length >= 40) return send({ t: 'translated', id: msg.id, error: 'limit' });
        translations.push(now);
        const lang = /^[a-z]{2}$/.test(msg.lang || '') ? msg.lang : client.langs[0];
        ai.translate(text, lang)
          .then(out => send({ t: 'translated', id: msg.id, text: out || null }))
          .catch(() => send({ t: 'translated', id: msg.id, error: 'fail' }));
        break;
      }
      case 'duo_create': case 'duo_join': case 'duo_search': case 'duo_next':
      case 'duo_stop': case 'duo_leave': case 'duo_signal':
        onDuo(msg);
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!client) return;
    requeue(mm.leave(client));
    clearTimeout(client.guess?.timer);
    cancelCall(client, 'gone');
    live.drop(client);
    duos.leave(client);
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

// Кадры на модерацию обязательны: без них разговор прерывается (модифицированный клиент, выключенная камера, свернутое приложение)
function enforceFrames(now = Date.now()) {
  if (!moderation.enabled || moderation.up === false) return;
  const stale = c => now - (c.lastFrameAt || 0) > FRAME_MAX_GAP_MS;
  for (const [a, b] of mm.pairsOlderThan(FRAME_GRACE_MS, now)) {
    for (const [c, o] of [[a, b], [b, a]]) {
      if (!stale(c) || mm.peerOf(c) !== o) continue;
      db.event('no_frames', c.id);
      console.log(`no frames ${c.id}: разговор прерван`);
      mm.leave(c, { t: 'peer_left', reason: 'moderation' });
      requeue(o);
      c.send({ t: 'error', code: 'no_frames' });
      c.send({ t: 'stopped' });
    }
  }
  for (const c of clients.values()) {
    const g = duos.groupOf(c);
    if (g && now - g.at > FRAME_GRACE_MS && stale(c)) {
      db.event('no_frames', c.id);
      c.send({ t: 'error', code: 'no_frames' });
      duos.endGroup(c.duo, 'moderation');
    }
  }
}
setInterval(enforceFrames, Math.min(5_000, FRAME_GRACE_MS)).unref();
moderation.ping();
setInterval(() => moderation.ping(), 30_000).unref();
setInterval(() => chatFilter.sweep(), 10 * 60_000).unref();

setInterval(() => {
  for (const c of clients.values()) c.send({ t: 'online', n: onlineFor(c) });
}, 5_000).unref();

// Aura Hour: у каждого — в его местные 21:00. Старт/конец для каждого клиента, раунды — если событие идёт у обоих
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) {
    const active = inEvent(c, now);
    if (active !== c.eventActive) { c.eventActive = active; c.send({ t: 'event', event: eventInfo(c, now) }); }
  }
  const roundMs = schedule.roundMs;
  for (const [a, b] of mm.pairsOlderThan(roundMs, now)) {
    if (!a.eventActive || !b.eventActive || a.direct || b.direct) continue;
    a.send({ t: 'round_end' });
    mm.leave(a, { t: 'round_end' }, now); // b получит round_end как уведомление о разрыве
    mm.enqueue(a, now);
    mm.enqueue(b, now);
  }
}, 1_000).unref();

// «Позовите, когда соберутся»: раз в минуту считаем онлайн по языкам и зовём подписчиков, если людей ≥ CROWD_MIN
let crowdBusy = false;
setInterval(async () => {
  if (!bot || crowdBusy) return;
  const perLang = new Map();
  for (const c of clients.values()) for (const l of c.langs || []) perLang.set(l, (perLang.get(l) || 0) + 1);
  const now = Date.now();
  const batch = [];
  for (const [lang, n] of perLang) {
    if (n < CROWD_MIN) continue;
    for (const u of db.crowdAudience(lang, now)) {
      if (clients.has(u.id) || batch.some(b => b.id === u.id)) continue;
      db.markCrowdNotified(u.id, now);
      batch.push({ ...u, n, spoken: lang });
    }
  }
  if (!batch.length) return;
  crowdBusy = true;
  try {
    console.log(`crowd: зовём ${batch.length}`);
    await bot.notifyCrowd(batch);
    for (const u of batch) db.event('crowd_notify', u.id, u.n, u.spoken);
  } catch (e) { console.error('crowd:', e.message); }
  crowdBusy = false;
}, 60_000).unref();

// Напоминания об Aura Hour — по часовым поясам, за 5 минут до местного начала
const reminded = new Set();
setInterval(() => {
  if (!bot) return;
  const now = Date.now();
  const zones = new Set([DEFAULT_TZ, ...db.eventTimezones(now)]);
  for (const tz of zones) {
    const key = scheduleFor(tz).reminderDue(now);
    if (!key || reminded.has(`${tz}:${key}`)) continue;
    reminded.add(`${tz}:${key}`);
    const users = db.eventAudience(now, tz, DEFAULT_TZ).filter(u => !clients.has(u.id));
    if (users.length) bot.remindEvent(users).catch(e => console.error('remind:', e.message));
  }
  if (reminded.size > 500) reminded.clear();
}, 30_000).unref();

// Aura Wrapped: в воскресенье в 19:00 по времени аудитории — недельные итоги в бот (один раз за неделю)
const wrappedFile = path.join(DATA_DIR, 'wrapped.week');
setInterval(() => {
  if (!bot) return;
  const local = new Date(Date.now() + cfg.tzOffset * HOUR);
  if (local.getUTCDay() !== 0 || local.getUTCHours() < 19) return;
  const key = localDay(Date.now(), cfg.tzOffset);
  let last = '';
  try { last = fs.readFileSync(wrappedFile, 'utf8'); } catch {}
  if (last === key) return;
  try { fs.writeFileSync(wrappedFile, key); } catch {}
  bot.sendWrapped(db.weeklyAudience().filter(u => !clients.has(u.id))).catch(e => console.error('wrapped:', e.message));
}, 60_000).unref();

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
