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
    `);
    const have = new Set(this.db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
    for (const [col, def] of Object.entries(USER_COLUMNS)) {
      if (!have.has(col)) this.db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
    }
  }

  exists(id) { return Boolean(this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)); }

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

  setReveal(id, on) { this.db.prepare('UPDATE users SET reveal = ? WHERE id = ?').run(on ? 1 : 0, id); }
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
  eventAudience(now = Date.now()) {
    return this.db.prepare(`SELECT id, lang FROM users WHERE allows_pm = 1 AND notify_events = 1
      AND last_seen > ? AND banned_until <= ? AND id NOT LIKE 'dev-%'`).all(now - 14 * DAY, now);
  }

  langOf(id) { return this.db.prepare('SELECT lang FROM users WHERE id = ?').get(id)?.lang || ''; }

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
