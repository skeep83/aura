import crypto from 'node:crypto';

// Админ-API для панели (приложение aura-admin на TrueNAS). Все пути /api/admin/*,
// доступ только с заголовком Authorization: Bearer <ADMIN_API_TOKEN>. Без токена в .env API выключен (404).
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const FOREVER = 8.64e15;

export function createAdmin({ db, ai, cfg, token, live, isOnline, kick, refresh, refund, notify, startedAt = Date.now() }) {
  const sql = db.db;
  const all = (q, ...a) => sql.prepare(q).all(...a);
  const get = (q, ...a) => sql.prepare(q).get(...a);
  const fails = new Map(); // ip -> { n, until } — защита от перебора токена

  function authorized(req, ip) {
    const f = fails.get(ip);
    if (f && f.n >= 10 && Date.now() < f.until) return 'locked';
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(got), b = Buffer.from(token);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) { fails.delete(ip); return 'ok'; }
    const n = (f && Date.now() < f.until ? f.n : 0) + 1;
    fails.set(ip, { n, until: Date.now() + 10 * 60 * 1000 });
    return 'denied';
  }

  const auraOf = u => Math.max(0, 100 + u.karma_up * 10 - u.karma_down * 15 + (u.aura_bonus || 0));
  const brief = u => ({
    id: u.id, name: u.name, username: u.username, gender: u.gender, want: u.want, country: u.country, lang: u.lang,
    langs: u.langs ? u.langs.split(',').filter(Boolean) : [],
    createdAt: u.created_at, lastSeen: u.last_seen, premiumUntil: u.premium_until,
    bannedUntil: u.banned_until, banReason: u.ban_reason, strikes: u.strikes,
    aura: auraOf(u), karmaUp: u.karma_up, karmaDown: u.karma_down, streak: u.streak,
    referrals: u.referrals, referredBy: u.referred_by, salutes: u.salutes, salutesReceived: u.salutes_received,
    reveal: Boolean(u.reveal), allowsPm: Boolean(u.allows_pm), online: isOnline(u.id),
    reports: get('SELECT COUNT(*) AS n FROM reports WHERE target = ?', u.id).n,
  });

  // Ряды по дням (по часовому поясу аудитории) для графиков
  function series(days) {
    const tz = cfg.tzOffset * HOUR;
    const now = Date.now();
    const start = Math.floor((now + tz) / DAY) * DAY - tz - (days - 1) * DAY;
    const dayOf = at => Math.floor((at - start) / DAY);
    const rows = Array.from({ length: days }, (_, i) => ({
      day: new Date(start + i * DAY + tz).toISOString().slice(0, 10),
      dau: 0, newUsers: 0, matches: 0, talkMin: 0, stars: 0, reports: 0, connOk: 0, connFail: 0, vibes: 0, compliments: 0, duoCalls: 0,
    }));
    const add = (at, key, v = 1) => { const i = dayOf(at); if (i >= 0 && i < days) rows[i][key] += v; };
    const users = new Map();
    for (const e of all("SELECT type, user_id, value, at FROM events WHERE at >= ? AND type IN ('session','match','talk','report','conn_ok','conn_fail','vibe_match','compliment','duo_call')", start)) {
      switch (e.type) {
        case 'session': { const k = `${dayOf(e.at)}:${e.user_id}`; if (!users.has(k)) { users.set(k, 1); add(e.at, 'dau'); } break; }
        case 'match': add(e.at, 'matches'); break;
        case 'talk': add(e.at, 'talkMin', e.value / 60000 / 2); break; // у разговора два участника
        case 'report': add(e.at, 'reports'); break;
        case 'conn_ok': add(e.at, 'connOk'); break;
        case 'conn_fail': add(e.at, 'connFail'); break;
        case 'vibe_match': add(e.at, 'vibes', 0.5); break;
        case 'compliment': add(e.at, 'compliments'); break;
        case 'duo_call': add(e.at, 'duoCalls'); break;
      }
    }
    for (const u of all('SELECT created_at FROM users WHERE created_at >= ?', start)) add(u.created_at, 'newUsers');
    for (const p of all('SELECT stars, at FROM payments WHERE at >= ? AND refunded = 0', start)) add(p.at, 'stars', p.stars);
    for (const r of rows) { r.talkMin = Math.round(r.talkMin); r.vibes = Math.round(r.vibes); }
    return rows;
  }

  function users({ q = '', filter = '', sort = 'recent', limit = 50, offset = 0 }) {
    const where = [], args = [];
    if (q) {
      where.push("(id = ? OR username LIKE ? OR name LIKE ?)");
      const like = `%${q.replace(/^@/, '')}%`;
      args.push(q, like, like);
    }
    const now = Date.now();
    if (filter === 'banned') { where.push('banned_until > ?'); args.push(now); }
    if (filter === 'premium') { where.push('premium_until > ?'); args.push(now); }
    if (filter === 'reported') where.push('id IN (SELECT target FROM reports)');
    if (filter === 'new') { where.push('created_at > ?'); args.push(now - DAY); }
    const order = { recent: 'last_seen DESC', created: 'created_at DESC', aura: '(karma_up * 10 - karma_down * 15 + aura_bonus) DESC',
      low: '(karma_up * 10 - karma_down * 15 + aura_bonus) ASC', referrals: 'referrals DESC' }[sort] || 'last_seen DESC';
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = get(`SELECT COUNT(*) AS n FROM users ${w}`, ...args).n;
    const list = all(`SELECT * FROM users ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, Math.min(200, Number(limit) || 50), Number(offset) || 0);
    return { total, users: list.map(brief) };
  }

  function userDetail(id) {
    if (!db.exists(id)) return null;
    const u = db.user(id);
    return {
      user: brief(u),
      passport: all('SELECT country, first_at AS at FROM passport WHERE user_id = ? ORDER BY first_at', id),
      compliments: db.complimentsOf(id),
      reportsAgainst: all('SELECT reporter, reason, at FROM reports WHERE target = ? ORDER BY at DESC', id),
      reportsBy: all('SELECT target, reason, at FROM reports WHERE reporter = ? ORDER BY at DESC LIMIT 50', id),
      payments: all('SELECT charge_id AS chargeId, plan, stars, at, refunded FROM payments WHERE user_id = ? ORDER BY at DESC', id),
      rooms: all('SELECT slug, title, visits, matches FROM rooms WHERE owner_id = ?', id),
      events: all("SELECT type, value, tag, at FROM events WHERE user_id = ? ORDER BY at DESC LIMIT 60", id),
      wrapped: db.wrapped(id),
    };
  }

  // Действия над пользователем; после каждого — обновить состояние, если он онлайн
  function act(id, action, body) {
    if (!db.exists(id)) return { error: 'not_found' };
    switch (action) {
      case 'ban': {
        const forever = body.hours === 'forever' || !Number(body.hours);
        const until = db.ban(id, forever ? Infinity : Number(body.hours) * HOUR, String(body.reason || 'admin').slice(0, 40));
        kick(id);
        db.event('admin_ban', id, forever ? 0 : Number(body.hours), String(body.reason || ''));
        return { ok: true, bannedUntil: until };
      }
      case 'unban':
        db.unban(id);
        db.event('admin_unban', id);
        return { ok: true };
      case 'premium': {
        const days = Math.max(1, Math.min(365, Number(body.days) || 1));
        const until = db.grantPremium(id, days);
        refresh(id);
        if (body.notify) notify(id, `👑 Вам подарили Premium на ${days} сут.`);
        db.event('admin_premium', id, days);
        return { ok: true, premiumUntil: until };
      }
      case 'salutes': {
        const n = Math.max(-1000, Math.min(1000, Math.trunc(Number(body.n) || 0)));
        db.addSalutes(id, Math.max(n, -db.user(id).salutes));
        refresh(id);
        db.event('admin_salutes', id, n);
        return { ok: true, salutes: db.user(id).salutes };
      }
      case 'aura': {
        const n = Math.max(-500, Math.min(500, Math.trunc(Number(body.n) || 0)));
        db.addAuraBonus(id, n);
        refresh(id);
        db.event('admin_aura', id, n);
        return { ok: true, aura: auraOf(db.user(id)) };
      }
      case 'kick':
        kick(id, false);
        return { ok: true };
      case 'clear_reports':
        sql.prepare('DELETE FROM reports WHERE target = ?').run(id);
        sql.prepare('UPDATE users SET strikes = 0 WHERE id = ?').run(id);
        db.event('admin_clear_reports', id);
        return { ok: true };
      case 'message': {
        const text = String(body.text || '').trim().slice(0, 1000);
        if (!text) return { error: 'empty' };
        notify(id, text);
        db.event('admin_message', id);
        return { ok: true };
      }
    }
    return { error: 'unknown_action' };
  }

  function reports({ limit = 100 }) {
    const rows = all(`SELECT r.target, r.reporter, r.reason, r.at,
        t.name AS targetName, t.username AS targetUsername, t.banned_until AS targetBannedUntil,
        (SELECT COUNT(*) FROM reports x WHERE x.target = r.target) AS targetReports
      FROM reports r LEFT JOIN users t ON t.id = r.target ORDER BY r.at DESC LIMIT ?`, Math.min(500, Number(limit) || 100));
    const byReason = all('SELECT reason, COUNT(*) AS n FROM reports GROUP BY reason ORDER BY n DESC');
    return { reports: rows, byReason };
  }

  function payments({ limit = 200 }) {
    const rows = all(`SELECT p.charge_id AS chargeId, p.user_id AS userId, p.plan, p.stars, p.at, p.refunded, u.name, u.username
      FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.at DESC LIMIT ?`, Math.min(1000, Number(limit) || 200));
    const byPlan = all('SELECT plan, COUNT(*) AS n, SUM(stars) AS stars FROM payments WHERE refunded = 0 GROUP BY plan ORDER BY stars DESC');
    const total = get('SELECT COALESCE(SUM(stars), 0) AS stars, COUNT(*) AS n FROM payments WHERE refunded = 0');
    return { payments: rows, byPlan, total };
  }

  function moderation({ limit = 150 }) {
    const events = all(`SELECT e.type, e.user_id AS userId, e.value, e.tag, e.at, u.name, u.username, u.banned_until AS bannedUntil
      FROM events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.type IN ('nsfw','age_block','report','admin_ban','admin_unban') ORDER BY e.at DESC LIMIT ?`, Math.min(500, Number(limit) || 150));
    const banned = all('SELECT id, name, username, banned_until AS bannedUntil, ban_reason AS reason FROM users WHERE banned_until > ? ORDER BY banned_until DESC LIMIT 200', Date.now());
    return { events, banned };
  }

  function overview() {
    const now = Date.now();
    const countries = all("SELECT country, COUNT(*) AS n FROM users WHERE country != '' GROUP BY country ORDER BY n DESC LIMIT 12");
    const langs = all("SELECT lang, COUNT(*) AS n FROM users WHERE lang != '' GROUP BY lang ORDER BY n DESC LIMIT 10");
    const genders = all('SELECT gender, COUNT(*) AS n FROM users GROUP BY gender');
    const week = get("SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE type = 'session' AND at > ?", now - 7 * DAY).n;
    const month = get("SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE type = 'session' AND at > ?", now - 30 * DAY).n;
    const viral = Object.fromEntries(['guess_ok', 'compliment', 'salute', 'salute_buy', 'duo_create', 'duo_call', 'vibe_match']
      .map(t => [t, get('SELECT COUNT(*) AS n FROM events WHERE type = ? AND at > ?', t, now - 7 * DAY).n]));
    return {
      live: live(), totals: db.stats(), funnel: db.funnel(), wau: week, mau: month, countries, langs, genders, viral,
      system: {
        startedAt, uptimeSec: Math.round((now - startedAt) / 1000), node: process.version, memMb: Math.round(process.memoryUsage().rss / 1048576),
        moderation: Boolean(cfg.moderationUrl), turn: Boolean(cfg.turnSecret || cfg.cfTurnKeyId), bot: Boolean(cfg.botToken),
        publicUrl: cfg.publicUrl, version: process.env.GIT_SHA || '',
      },
    };
  }

  function config() {
    const pick = ['appName', 'publicUrl', 'tzOffset', 'freeFilterPerDay', 'referralDays', 'streakRewardEvery', 'rateMinSeconds',
      'nsfwThreshold', 'minorThreshold', 'ageBlockHours', 'frameIntervalMs', 'strikesToBan', 'strikeBanHours', 'reportsToBan', 'adminIds', 'supportContact'];
    return Object.fromEntries(pick.filter(k => k in cfg).map(k => [k, cfg[k]]));
  }

  function rooms() {
    return all(`SELECT r.slug, r.title, r.owner_id AS ownerId, r.visits, r.matches, r.created_at AS createdAt, u.username AS ownerUsername
      FROM rooms r LEFT JOIN users u ON u.id = r.owner_id ORDER BY r.visits DESC LIMIT 200`);
  }

  async function readJson(req) {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 20_000) throw new Error('too large'); }
    return body ? JSON.parse(body) : {};
  }

  // Возвращает true, если запрос обработан
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/admin/')) return false;
    const send = (code, data) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    if (!token) { res.writeHead(404); res.end(); return true; }
    const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
    const auth = authorized(req, ip);
    if (auth !== 'ok') { send(auth === 'locked' ? 429 : 401, { error: auth }); return true; }

    const parts = url.pathname.slice('/api/admin/'.length).split('/').filter(Boolean).map(decodeURIComponent);
    const qs = Object.fromEntries(url.searchParams);
    try {
      if (req.method === 'GET') {
        switch (parts[0]) {
          case 'overview': return send(200, overview()), true;
          case 'series': return send(200, series(Math.max(7, Math.min(90, Number(qs.days) || 30)))), true;
          case 'users': {
            if (parts[1]) { const d = userDetail(parts[1]); return send(d ? 200 : 404, d || { error: 'not_found' }), true; }
            return send(200, users(qs)), true;
          }
          case 'reports': return send(200, reports(qs)), true;
          case 'payments': return send(200, payments(qs)), true;
          case 'moderation': return send(200, moderation(qs)), true;
          case 'rooms': return send(200, rooms()), true;
          case 'config': return send(200, config()), true;
          case 'ai': return send(200, ai.publicConfig()), true;
        }
      } else if (req.method === 'POST') {
        const body = await readJson(req);
        if (parts[0] === 'users' && parts[1] && parts[2]) {
          const r = act(parts[1], parts[2], body);
          console.log(`admin: ${parts[2]} ${parts[1]}${r.error ? ' → ' + r.error : ''}`);
          return send(r.error ? 400 : 200, r), true;
        }
        if (parts[0] === 'ai') {
          if (!parts[1]) {
            // Настройки ИИ: ключ меняется только если прислан новый; пустая строка не затирает
            const next = {};
            for (const k of ['enabled', 'preset', 'kind', 'baseUrl', 'model', 'features', 'dailyLimit']) if (k in body) next[k] = body[k];
            if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.apiKey = body.apiKey.trim();
            if (body.clearKey) next.apiKey = '';
            if ('dailyLimit' in next) next.dailyLimit = Math.max(10, Math.min(1_000_000, Number(next.dailyLimit) || 5000));
            if (next.kind && !['openai', 'anthropic'].includes(next.kind)) return send(400, { error: 'kind' }), true;
            ai.save(next);
            db.event('admin_ai_config', '', 0, `${ai.config.preset}:${ai.config.model}`);
            return send(200, ai.publicConfig()), true;
          }
          try {
            if (parts[1] === 'test') return send(200, await ai.test()), true;
            if (parts[1] === 'ask') {
              const answer = await ai.analyst(String(body.question || ''), { overview: overview(), series: series(30) });
              return send(200, { answer }), true;
            }
            if (parts[1] === 'user' && parts[2]) {
              const d = userDetail(parts[2]);
              if (!d) return send(404, { error: 'not_found' }), true;
              return send(200, { answer: await ai.reviewUser(d) }), true;
            }
          } catch (e) { return send(400, { error: e.message }), true; }
        }
        if (parts[0] === 'payments' && parts[1] && parts[2] === 'refund') {
          const r = await refund(parts[1]);
          console.log(`admin: refund ${parts[1]} → ${r.error || 'ok'}`);
          return send(r.error ? 400 : 200, r), true;
        }
      }
      send(404, { error: 'not_found' });
    } catch (e) {
      console.error('admin:', e.message);
      send(500, { error: e.message });
    }
    return true;
  }

  return { handle, series, users, userDetail, act, overview };
}

export { FOREVER };
