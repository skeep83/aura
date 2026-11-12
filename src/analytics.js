// Aura analytics v1 — реализация спеки aura-analytics-spec (HOM-8).
// Хранение: те же SQLite-файлы, новые таблицы + миграция users без удаления старых строк.
// Старые события (events) остаются как есть и НЕ выдаются за новые; сырые legacy
// выгружаются отдельным файлом legacy_events.csv с event_schema_version=0.
//
// Соответствие старой схеме (README реализации):
// - users.id (TEXT) = Telegram user id, он же «внутренний PK» (спека §7.3: legacy ref_<id>
//   содержал ref_code или tg id — resolveRef проверяет оба); r1_<base36> кодирует числовой id.
// - «разговор» = пара matchmaker'а: каноническое начало — первый conn_ok в паре
//   (talk_started_at), конец — первый onUnpair/ws-close той же пары (call_end).
// - aura_hour_join = вход в поиск (mm.enqueue) в окне 20:45–21:30 UTC (рабочая конвенция спеки;
//   фактический Aura Hour идёт в 21:00 по TZ_OFFSET — окно настраивается env без переписывания событий).
// - onboarding_complete v1: gender ∈ {m,f} + непустые языки (явной «цели» в UI нет — отклонение
//   зафиксировано в спеке §2 как допустимое).
// - payment_success: Telegram Stars, amount_minor = stars, currency = XTR, provider = telegram_stars.
// - dev-пользователи (DEV_ALLOW_ANON, тесты) получают is_test=1 автоматически.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { staticRegistry, resolveStartParam, referralAttribution, REGISTRY_REVISION, CAMPAIGN } from './attribution.js';

const DAY = 24 * 60 * 60 * 1000;
const iso = ms => new Date(ms).toISOString().replace(/(\.\d{3})Z$/, '$1Z');
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

export const ACTIVATE_MS = 30_000;   // решение CEO, порог не менять
export const GOOD_MS = 120_000;      // решение CEO, порог не менять

export function normalizePlatform(p) {
  const s = String(p || '').toLowerCase();
  if (s === 'ios') return 'ios';
  if (s.startsWith('android')) return 'android';
  if (['tdesktop', 'macos', 'windows', 'linux', 'weba', 'webk', 'web', 'unigram'].includes(s)) return 'desktop';
  return 'unknown';
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS attribution_tokens (
    token TEXT PRIMARY KEY,
    utm_source TEXT NOT NULL, utm_medium TEXT NOT NULL, utm_campaign TEXT NOT NULL,
    utm_content TEXT, placement_id TEXT, creative_id TEXT,
    referrer_id TEXT, legacy INTEGER NOT NULL DEFAULT 0,
    created_at_utc TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events_v2 (
    event_id TEXT PRIMARY KEY,
    event_name TEXT NOT NULL,
    occurred_at_utc TEXT NOT NULL,
    ingested_at_utc TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    utm_source TEXT NOT NULL DEFAULT 'unknown',
    utm_medium TEXT, utm_campaign TEXT, utm_content TEXT,
    placement_id TEXT, creative_id TEXT, referrer_id TEXT,
    app_version TEXT, platform TEXT,
    event_schema_version INTEGER NOT NULL DEFAULT 1,
    is_test INTEGER NOT NULL DEFAULT 0,
    properties_json TEXT,
    call_id TEXT, duration_ms INTEGER, threshold_at_utc TEXT, payment_id TEXT,
    snapshot_minute_utc TEXT, searching_users INTEGER
  );
  CREATE INDEX IF NOT EXISTS ev2_name_at ON events_v2 (event_name, occurred_at_utc, user_id);
  CREATE INDEX IF NOT EXISTS ev2_user_at ON events_v2 (user_id, occurred_at_utc);
  CREATE UNIQUE INDEX IF NOT EXISTS ev2_once_fua ON events_v2 (user_id) WHERE event_name = 'first_useful_action';
  CREATE UNIQUE INDEX IF NOT EXISTS ev2_once_d1 ON events_v2 (user_id) WHERE event_name = 'return_d1';
  CREATE UNIQUE INDEX IF NOT EXISTS ev2_once_d7 ON events_v2 (user_id) WHERE event_name = 'return_d7';
  CREATE UNIQUE INDEX IF NOT EXISTS ev2_good ON events_v2 (user_id, call_id) WHERE event_name = 'good_conversation';
  CREATE UNIQUE INDEX IF NOT EXISTS ev2_snapshot ON events_v2 (snapshot_minute_utc) WHERE event_name = 'searching_concurrency';
  CREATE UNIQUE INDEX IF NOT EXISTS ev2_hour ON events_v2 (user_id, substr(occurred_at_utc, 1, 10)) WHERE event_name = 'aura_hour_join';
  CREATE UNIQUE INDEX IF NOT EXISTS ev2_payment ON events_v2 (payment_id) WHERE event_name = 'payment_success';
  CREATE TABLE IF NOT EXISTS calls (
    call_id TEXT PRIMARY KEY,
    user_a TEXT NOT NULL, user_b TEXT NOT NULL,
    session_a TEXT, session_b TEXT,
    matched_at INTEGER, conn_ok_at INTEGER, talk_started_at INTEGER,
    ended_at INTEGER, duration_ms INTEGER, end_reason TEXT,
    clock_fallback INTEGER NOT NULL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS calls_users ON calls (user_a, ended_at);
  CREATE TABLE IF NOT EXISTS referrals (
    invitee_user_id TEXT PRIMARY KEY,
    referrer_id TEXT NOT NULL,
    invite_token TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    activated_at INTEGER,
    reward_status TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE TABLE IF NOT EXISTS search_states (
    user_id TEXT PRIMARY KEY,
    entered_at INTEGER NOT NULL,
    left_at INTEGER
  );
`;

const USER_COLUMNS = {
  first_touch_confirmed_at: 'INTEGER',
  first_touch_token: 'TEXT',
  utm_source: "TEXT NOT NULL DEFAULT 'unknown'",
  utm_medium: 'TEXT', utm_campaign: 'TEXT', utm_content: 'TEXT',
  placement_id: 'TEXT', creative_id: 'TEXT',
  referrer_id: 'TEXT',
  first_validated_at: 'INTEGER',
  first_activation_at: 'INTEGER',
  onboarding_completed_at: 'INTEGER',
  is_test: 'INTEGER NOT NULL DEFAULT 0',
};

export function createAnalytics({ db, env = process.env, now = () => Date.now() } = {}) {
  const d = db.db;
  d.exec(SCHEMA);
  const have = new Set(d.prepare('PRAGMA table_info(users)').all().map(c => c.name));
  for (const [col, def] of Object.entries(USER_COLUMNS)) {
    if (!have.has(col)) d.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
  }
  const APP_VERSION = String(env.APP_VERSION || readVersionFile(env) || 'dev').slice(0, 40);
  const HOUR_START = Number(env.AURA_HOUR_START_MIN ?? 20 * 60 + 45);
  const HOUR_END = Number(env.AURA_HOUR_END_MIN ?? 21 * 60 + 30);

  // Реестр: статика из кода (versioned) + постоянные строки в БД для выгрузки.
  const registry = new Map();
  {
    const ins = d.prepare('INSERT OR IGNORE INTO attribution_tokens (token,utm_source,utm_medium,utm_campaign,utm_content,placement_id,creative_id,referrer_id,legacy,created_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const r of staticRegistry()) {
      registry.set(r.token, r);
      ins.run(r.token, r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.placement_id, r.creative_id, r.referrer_id, r.legacy, iso(now()));
    }
  }

  const tx = fn => { d.exec('BEGIN IMMEDIATE'); try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; } };

  const stmt = {
    user: d.prepare('SELECT * FROM users WHERE id = ?'),
    touch: d.prepare('UPDATE users SET is_test = MAX(is_test, ?) WHERE id = ?'),
    firstTouch: d.prepare(`UPDATE users SET first_touch_confirmed_at = ?, first_touch_token = ?,
        utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_content = ?, placement_id = ?, creative_id = ?,
        referrer_id = ?, first_validated_at = COALESCE(first_validated_at, ?)
      WHERE id = ? AND first_touch_confirmed_at IS NULL`),
    validatedAt: d.prepare('UPDATE users SET first_validated_at = COALESCE(first_validated_at, ?) WHERE id = ?'),
    evict: d.prepare('INSERT OR IGNORE INTO events_v2 (event_id,event_name,occurred_at_utc,ingested_at_utc,user_id,session_id,utm_source,utm_medium,utm_campaign,utm_content,placement_id,creative_id,referrer_id,app_version,platform,is_test,properties_json,call_id,duration_ms,threshold_at_utc,payment_id,snapshot_minute_utc,searching_users) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    activated: d.prepare('UPDATE users SET first_activation_at = ? WHERE id = ? AND first_activation_at IS NULL'),
    onboarded: d.prepare('UPDATE users SET onboarding_completed_at = ? WHERE id = ? AND onboarding_completed_at IS NULL'),
    refCandidate: d.prepare('INSERT OR IGNORE INTO referrals (invitee_user_id,referrer_id,invite_token,opened_at) VALUES (?,?,?,?)'),
    refRow: d.prepare('SELECT * FROM referrals WHERE invitee_user_id = ?'),
    refReward: d.prepare("UPDATE referrals SET activated_at = ?, reward_status = ? WHERE invitee_user_id = ? AND reward_status = 'pending'"),
    callNew: d.prepare('INSERT OR IGNORE INTO calls (call_id,user_a,user_b,session_a,session_b,matched_at) VALUES (?,?,?,?,?,?)'),
    callConn: d.prepare('UPDATE calls SET conn_ok_at = COALESCE(conn_ok_at, ?), talk_started_at = COALESCE(talk_started_at, ?), verified = 1 WHERE call_id = ? AND talk_started_at IS NULL'),
    callEnd: d.prepare('UPDATE calls SET ended_at = ?, duration_ms = ?, end_reason = ?, clock_fallback = ? WHERE call_id = ? AND ended_at IS NULL'),
    callGet: d.prepare('SELECT * FROM calls WHERE call_id = ?'),
    searchIn: d.prepare('INSERT INTO search_states (user_id,entered_at,left_at) VALUES (?,?,NULL) ON CONFLICT(user_id) DO UPDATE SET entered_at = excluded.entered_at, left_at = NULL'),
    searchOut: d.prepare('UPDATE search_states SET left_at = ? WHERE user_id = ? AND left_at IS NULL'),
    searchCount: d.prepare('SELECT COUNT(*) AS n FROM search_states WHERE entered_at <= ? AND (left_at IS NULL OR left_at > ?)'),
    ev2count: d.prepare("SELECT COUNT(*) AS n FROM events_v2 WHERE event_name = ? AND user_id = ?"),
  };

  function isTest(userId) { return String(userId).startsWith('dev-') ? 1 : 0; }

  function attrsOf(u) {
    if (!u || u.first_touch_confirmed_at == null) {
      return { utm_source: 'unknown', utm_medium: null, utm_campaign: null, utm_content: null, placement_id: null, creative_id: null, referrer_id: null };
    }
    return { utm_source: u.utm_source || 'unknown', utm_medium: u.utm_medium, utm_campaign: u.utm_campaign, utm_content: u.utm_content, placement_id: u.placement_id, creative_id: u.creative_id, referrer_id: u.referrer_id };
  }

  // Вставка события по контракту §1. event_id — UUIDv4, повтор гасится UNIQUE.
  // Возвращает true, если строка новая.
  function insertEvent({ eventName, userId, sessionId = null, at = now(), attrs, platform = 'unknown', props = null, callId = null, durationMs = null, thresholdAtUtc = null, paymentId = null, snapshotMinuteUtc = null, searchingUsers = null }) {
    const u = userId && userId !== '0' ? stmt.user.get(userId) : null;
    const a = attrs || attrsOf(u);
    const t = now();
    try {
      return stmt.evict.run(crypto.randomUUID(), eventName, iso(at), iso(t), String(userId), sessionId,
        a.utm_source || 'unknown', a.utm_medium || null, a.utm_campaign || null, a.utm_content || null,
        a.placement_id || null, a.creative_id || null, a.referrer_id ?? (u?.referrer_id ?? null),
        APP_VERSION, platform, u?.is_test ?? isTest(userId), props ? JSON.stringify(props) : null,
        callId, durationMs, thresholdAtUtc, paymentId, snapshotMinuteUtc, searchingUsers).changes > 0;
    } catch (e) {
      // бизнес-ключ (partial unique) погасил дубль бизнес-факта — штатно
      if (String(e.message).includes('UNIQUE')) return false;
      throw e;
    }
  }

  // ---------- Реферальный mapping (спека §7.3) ----------
  // r1_<base36(id)> и legacy ref_<ref_code|tg id> → внутренний id или null.
  function referralResolver(key) {
    if (typeof key === 'number') return db.exists(String(key)) ? String(key) : null;
    return db.resolveRef(String(key).slice(0, 40));
  }

  // ---------- Handshake: валидированный initData ----------
  // kind: 'initdata' (подпись Telegram проверена) | 'session' (наша подписанная сессия)
  // | 'web_anon' (анонимный браузерный вход, HOM-31 — не смешивать с Telegram-когортами)
  // Возвращает { sessionId, token, resolution } — attrs для последующих событий этой сессии.
  function onValidatedOpen({ userId, startParam = '', kind, at = now(), platform = 'unknown', appVersion = APP_VERSION }) {
    db.user(userId, at);
    if (isTest(userId)) stmt.touch.run(1, userId);
    const sessionId = crypto.randomUUID();
    const u = stmt.user.get(userId);
    let resolution = null;
    if (startParam) {
      resolution = resolveStartParam(String(startParam).slice(0, 64), registry, referralResolver);
      if (!resolution) insertEvent({ eventName: 'invalid_start_token', userId, sessionId, at, platform, props: { token_format_ok: /^[A-Za-z0-9_-]{1,64}$/.test(startParam) ? 1 : 0 } });
    }
    if (resolution && resolution.referrerId === userId) resolution = null; // self-invite не источник
    tx(() => {
      if (resolution) {
        const a = resolution.utm;
        stmt.firstTouch.run(at, resolution.token, a.utm_source, a.utm_medium, a.utm_campaign, a.utm_content, a.placement_id, a.creative_id, resolution.referrerId || null, at, userId);
      }
      stmt.validatedAt.run(at, userId);
    });
    const fresh = stmt.user.get(userId);
    const attrs = attrsOf(fresh);
    const entryToken = resolution ? resolution.token : '';
    insertEvent({ eventName: kind === 'initdata' ? 'init_validated' : 'mini_app_open', userId, sessionId, at, attrs, platform, props: { auth_date: Math.floor(at / 1000), auth_kind: kind } });
    insertEvent({ eventName: 'mini_app_open', userId, sessionId, at, attrs, platform, props: { entry_token: entryToken, open_id: crypto.randomUUID() } });
    insertEvent({ eventName: 'session', userId, sessionId, at, attrs, platform });
    // Реферальный кандидат закрепляется при первом валидном реферальном открытии (до активации)
    if (resolution?.kind === 'referral' && resolution.referrerId && resolution.referrerId !== userId) {
      tx(() => {
        // повторное открытие не создаёт новую кандидатуру и не дублирует invite_open
        if (stmt.refCandidate.run(userId, resolution.referrerId, resolution.token, at).changes > 0) {
          insertEvent({ eventName: 'invite_open', userId, sessionId, at, platform, props: { referrer_id: resolution.referrerId, invite_token: resolution.token, invitee_user_id: userId } });
        }
      });
    }
    // D1/D7: по первому авторизованному открытию в нужный UTC-день
    if (fresh.first_activation_at) {
      const cohortDay = utcDay(fresh.first_activation_at);
      const today = utcDay(at);
      for (const [n, name] of [[1, 'return_d1'], [7, 'return_d7']]) {
        const want = utcDay(fresh.first_activation_at + n * DAY);
        if (today === want && cohortDay !== today) {
          insertEvent({ eventName: name, userId, sessionId, at, attrs, platform, props: { cohort_date_utc: cohortDay, return_date_utc: today } });
        }
      }
    }
    return { sessionId, resolution, attrs };
  }

  // ---------- Звонки ----------
  function onMatch({ callId, a, b, sessionA, sessionB, at = now() }) {
    stmt.callNew.run(callId, a, b, sessionA, sessionB, at);
    for (const [u, s] of [[a, sessionA], [b, sessionB]]) {
      insertEvent({ eventName: 'match', userId: u, sessionId: s, at, callId: callId });
    }
  }
  function onConnOk({ callId, userId, at = now() }) {
    const call = stmt.callGet.get(callId);
    if (!call || call.ended_at != null) return;
    stmt.callConn.run(at, at, callId);
    insertEvent({ eventName: 'conn_ok', userId, sessionId: userId === call.user_a ? call.session_a : call.session_b, at, callId });
    insertEvent({ eventName: 'talk', userId, sessionId: userId === call.user_a ? call.session_a : call.session_b, at, callId, props: { talk_started_at_utc: iso(call.talk_started_at ?? at) } });
  }
  function onCallEnd({ callId, at = now(), reason = 'unpair' }) {
    const call = stmt.callGet.get(callId);
    if (!call || call.ended_at != null) return;
    let durationMs = null, clockFallback = 0;
    if (call.talk_started_at != null) {
      durationMs = Math.max(0, at - call.talk_started_at);
    } else if (call.matched_at != null) {
      // разговор не доказан (не было conn_ok): длительность не считаем активационной
      clockFallback = 1;
    }
    stmt.callEnd.run(at, durationMs, reason, clockFallback, callId);
    const verified = call.talk_started_at != null ? 1 : 0;
    for (const [u, s] of [[call.user_a, call.session_a], [call.user_b, call.session_b]]) {
      insertEvent({ eventName: 'call_end', userId: u, sessionId: s, at: at, callId, durationMs, props: { end_reason: reason, clock_fallback: clockFallback, verification_status: verified ? 'verified' : 'duration_unknown' } });
      if (!verified || durationMs == null) continue;
      const thresholdAt = call.talk_started_at + ACTIVATE_MS;
      if (durationMs >= ACTIVATE_MS) {
        // Активация: первая в жизни, одной транзакцией с реферальной наградой
        tx(() => {
          const inserted = insertEvent({ eventName: 'first_useful_action', userId: u, sessionId: s, at: thresholdAt, callId, durationMs, thresholdAtUtc: iso(thresholdAt) });
          if (!inserted) return;
          stmt.activated.run(thresholdAt, u);
          const ref = stmt.refRow.get(u);
          if (ref && ref.reward_status === 'pending' && ref.referrer_id !== u) {
            const already = db.user(u).referred_by === ref.referrer_id; // legacy-награда на открытии уже выдана
            if (!already) {
              db.grantPremium(ref.referrer_id, Number(env.REFERRAL_PREMIUM_DAYS || 1), at);
              db.grantPremium(u, Number(env.REFERRAL_PREMIUM_DAYS || 1), at);
            }
            stmt.refReward.run(thresholdAt, already ? 'granted_on_open' : 'granted', u);
            insertEvent({ eventName: 'referred_first_useful_action', userId: ref.referrer_id, sessionId: s, at: thresholdAt, callId, props: { invitee_user_id: u, referrer_id: ref.referrer_id, call_id: callId, reward_status: already ? 'granted_on_open' : 'granted' } });
          }
        });
      }
      if (durationMs >= GOOD_MS) {
        const goodAt = call.talk_started_at + GOOD_MS;
        insertEvent({ eventName: 'good_conversation', userId: u, sessionId: s, at: goodAt, callId, durationMs, thresholdAtUtc: iso(goodAt) });
      }
    }
  }

  // ---------- Поиск: aura_hour_join + состояние для снапшотов ----------
  function onSearchEnter({ userId, sessionId = null, at = now(), platform = 'unknown' }) {
    stmt.searchIn.run(userId, at);
    const mins = new Date(at).getUTCHours() * 60 + new Date(at).getUTCMinutes();
    if (mins >= HOUR_START && mins <= HOUR_END) {
      insertEvent({ eventName: 'aura_hour_join', userId, sessionId, at, platform, props: { hour_date_utc: utcDay(at) } });
    }
  }
  function onSearchLeave({ userId, at = now() }) { stmt.searchOut.run(at, userId); }

  // ---------- Онбординг ----------
  function onProfileSaved({ userId, sessionId = null, at = now(), platform = 'unknown' }) {
    const u = stmt.user.get(userId);
    if (!u || u.onboarding_completed_at != null) return false;
    if (!['m', 'f'].includes(u.gender) || !String(u.langs || '').split(',').filter(Boolean).length) return false;
    if (stmt.onboarded.run(at, userId).changes === 0) return false;
    insertEvent({ eventName: 'onboarding_complete', userId, sessionId, at, platform, props: { onboarding_version: 'v1' } });
    return true;
  }

  // ---------- Платежи ----------
  function paymentSuccess({ userId, paymentId, amountMinor, currency = 'XTR', provider = 'telegram_stars', at = now(), sessionId = null }) {
    return insertEvent({ eventName: 'payment_success', userId, sessionId, at, paymentId, props: { payment_id: paymentId, amount_minor: amountMinor, currency, provider, status: 'success' } });
  }

  // ---------- Снапшот одновременности ----------
  function searchingSnapshot({ at = now() }) {
    const minute = Math.floor(at / 60_000) * 60_000;
    const n = stmt.searchCount.get(minute, minute).n;
    return insertEvent({
      eventName: 'searching_concurrency', userId: '0', sessionId: `job:${utcDay(at).replaceAll('-', '')}`, at: minute,
      platform: 'system', attrs: { utm_source: 'unknown' },
      snapshotMinuteUtc: iso(minute), searchingUsers: n, props: { snapshot_minute_utc: iso(minute), searching_users: n, sampling_status: 'ok' },
    });
  }

  // Восстановление после рестарта: незакрытые поисковые состояния закрываем временем старта
  function recoverSearchStates(at = now()) { d.prepare('UPDATE search_states SET left_at = ? WHERE left_at IS NULL').run(at); }

  // Касание из Bot API update (/start с токеном): tg id взят из настоящего апдейта —
  // тоже может зафиксировать first touch, если токен есть в реестре.
  function touchFromBot({ userId, startParam = '', at = now() }) {
    db.user(userId, at);
    if (!startParam) return null;
    const resolution = resolveStartParam(String(startParam).slice(0, 64), registry, referralResolver);
    if (!resolution) { insertEvent({ eventName: 'invalid_start_token', userId, at, platform: 'unknown', props: { via: 'bot_start' } }); return null; }
    if (resolution.referrerId === userId) return resolution;
    tx(() => {
      const a = resolution.utm;
      stmt.firstTouch.run(at, resolution.token, a.utm_source, a.utm_medium, a.utm_campaign, a.utm_content, a.placement_id, a.creative_id, resolution.referrerId || null, at, userId);
      stmt.validatedAt.run(at, userId);
    });
    return resolution;
  }

  return {
    APP_VERSION, REGISTRY_REVISION, CAMPAIGN, registry,
    insertEvent, onValidatedOpen, onMatch, onConnOk, onCallEnd,
    onSearchEnter, onSearchLeave, searchingSnapshot, recoverSearchStates,
    onProfileSaved, paymentSuccess, attrsOf, isTest, tx,
  };
}

function readVersionFile(env) {
  try { return fs.readFileSync(`${env.DATA_DIR || 'data'}/VERSION`, 'utf8').trim(); } catch { return ''; }
}
