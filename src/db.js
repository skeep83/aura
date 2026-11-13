import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DAY = 24 * 60 * 60 * 1000;
export const FOREVER = 8.64e15;

// Новые колонки добавляются миграцией, чтобы не терять данные существующих установок
const USER_COLUMNS = {
  langs: "TEXT NOT NULL DEFAULT ''",
  name: "TEXT NOT NULL DEFAULT ''",
  username: "TEXT NOT NULL DEFAULT ''",
  allows_pm: 'INTEGER NOT NULL DEFAULT 0',
  notify_events: 'INTEGER NOT NULL DEFAULT 1',
  karma_up: 'INTEGER NOT NULL DEFAULT 0',
  karma_down: 'INTEGER NOT NULL DEFAULT 0',
  streak: 'INTEGER NOT NULL DEFAULT 0',
  streak_day: "TEXT NOT NULL DEFAULT ''",
  filter_day: "TEXT NOT NULL DEFAULT ''",
  filter_used: 'INTEGER NOT NULL DEFAULT 0',
  referred_by: "TEXT NOT NULL DEFAULT ''",
  referrals: 'INTEGER NOT NULL DEFAULT 0',
  last_seen: 'INTEGER NOT NULL DEFAULT 0',
  lang: "TEXT NOT NULL DEFAULT ''",
  reveal: 'INTEGER NOT NULL DEFAULT 0',
  aura_bonus: 'INTEGER NOT NULL DEFAULT 0',
  salutes: 'INTEGER NOT NULL DEFAULT 0',
  salutes_received: 'INTEGER NOT NULL DEFAULT 0',
  country: "TEXT NOT NULL DEFAULT ''",
  source: "TEXT NOT NULL DEFAULT ''",
  ref_code: "TEXT NOT NULL DEFAULT ''",
  tz_min: 'INTEGER NOT NULL DEFAULT -10000',      // смещение от UTC в минутах; -10000 — неизвестно
  crowd_until: 'INTEGER NOT NULL DEFAULT 0',      // «позовите, когда соберутся» — подписка до
  crowd_notified_at: 'INTEGER NOT NULL DEFAULT 0',
  ex_native: "TEXT NOT NULL DEFAULT ''",          // языковой обмен: мой язык
  ex_learn: "TEXT NOT NULL DEFAULT ''",           // языковой обмен: учу
  threads_seen: 'INTEGER NOT NULL DEFAULT 0',     // сколько раз человек видел карточку нити (подсказки — первые три раза)
  pair: 'INTEGER NOT NULL DEFAULT 0',             // «вдвоём с одного телефона»
  // Веб-аккаунты (HOM-39): профиль из соцсети, мягкое слияние, способ входа
  display_name: "TEXT NOT NULL DEFAULT ''",       // имя из провайдера (у телеграмных остаётся name)
  avatar_url: "TEXT NOT NULL DEFAULT ''",
  merged_into: "TEXT NOT NULL DEFAULT ''",        // анонимный профиль слит в этот аккаунт
  auth_kind: "TEXT NOT NULL DEFAULT ''",          // telegram | web_anon | <провайдер> — последний способ входа
};

// Пользователи, жалобы, платежи, комнаты, оценки. SQLite в одном файле — хватает на один процесс.
export class Db {
  constructor(file, { reportsToBan = 3, reportBanDays = 7 } = {}) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.reportsToBan = reportsToBan;
    this.reportBanMs = reportBanDays * DAY;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        gender TEXT NOT NULL DEFAULT 'x',
        want TEXT NOT NULL DEFAULT 'any',
        premium_until INTEGER NOT NULL DEFAULT 0,
        strikes INTEGER NOT NULL DEFAULT 0,
        banned_until INTEGER NOT NULL DEFAULT 0,
        ban_reason TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        target TEXT NOT NULL,
        reporter TEXT NOT NULL,
        reason TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (target, reporter)
      );
      CREATE TABLE IF NOT EXISTS payments (
        charge_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        plan TEXT NOT NULL,
        stars INTEGER NOT NULL,
        at INTEGER NOT NULL,
        refunded INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS rooms (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        visits INTEGER NOT NULL DEFAULT 0,
        matches INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ratings (
        rater TEXT NOT NULL,
        target TEXT NOT NULL,
        value INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ratings_pair ON ratings (rater, target, at);
      CREATE TABLE IF NOT EXISTS passport (
        user_id TEXT NOT NULL,
        country TEXT NOT NULL,
        first_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, country)
      );
      CREATE TABLE IF NOT EXISTS events (
        type TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT '',
        value REAL NOT NULL DEFAULT 0,
        tag TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_type_at ON events (type, at);
      CREATE INDEX IF NOT EXISTS events_user_at ON events (user_id, at);
      CREATE TABLE IF NOT EXISTS compliments (
        target TEXT NOT NULL,
        from_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS compliments_target ON compliments (target, at);
      CREATE TABLE IF NOT EXISTS live_subs (
        code TEXT NOT NULL,
        user_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (code, user_id)
      );
      CREATE TABLE IF NOT EXISTS friends (
        a TEXT NOT NULL,
        b TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (a, b)
      );
      -- HOM-39: внешние входы. Один аккаунт (users.id) — сколько угодно привязок.
      CREATE TABLE IF NOT EXISTS identities (
        provider      TEXT NOT NULL,          -- telegram | google | yandex | vk | email
        provider_uid  TEXT NOT NULL,          -- id пользователя у провайдера (для email — нормализованный адрес)
        user_id       TEXT NOT NULL,          -- users.id
        email         TEXT NOT NULL DEFAULT '',
        email_verified INTEGER NOT NULL DEFAULT 0,
        name          TEXT NOT NULL DEFAULT '',
        avatar        TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL,
        PRIMARY KEY (provider, provider_uid)
      );
      CREATE INDEX IF NOT EXISTS identities_user ON identities (user_id);
    `);
    const have = new Set(this.db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
    for (const [col, def] of Object.entries(USER_COLUMNS)) {
      if (!have.has(col)) this.db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS users_ref_code ON users (ref_code) WHERE ref_code != ''");
  }

  exists(id) { return Boolean(this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)); }
  matchCount(id) { return this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'match' AND user_id = ?").get(id).n; }

  user(id, now = Date.now()) {
    this.db.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(id, now);
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  // Данные из Telegram при каждом входе
  touch(id, { name = '', username = '', allowsPm = false, lang = '' } = {}, now = Date.now()) {
    this.user(id, now);
    this.db.prepare('UPDATE users SET name = ?, username = ?, allows_pm = MAX(allows_pm, ?), last_seen = ?, lang = ? WHERE id = ?')
      .run(name, username, allowsPm ? 1 : 0, now, String(lang || '').slice(0, 5), id);
  }

  setProfile(id, { gender, want, langs }) {
    this.db.prepare('UPDATE users SET gender = ?, want = ?, langs = ? WHERE id = ?').run(gender, want, langs.join(','), id);
  }

  setExchange(id, ex) {
    this.db.prepare('UPDATE users SET ex_native = ?, ex_learn = ? WHERE id = ?').run(ex?.native || '', ex?.learn || '', id);
  }
  setReveal(id, on) { this.db.prepare('UPDATE users SET reveal = ? WHERE id = ?').run(on ? 1 : 0, id); }
  setPair(id, on) { this.db.prepare('UPDATE users SET pair = ? WHERE id = ?').run(on ? 1 : 0, id); }
  setCountry(id, country) { this.db.prepare('UPDATE users SET country = ? WHERE id = ?').run(country, id); }

  // ---------- Паспорт: страны, с которыми поговорил ----------
  // true, если страна новая для пользователя
  stamp(id, country, now = Date.now()) {
    if (!/^[A-Z]{2}$/.test(country || '') || ['XX', 'T1'].includes(country)) return false;
    return this.db.prepare('INSERT OR IGNORE INTO passport (user_id, country, first_at) VALUES (?, ?, ?)').run(id, country, now).changes > 0;
  }
  passport(id) {
    return this.db.prepare('SELECT country FROM passport WHERE user_id = ? ORDER BY first_at').all(id).map(r => r.country);
  }

  // ---------- Метрики ----------
  event(type, userId = '', value = 0, tag = '', now = Date.now()) {
    this.db.prepare('INSERT INTO events (type, user_id, value, tag, at) VALUES (?, ?, ?, ?, ?)').run(type, userId, value, tag, now);
  }

  // Воронка за последние сутки
  funnel(now = Date.now()) {
    const since = now - DAY;
    const q = (sql, ...a) => this.db.prepare(sql).get(...a);
    const count = type => q('SELECT COUNT(*) AS n FROM events WHERE type = ? AND at > ?', type, since).n;
    const values = type => this.db.prepare('SELECT value FROM events WHERE type = ? AND at > ? ORDER BY value').all(type, since).map(r => r.value);
    const median = arr => arr.length ? arr[Math.floor(arr.length / 2)] : 0;
    const ttm = values('match');
    const calls = values('call_end');
    const dau = q("SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE type = 'session' AND at > ?", since).n;
    const fresh = q('SELECT COUNT(*) AS n FROM users WHERE created_at > ?', since).n;
    // D1: из пришедших позавчера-вчера (сутки назад ± сутки) — кто заходил за последние сутки
    const cohort = this.db.prepare('SELECT id FROM users WHERE created_at > ? AND created_at <= ?').all(now - 2 * DAY, since).map(r => r.id);
    const back = cohort.filter(id => q("SELECT 1 AS n FROM events WHERE type = 'session' AND user_id = ? AND at > ? LIMIT 1", id, since)).length;
    const sources = this.db.prepare("SELECT tag, COUNT(*) AS n FROM events WHERE type = 'session' AND at > ? GROUP BY tag ORDER BY n DESC LIMIT 5").all(since);
    return {
      dau, newUsers: fresh,
      matches: ttm.length,
      ttmMedianSec: Math.round(median(ttm) / 100) / 10,
      callMedianSec: Math.round(median(calls) / 1000),
      quickSkipPct: calls.length ? Math.round(100 * calls.filter(v => v < 5000).length / calls.length) : 0,
      vibes: count('vibe'), vibeMatches: count('vibe_match'),
      reports: count('report'), ageBlocks: count('age_block'), nsfwStrikes: count('nsfw'),
      connFailPct: (count('conn_ok') + count('conn_fail')) ? Math.round(100 * count('conn_fail') / (count('conn_ok') + count('conn_fail'))) : 0,
      premiumBuys: count('premium'), stars: q("SELECT COALESCE(SUM(value), 0) AS n FROM events WHERE type = 'premium' AND at > ?", since).n,
      d1: cohort.length ? `${Math.round(100 * back / cohort.length)}% (${back}/${cohort.length})` : '—',
      sources: sources.map(s => `${s.tag || 'direct'}: ${s.n}`).join(', ') || '—',
    };
  }

  setNotify(id, on) { this.db.prepare('UPDATE users SET notify_events = ? WHERE id = ?').run(on ? 1 : 0, id); }
  setAllowsPm(id) { this.db.prepare('UPDATE users SET allows_pm = 1 WHERE id = ?').run(id); }

  isPremium(u, now = Date.now()) { return u.premium_until > now; }
  bannedUntil(id, now = Date.now()) {
    const u = this.user(id, now);
    return u.banned_until > now ? u.banned_until : 0;
  }

  ban(id, ms, reason, now = Date.now()) {
    this.user(id, now);
    const until = ms === Infinity ? FOREVER : now + ms;
    this.db.prepare('UPDATE users SET banned_until = ?, ban_reason = ?, strikes = 0 WHERE id = ?').run(until, reason, id);
    return until;
  }

  unban(id) {
    this.db.prepare('UPDATE users SET banned_until = 0, ban_reason = NULL, strikes = 0 WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM reports WHERE target = ?').run(id);
  }

  // Жалоба: при достижении порога за 7 дней — бан. Возвращает срок бана или 0.
  report(target, reporter, reason, now = Date.now()) {
    this.user(target, now);
    this.db.prepare('INSERT OR IGNORE INTO reports (target, reporter, reason, at) VALUES (?, ?, ?, ?)')
      .run(target, reporter, reason, now);
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE target = ? AND at > ?')
      .get(target, now - 7 * DAY);
    if (n < this.reportsToBan) return 0;
    this.db.prepare('DELETE FROM reports WHERE target = ?').run(target);
    return this.ban(target, this.reportBanMs, 'reports', now);
  }

  strike(id) {
    this.user(id);
    this.db.prepare('UPDATE users SET strikes = strikes + 1 WHERE id = ?').run(id);
    return this.db.prepare('SELECT strikes FROM users WHERE id = ?').get(id).strikes;
  }

  // ---------- Premium ----------
  grantPremium(id, days, now = Date.now()) {
    const u = this.user(id, now);
    const until = Math.max(u.premium_until, now) + days * DAY;
    this.db.prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(until, id);
    return until;
  }

  // Запись платежа; true — новый (повторная доставка того же charge_id игнорируется)
  recordPayment({ chargeId, userId, plan, stars }, now = Date.now()) {
    return this.db.prepare('INSERT OR IGNORE INTO payments (charge_id, user_id, plan, stars, at) VALUES (?, ?, ?, ?, ?)')
      .run(chargeId, userId, plan, stars, now).changes > 0;
  }

  // Начисляет премиум; повторная доставка того же платежа игнорируется.
  addPayment({ chargeId, userId, plan, stars, days }, now = Date.now()) {
    if (!this.recordPayment({ chargeId, userId, plan, stars }, now)) return this.user(userId).premium_until;
    return this.grantPremium(userId, days, now);
  }

  // ---------- Салюты: покупаются пачками, получатель копит счётчик ----------
  addSalutes(id, n) { this.user(id); this.db.prepare('UPDATE users SET salutes = salutes + ? WHERE id = ?').run(n, id); }
  spendSalute(id) { return this.db.prepare('UPDATE users SET salutes = salutes - 1 WHERE id = ? AND salutes > 0').run(id).changes > 0; }
  receiveSalute(id) {
    this.user(id);
    this.db.prepare('UPDATE users SET salutes_received = salutes_received + 1 WHERE id = ?').run(id);
    return this.db.prepare('SELECT salutes_received AS n FROM users WHERE id = ?').get(id).n;
  }
  addAuraBonus(id, n) { this.user(id); this.db.prepare('UPDATE users SET aura_bonus = aura_bonus + ? WHERE id = ?').run(n, id); }

  // ---------- Комплименты: один от человека человеку в сутки ----------
  compliment(fromId, target, kind, now = Date.now()) {
    if (fromId === target) return false;
    const recent = this.db.prepare('SELECT 1 FROM compliments WHERE from_id = ? AND target = ? AND at > ?').get(fromId, target, now - DAY);
    if (recent) return false;
    this.db.prepare('INSERT INTO compliments (target, from_id, kind, at) VALUES (?, ?, ?, ?)').run(target, fromId, kind, now);
    return true;
  }
  complimentsOf(id, since = 0) {
    const out = {};
    for (const r of this.db.prepare('SELECT kind, COUNT(*) AS n FROM compliments WHERE target = ? AND at > ? GROUP BY kind').all(id, since)) out[r.kind] = r.n;
    return out;
  }

  // ---------- Aura Wrapped: итоги недели и «тип ауры» ----------
  wrapped(id, now = Date.now()) {
    const since = now - 7 * DAY;
    const one = (sql, ...a) => this.db.prepare(sql).get(...a).n;
    const chats = one("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'match' AND at > ?", id, since);
    const talkMs = one("SELECT COALESCE(SUM(value), 0) AS n FROM events WHERE user_id = ? AND type = 'talk' AND at > ?", id, since);
    const vibes = one("SELECT COUNT(*) AS n FROM events WHERE user_id = ? AND type = 'vibe_match' AND at > ?", id, since);
    const countries = this.db.prepare('SELECT country FROM passport WHERE user_id = ? AND first_at > ? ORDER BY first_at').all(id, since).map(r => r.country);
    const compl = this.complimentsOf(id, since);
    const topCompl = Object.entries(compl).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const minutes = Math.round(talkMs / 60000);
    const avgMin = chats ? talkMs / chats / 60000 : 0;
    // Тип ауры: первое подходящее правило
    const archetype =
      countries.length >= 5 ? 'traveler'
      : vibes >= 3 ? 'magnet'
      : topCompl === 'funny' ? 'soul'
      : topCompl === 'voice' || avgMin >= 3 ? 'voice'
      : topCompl === 'smart' || topCompl === 'world' ? 'thinker'
      : topCompl === 'kind' ? 'warm'
      : topCompl === 'smile' ? 'sunny'
      : chats >= 30 ? 'tireless'
      : 'newbie';
    return { chats, minutes, vibes, countries, compliments: compl, topCompl, archetype };
  }

  // Кому прислать недельные итоги: разрешили писать, заходили за неделю
  weeklyAudience(now = Date.now()) {
    return this.db.prepare(`SELECT id, lang FROM users WHERE allows_pm = 1 AND last_seen > ? AND banned_until <= ? AND id NOT LIKE 'dev-%'`)
      .all(now - 7 * DAY, now);
  }

  payment(chargeId) {
    return this.db.prepare('SELECT * FROM payments WHERE charge_id = ?').get(chargeId);
  }

  markRefunded(chargeId, days) {
    const p = this.payment(chargeId);
    if (!p || p.refunded) return null;
    this.db.prepare('UPDATE payments SET refunded = 1 WHERE charge_id = ?').run(chargeId);
    this.db.prepare('UPDATE users SET premium_until = MAX(0, premium_until - ?) WHERE id = ?')
      .run(days * DAY, p.user_id);
    return p;
  }

  // ---------- Источники (реклама, комнаты, рефералы): первое касание и конверсии ----------
  setSource(id, source) {
    this.db.prepare("UPDATE users SET source = ? WHERE id = ? AND source = ''").run(String(source).slice(0, 64), id);
  }
  sourceStats(days = 30, now = Date.now()) {
    const since = now - days * DAY;
    const rows = this.db.prepare(`
      SELECT CASE WHEN u.source = '' THEN 'direct' ELSE u.source END AS source,
        COUNT(*) AS users,
        SUM(EXISTS(SELECT 1 FROM events e WHERE e.user_id = u.id AND e.type = 'match')) AS talked,
        SUM(EXISTS(SELECT 1 FROM events e WHERE e.user_id = u.id AND e.type = 'session' AND e.at > u.created_at + 20 * 3600000)) AS returned,
        SUM(EXISTS(SELECT 1 FROM payments p WHERE p.user_id = u.id AND p.refunded = 0)) AS payers,
        COALESCE(SUM((SELECT SUM(stars) FROM payments p WHERE p.user_id = u.id AND p.refunded = 0)), 0) AS stars
      FROM users u WHERE u.created_at > ? AND u.id NOT LIKE 'dev-%' GROUP BY 1 ORDER BY users DESC`).all(since);
    const starts = Object.fromEntries(this.db.prepare(
      "SELECT tag, COUNT(DISTINCT user_id) AS n FROM events WHERE type = 'bot_start' AND at > ? GROUP BY tag").all(since).map(r => [r.tag, r.n]));
    const landing = {};
    for (const r of this.db.prepare("SELECT type, tag, COUNT(*) AS n FROM events WHERE type IN ('landing_view','landing_click') AND at > ? GROUP BY type, tag").all(since)) {
      (landing[r.tag] ||= { views: 0, clicks: 0 })[r.type === 'landing_view' ? 'views' : 'clicks'] = r.n;
    }
    // Кампании, по которым были переходы, но ещё никто не открыл приложение — тоже показываем
    for (const tag of Object.keys(landing)) {
      const src = 'ad:' + tag.slice(3);
      if (!rows.some(r => r.source === src)) rows.push({ source: src, users: 0, talked: 0, returned: 0, payers: 0, stars: 0 });
    }
    return rows.map(r => {
      const tag = r.source === 'affiliate' ? 'affiliate' : r.source.replace(/^ad:/, 'ad_');
      return { ...r, botStarts: starts[tag] || 0, landingViews: landing[tag]?.views || 0, landingClicks: landing[tag]?.clicks || 0 };
    });
  }

  // Публичный код для ссылок (aura-life.online/r/<код>) — чтобы не светить Telegram ID в соцсетях
  refCode(id) {
    const u = this.user(id);
    if (u.ref_code) return u.ref_code;
    for (;;) {
      const code = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 7).toLowerCase();
      if (code.length < 6 || this.db.prepare('SELECT 1 FROM users WHERE ref_code = ?').get(code)) continue;
      this.db.prepare('UPDATE users SET ref_code = ? WHERE id = ?').run(code, id);
      return code;
    }
  }
  // ref_<код> или старый формат ref_<Telegram ID>
  resolveRef(ref) {
    if (!ref) return null;
    const byCode = this.db.prepare('SELECT id FROM users WHERE ref_code = ?').get(ref);
    return byCode ? byCode.id : this.exists(ref) ? ref : null;
  }

  // ---------- Друзья: появляются после взаимного вайба, хранятся в обе стороны ----------
  addFriends(a, b, now = Date.now()) {
    if (a === b) return false;
    const ins = this.db.prepare('INSERT OR IGNORE INTO friends (a, b, at) VALUES (?, ?, ?)');
    const added = ins.run(a, b, now).changes > 0;
    ins.run(b, a, now);
    return added;
  }
  removeFriend(a, b) {
    this.db.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').run(a, b, b, a);
  }
  isFriend(a, b) { return Boolean(this.db.prepare('SELECT 1 FROM friends WHERE a = ? AND b = ?').get(a, b)); }
  friendsOf(id) {
    return this.db.prepare(`SELECT u.id, u.name, u.username, u.country, u.last_seen AS lastSeen, f.at
      FROM friends f JOIN users u ON u.id = f.b WHERE f.a = ? ORDER BY u.last_seen DESC LIMIT 200`).all(id);
  }

  // ---------- Внешние входы, слияние профилей, удаление аккаунта (HOM-39) ----------

  // Слитый анонимный профиль ведёт к настоящему аккаунту. Цепочку разворачиваем до корня
  // (ограничение глубины — страховка от испорченных данных, а не ожидаемый случай).
  accountRoot(id) {
    let cur = String(id || '');
    for (let i = 0; i < 8; i++) {
      const next = this.db.prepare('SELECT merged_into AS m FROM users WHERE id = ?').get(cur)?.m || '';
      if (!next || next === cur) return cur;
      cur = next;
    }
    return cur;
  }
  isMerged(id) { return Boolean(this.db.prepare('SELECT 1 FROM users WHERE id = ? AND merged_into != \'\'').get(String(id || ''))); }

  identity(provider, uid) {
    return this.db.prepare('SELECT * FROM identities WHERE provider = ? AND provider_uid = ?').get(String(provider), String(uid)) || null;
  }
  identitiesOf(userId) {
    return this.db.prepare('SELECT provider, provider_uid, email, email_verified, name, avatar, created_at, last_login_at FROM identities WHERE user_id = ? ORDER BY created_at').all(String(userId));
  }
  hasIdentity(userId) { return Boolean(this.db.prepare('SELECT 1 FROM identities WHERE user_id = ? LIMIT 1').get(String(userId))); }

  // Привязка провайдера к аккаунту. Повторный вход тем же provider_uid только обновляет профиль:
  // переезд привязки на другой аккаунт здесь невозможен — это делает только явное слияние.
  upsertIdentity({ provider, providerUid, userId, email = '', emailVerified = false, name = '', avatar = '' }, now = Date.now()) {
    const uid = String(providerUid);
    const existing = this.identity(provider, uid);
    if (existing) {
      this.db.prepare(`UPDATE identities SET email = ?, email_verified = ?, name = ?, avatar = ?, last_login_at = ?
        WHERE provider = ? AND provider_uid = ?`)
        .run(email, emailVerified ? 1 : 0, name, avatar, now, String(provider), uid);
      return { ...this.identity(provider, uid), isNew: false };
    }
    this.user(userId, now);
    this.db.prepare(`INSERT INTO identities (provider, provider_uid, user_id, email, email_verified, name, avatar, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(String(provider), uid, String(userId), email, emailVerified ? 1 : 0, name, avatar, now, now);
    return { ...this.identity(provider, uid), isNew: true };
  }
  unlinkIdentity(provider, uid) {
    return this.db.prepare('DELETE FROM identities WHERE provider = ? AND provider_uid = ?').run(String(provider), String(uid)).changes > 0;
  }

  setAuthKind(id, kind) { this.db.prepare('UPDATE users SET auth_kind = ? WHERE id = ?').run(String(kind || '').slice(0, 16), id); }
  // Имя и аватар из соцсети. Пустые значения не стирают уже сохранённые.
  setWebProfile(id, { name = '', avatar = '' } = {}) {
    this.user(id);
    if (name) this.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(name).slice(0, 64), id);
    if (avatar) this.db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(String(avatar).slice(0, 300), id);
  }

  // Мягкое слияние: аккаунт from переносит нажитое в to и помечается merged_into.
  // События и сессии прошлого не переписываем — аналитика остаётся консистентной (план HOM-35, §4.3).
  // Идемпотентно: повторный вызов для уже слитой пары ничего не делает.
  mergeAccounts(fromId, toId, now = Date.now()) {
    const from = this.accountRoot(fromId);
    const to = this.accountRoot(toId);
    if (!from || !to || from === to) return { merged: false, into: to || from };
    if (!this.exists(from)) return { merged: false, into: to };
    this.user(to, now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const f = this.db.prepare('SELECT * FROM users WHERE id = ?').get(from);
      const t = this.db.prepare('SELECT * FROM users WHERE id = ?').get(to);
      this.db.prepare(`UPDATE users SET
          premium_until = MAX(premium_until, ?),
          karma_up = karma_up + ?, karma_down = karma_down + ?,
          aura_bonus = aura_bonus + ?, salutes = salutes + ?, salutes_received = salutes_received + ?,
          referrals = referrals + ?, strikes = MAX(strikes, ?), banned_until = MAX(banned_until, ?),
          threads_seen = MAX(threads_seen, ?), last_seen = MAX(last_seen, ?),
          ban_reason = COALESCE(ban_reason, ?),
          referred_by = CASE WHEN referred_by = '' THEN ? ELSE referred_by END,
          display_name = CASE WHEN display_name = '' THEN ? ELSE display_name END,
          avatar_url = CASE WHEN avatar_url = '' THEN ? ELSE avatar_url END,
          country = CASE WHEN country = '' THEN ? ELSE country END,
          langs = CASE WHEN langs = '' THEN ? ELSE langs END,
          source = CASE WHEN source = '' THEN ? ELSE source END
        WHERE id = ?`)
        .run(f.premium_until, f.karma_up, f.karma_down, f.aura_bonus, f.salutes, f.salutes_received,
          f.referrals, f.strikes, f.banned_until, f.threads_seen, f.last_seen,
          f.banned_until > now ? f.ban_reason : t.ban_reason,
          f.referred_by === to ? '' : f.referred_by, f.display_name, f.avatar_url, f.country, f.langs, f.source, to);
      // Серия дней: берём более свежую
      if (f.streak_day > (t.streak_day || '')) this.db.prepare('UPDATE users SET streak = ?, streak_day = ? WHERE id = ?').run(f.streak, f.streak_day, to);
      // Паспорт, друзья, подписки — объединение; дубли отбрасываются
      this.db.prepare('INSERT OR IGNORE INTO passport (user_id, country, first_at) SELECT ?, country, first_at FROM passport WHERE user_id = ?').run(to, from);
      this.db.prepare('INSERT OR IGNORE INTO friends (a, b, at) SELECT ?, b, at FROM friends WHERE a = ? AND b != ?').run(to, from, to);
      this.db.prepare('INSERT OR IGNORE INTO friends (a, b, at) SELECT a, ?, at FROM friends WHERE b = ? AND a != ?').run(to, from, to);
      this.db.prepare('DELETE FROM friends WHERE a = ? OR b = ?').run(from, from);
      this.db.prepare('INSERT OR IGNORE INTO live_subs (code, user_id, at) SELECT code, ?, at FROM live_subs WHERE user_id = ?').run(to, from);
      this.db.prepare('DELETE FROM live_subs WHERE user_id = ?').run(from);
      // Комплименты, оценки, жалобы и платежи следуют за аккаунтом
      this.db.prepare('UPDATE compliments SET target = ? WHERE target = ?').run(to, from);
      this.db.prepare('UPDATE compliments SET from_id = ? WHERE from_id = ?').run(to, from);
      this.db.prepare('DELETE FROM compliments WHERE target = from_id').run();
      this.db.prepare('UPDATE OR IGNORE ratings SET target = ? WHERE target = ?').run(to, from);
      this.db.prepare('UPDATE OR IGNORE ratings SET rater = ? WHERE rater = ?').run(to, from);
      this.db.prepare('DELETE FROM ratings WHERE rater = target').run();
      this.db.prepare('INSERT OR IGNORE INTO reports (target, reporter, reason, at) SELECT ?, reporter, reason, at FROM reports WHERE target = ? AND reporter != ?').run(to, from, to);
      this.db.prepare('INSERT OR IGNORE INTO reports (target, reporter, reason, at) SELECT target, ?, reason, at FROM reports WHERE reporter = ? AND target != ?').run(to, from, to);
      this.db.prepare('DELETE FROM reports WHERE target = ? OR reporter = ?').run(from, from);
      this.db.prepare('UPDATE payments SET user_id = ? WHERE user_id = ?').run(to, from);
      this.db.prepare('UPDATE rooms SET owner_id = ? WHERE owner_id = ?').run(to, from);
      this.db.prepare('UPDATE users SET referred_by = ? WHERE referred_by = ?').run(to, from);
      this.db.prepare('UPDATE identities SET user_id = ? WHERE user_id = ?').run(to, from);
      // Сам профиль гасим: пустой, без сессионных прав, со ссылкой на настоящий аккаунт
      this.db.prepare(`UPDATE users SET merged_into = ?, premium_until = 0, salutes = 0, aura_bonus = 0,
          karma_up = 0, karma_down = 0, banned_until = 0, ban_reason = NULL, ref_code = '', crowd_until = 0 WHERE id = ?`).run(to, from);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.event('account_merge', to, 0, from, now);
    return { merged: true, into: to };
  }

  // Удаление аккаунта (GDPR): личные данные уходят, обезличенные события и платежи остаются.
  deleteAccount(id, now = Date.now()) {
    const uid = String(id || '');
    if (!uid || !this.exists(uid)) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const sql of [
        'DELETE FROM identities WHERE user_id = ?',
        'DELETE FROM friends WHERE a = ? OR b = ?',
        'DELETE FROM passport WHERE user_id = ?',
        'DELETE FROM compliments WHERE target = ? OR from_id = ?',
        'DELETE FROM live_subs WHERE user_id = ?',
        'DELETE FROM ratings WHERE rater = ? OR target = ?',
        'DELETE FROM reports WHERE target = ? OR reporter = ?',
        'DELETE FROM users WHERE id = ?',
      ]) this.db.prepare(sql).run(...Array(sql.split('?').length - 1).fill(uid));
      this.db.prepare("UPDATE users SET referred_by = '' WHERE referred_by = ?").run(uid);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.event('account_delete', '', 0, '', now);
    return true;
  }

  // ---------- Подписки «сообщить, когда стример выйдет в эфир» ----------
  liveSub(code, id, on, now = Date.now()) {
    if (on) this.db.prepare('INSERT OR IGNORE INTO live_subs (code, user_id, at) VALUES (?, ?, ?)').run(code, id, now);
    else this.db.prepare('DELETE FROM live_subs WHERE code = ? AND user_id = ?').run(code, id);
  }
  isLiveSub(code, id) { return Boolean(this.db.prepare('SELECT 1 FROM live_subs WHERE code = ? AND user_id = ?').get(code, id)); }
  liveSubscribers(code) {
    return this.db.prepare(`SELECT s.user_id AS id FROM live_subs s JOIN users u ON u.id = s.user_id
      WHERE s.code = ? AND u.allows_pm = 1 AND u.banned_until <= ?`).all(code, Date.now()).map(r => r.id);
  }

  // ---------- Рефералы: оба получают бонус, только для нового пользователя ----------
  applyReferral(newId, refId, { days = 1, cap = 50 } = {}, now = Date.now()) {
    if (!refId || refId === newId || !this.exists(refId)) return false;
    const u = this.user(newId, now);
    if (u.referred_by) return false;
    const ref = this.user(refId, now);
    if (ref.referrals >= cap) return false;
    this.db.prepare('UPDATE users SET referred_by = ? WHERE id = ?').run(refId, newId);
    this.db.prepare('UPDATE users SET referrals = referrals + 1 WHERE id = ?').run(refId);
    this.grantPremium(newId, days, now);
    this.grantPremium(refId, days, now);
    return true;
  }

  // ---------- Бесплатные подборы по фильтру ----------
  filterLeft(id, day, perDay) {
    const u = this.user(id);
    return u.filter_day === day ? Math.max(0, perDay - u.filter_used) : perDay;
  }

  useFilter(id, day) {
    const u = this.user(id);
    const used = u.filter_day === day ? u.filter_used + 1 : 1;
    this.db.prepare('UPDATE users SET filter_day = ?, filter_used = ? WHERE id = ?').run(day, used, id);
  }

  // ---------- Серия дней с разговорами ----------
  // Возвращает { streak, bumped } — bumped=true, если серия выросла сегодня
  bumpStreak(id, today, yesterday) {
    const u = this.user(id);
    if (u.streak_day === today) return { streak: u.streak, bumped: false };
    const streak = u.streak_day === yesterday ? u.streak + 1 : 1;
    this.db.prepare('UPDATE users SET streak = ?, streak_day = ? WHERE id = ?').run(streak, today, id);
    return { streak, bumped: true };
  }

  streakOf(id, today, yesterday) {
    const u = this.user(id);
    return u.streak_day === today || u.streak_day === yesterday ? u.streak : 0;
  }

  // ---------- Карма ----------
  // Одна оценка одного человека в сутки, чтобы нельзя было «накрутить»
  rate(rater, target, value, now = Date.now()) {
    if (rater === target || ![1, -1].includes(value)) return false;
    const recent = this.db.prepare('SELECT 1 FROM ratings WHERE rater = ? AND target = ? AND at > ?').get(rater, target, now - DAY);
    if (recent) return false;
    this.user(target, now);
    this.db.prepare('INSERT INTO ratings (rater, target, value, at) VALUES (?, ?, ?, ?)').run(rater, target, value, now);
    this.db.prepare(`UPDATE users SET ${value > 0 ? 'karma_up = karma_up + 1' : 'karma_down = karma_down + 1'} WHERE id = ?`).run(target);
    return true;
  }

  // Доля положительных оценок со сглаживанием: новички стартуют с 0.5+
  karma(u) { return (u.karma_up + 2) / (u.karma_up + u.karma_down + 3); }

  // ---------- Комнаты каналов ----------
  createRoom(ownerId, title, now = Date.now()) {
    const slug = crypto.randomBytes(5).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 7) || 'room' + now % 1e4;
    this.db.prepare('INSERT INTO rooms (slug, title, owner_id, created_at) VALUES (?, ?, ?, ?)').run(slug, title.slice(0, 48), ownerId, now);
    return this.room(slug);
  }
  // Только для локальной отладки: комната по заданному slug
  ensureRoom(slug, title, now = Date.now()) {
    this.db.prepare('INSERT OR IGNORE INTO rooms (slug, title, owner_id, created_at) VALUES (?, ?, ?, ?)').run(slug, title, 'dev', now);
  }
  room(slug) { return this.db.prepare('SELECT * FROM rooms WHERE slug = ?').get(slug) || null; }
  roomsOf(ownerId) { return this.db.prepare('SELECT * FROM rooms WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20').all(ownerId); }
  roomVisit(slug) { this.db.prepare('UPDATE rooms SET visits = visits + 1 WHERE slug = ?').run(slug); }
  roomMatch(slug) { this.db.prepare('UPDATE rooms SET matches = matches + 1 WHERE slug = ?').run(slug); }

  // Кому напомнить о событии: разрешили писать, не отписались, заходили за 14 дней, не забанены
  // Aura Hour по местному времени: кому напоминать в данном часовом поясе (tz = null — пояс по умолчанию + неизвестные)
  eventAudience(now = Date.now(), tz = null, defaultTz = null) {
    const where = tz === null ? '' : tz === defaultTz ? 'AND (tz_min = ? OR tz_min = -10000)' : 'AND tz_min = ?';
    return this.db.prepare(`SELECT id, lang FROM users WHERE allows_pm = 1 AND notify_events = 1
      AND last_seen > ? AND banned_until <= ? AND id NOT LIKE 'dev-%' ${where}`).all(now - 14 * DAY, now, ...(tz === null ? [] : [tz]));
  }
  eventTimezones(now = Date.now()) {
    return this.db.prepare(`SELECT DISTINCT tz_min AS tz FROM users WHERE allows_pm = 1 AND notify_events = 1
      AND last_seen > ? AND tz_min != -10000`).all(now - 14 * DAY).map(r => r.tz);
  }
  setTz(id, tz) { this.db.prepare('UPDATE users SET tz_min = ? WHERE id = ?').run(tz, id); }

  // «Позовите, когда соберутся»: подписка на 14 дней, не чаще раза в 20 часов
  setCrowd(id, on, now = Date.now()) {
    this.db.prepare('UPDATE users SET crowd_until = ? WHERE id = ?').run(on ? now + 14 * DAY : 0, id);
  }
  crowdAudience(lang, now = Date.now()) {
    return this.db.prepare(`SELECT id, lang FROM users WHERE crowd_until > ? AND allows_pm = 1 AND banned_until <= ?
      AND crowd_notified_at < ? AND (',' || langs || ',') LIKE ? AND id NOT LIKE 'dev-%'`)
      .all(now, now, now - 20 * 60 * 60 * 1000, `%,${lang},%`);
  }
  markCrowdNotified(id, now = Date.now()) { this.db.prepare('UPDATE users SET crowd_notified_at = ? WHERE id = ?').run(now, id); }

  langOf(id) { return this.db.prepare('SELECT lang FROM users WHERE id = ?').get(id)?.lang || ''; }
  bumpThreadsSeen(id) {
    this.user(id);
    this.db.prepare('UPDATE users SET threads_seen = MIN(threads_seen + 1, 99) WHERE id = ?').run(id);
    return this.db.prepare('SELECT threads_seen AS n FROM users WHERE id = ?').get(id).n;
  }

  stats(now = Date.now()) {
    const one = sql => this.db.prepare(sql).get(now).n;
    return {
      users: this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
      banned: one('SELECT COUNT(*) AS n FROM users WHERE banned_until > ?'),
      premium: one('SELECT COUNT(*) AS n FROM users WHERE premium_until > ?'),
      stars: this.db.prepare('SELECT COALESCE(SUM(stars), 0) AS n FROM payments WHERE refunded = 0').get().n,
      rooms: this.db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n,
    };
  }
}
