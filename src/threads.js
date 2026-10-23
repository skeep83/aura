import crypto from 'node:crypto';

// «Нити» — то, что остаётся после случайного разговора.
// Нить начинает один человек (история, вопрос миру, пожелание), каждый следующий собеседник
// продолжает её одним ходом и забирает себе, чтобы передать дальше. Нить конечна: дошла до max_hops —
// финал у пары, которая её закрыла, и уведомление всем участникам. Застрявшая у держателя нить
// через stuckMs уходит в пул и вручается в ожидании тому, у кого пустой карман.
// Ходы хранятся в оригинале; перевод на язык читателя — пакетом через ИИ, кэш в thread_tr навсегда
// (нить живёт днями, кэш ai.js — в памяти на час).
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const KINDS = {
  story: { maxHops: 12, maxLen: 120 },
  question: { maxHops: 20, maxLen: 80 },
  wish: { maxHops: 10, maxLen: 100 },
};

export function createThreads({
  db, ai = null, kinds = KINDS, ttlMs = 7 * DAY, stuckMs = 48 * HOUR, maxDrops = 3, minHopsToFinish = 5,
  dailyFree = 1, dailyPremium = 3, translateTimeoutMs = 6000,
} = {}) {
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      starter_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      hops INTEGER NOT NULL DEFAULT 0,
      max_hops INTEGER NOT NULL,
      holder_id TEXT NOT NULL DEFAULT '',
      held_since INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'live',
      drops INTEGER NOT NULL DEFAULT 0,
      finished_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS threads_holder ON threads (holder_id, status);
    CREATE INDEX IF NOT EXISTS threads_status ON threads (status, held_since);
    CREATE TABLE IF NOT EXISTS thread_moves (
      thread_id INTEGER NOT NULL,
      n INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT '',
      lang TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, n)
    );
    CREATE INDEX IF NOT EXISTS thread_moves_user ON thread_moves (user_id);
    CREATE TABLE IF NOT EXISTS thread_tr (
      thread_id INTEGER NOT NULL,
      n INTEGER NOT NULL,
      lang TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (thread_id, n, lang)
    );
  `);
  const get = (q, ...a) => sql.prepare(q).get(...a);
  const all = (q, ...a) => sql.prepare(q).all(...a);
  const run = (q, ...a) => sql.prepare(q).run(...a);

  function newCode() {
    for (;;) {
      const code = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 7).toLowerCase();
      if (code.length >= 6 && !get('SELECT 1 FROM threads WHERE code = ?', code)) return code;
    }
  }
  const cleanText = (text, kind) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, kinds[kind].maxLen);
  const cleanCountry = c => /^[A-Z]{2}$/.test(c || '') ? c : '';
  const cleanLang = l => /^[a-z]{2}$/.test(l || '') ? l : '';

  const byId = id => get('SELECT * FROM threads WHERE id = ?', id) || null;
  const byCode = code => get('SELECT * FROM threads WHERE code = ?', String(code || '')) || null;
  const holding = userId => get("SELECT * FROM threads WHERE holder_id = ? AND status = 'live'", userId) || null;
  const participated = (threadId, userId) => Boolean(get('SELECT 1 FROM thread_moves WHERE thread_id = ? AND user_id = ?', threadId, userId));
  const moves = threadId => all('SELECT * FROM thread_moves WHERE thread_id = ? ORDER BY n', threadId);
  const participants = threadId => all('SELECT user_id AS id, n, country FROM thread_moves WHERE thread_id = ? ORDER BY n', threadId);
  const route = ms => [...new Set(ms.map(m => m.country).filter(Boolean))];

  // Сколько своих нитей можно начать сегодня (одна в сутки, Premium — три)
  function startsLeft(userId, premium, now = Date.now()) {
    const n = get('SELECT COUNT(*) AS n FROM threads WHERE starter_id = ? AND started_at > ?', userId, now - DAY).n;
    return Math.max(0, (premium ? dailyPremium : dailyFree) - n);
  }

  function start(userId, { kind, text, lang = '', country = '', premium = false }, now = Date.now()) {
    if (!kinds[kind]) return { error: 'kind' };
    const t = cleanText(text, kind);
    if (t.length < 2) return { error: 'text' };
    if (holding(userId)) return { error: 'holding' };
    if (!startsLeft(userId, premium, now)) return { error: 'limit' };
    const code = newCode();
    const { lastInsertRowid } = run(
      'INSERT INTO threads (code, kind, starter_id, started_at, hops, max_hops, holder_id, held_since) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
      code, kind, userId, now, kinds[kind].maxHops, userId, now);
    run('INSERT INTO thread_moves (thread_id, n, user_id, country, lang, text, at) VALUES (?, 1, ?, ?, ?, ?, ?)',
      lastInsertRowid, userId, cleanCountry(country), cleanLang(lang), t, now);
    return { thread: byId(lastInsertRowid) };
  }

  // Ход и передача: нить переезжает к toId. Возвращает { thread, move, finished }
  function take(threadId, fromId, toId, { text, lang = '', country = '' }, now = Date.now()) {
    const th = byId(threadId);
    if (!th || th.status !== 'live') return { error: 'gone' };
    if (th.holder_id !== fromId) return { error: 'not_holder' };
    if (fromId === toId || participated(th.id, toId)) return { error: 'already' };
    if (holding(toId)) return { error: 'holding' };
    const t = cleanText(text, th.kind);
    if (t.length < 2) return { error: 'text' };
    const n = th.hops + 1;
    run('INSERT INTO thread_moves (thread_id, n, user_id, country, lang, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      th.id, n, toId, cleanCountry(country), cleanLang(lang), t, now);
    run('UPDATE threads SET hops = ?, holder_id = ?, held_since = ?, drops = 0 WHERE id = ?', n, toId, now, th.id);
    const finished = n >= th.max_hops;
    if (finished) finish(th.id, now);
    return { thread: byId(th.id), move: { n, country: cleanCountry(country) }, finished };
  }

  function finish(threadId, now = Date.now()) {
    run("UPDATE threads SET status = 'done', holder_id = '', finished_at = ? WHERE id = ? AND status IN ('live', 'pool')", now, threadId);
    return byId(threadId);
  }
  function archive(threadId) {
    run("UPDATE threads SET status = 'archived', holder_id = '' WHERE id = ?", threadId);
  }

  // Модерация: ход скрывается, цепочка не рвётся. Скрытый первый ход — нить в архив
  function hideMove(threadId, n) {
    run('UPDATE thread_moves SET hidden = 1 WHERE thread_id = ? AND n = ?', threadId, n);
    run('DELETE FROM thread_tr WHERE thread_id = ? AND n = ?', threadId, n);
    if (n === 1) archive(threadId);
  }

  // Застрявшая нить для человека с пустым карманом: из пула, где он ещё не участвовал
  function offerFor(userId, { kind = null } = {}) {
    return get(`SELECT t.* FROM threads t WHERE t.status = 'pool' ${kind ? 'AND t.kind = ?' : ''}
      AND NOT EXISTS (SELECT 1 FROM thread_moves m WHERE m.thread_id = t.id AND m.user_id = ?)
      ORDER BY t.hops DESC, RANDOM() LIMIT 1`, ...(kind ? [kind] : []), userId) || null;
  }
  function accept(threadId, userId, now = Date.now()) {
    const th = byId(threadId);
    if (!th || th.status !== 'pool') return { error: 'gone' };
    if (holding(userId)) return { error: 'holding' };
    if (participated(th.id, userId)) return { error: 'already' };
    run("UPDATE threads SET status = 'live', holder_id = ?, held_since = ? WHERE id = ?", userId, now, th.id);
    return { thread: byId(th.id) };
  }
  // Держатель отпускает нить обратно в пул
  function release(userId) {
    const th = holding(userId);
    if (!th) return null;
    run("UPDATE threads SET status = 'pool', holder_id = '' WHERE id = ?", th.id);
    return byId(th.id);
  }

  // Раз в минуту: застрявшие — в пул (три раза подряд — архив), старые — финал (если ходов ≥ minHopsToFinish) или архив.
  // Возвращает завершённые нити — для уведомлений участникам
  function tick(now = Date.now()) {
    const done = [];
    for (const th of all("SELECT * FROM threads WHERE status = 'live' AND held_since < ?", now - stuckMs)) {
      if (th.drops + 1 >= maxDrops) archive(th.id);
      else run("UPDATE threads SET status = 'pool', holder_id = '', drops = drops + 1 WHERE id = ?", th.id);
    }
    for (const th of all("SELECT * FROM threads WHERE status IN ('live', 'pool') AND started_at < ?", now - ttlMs)) {
      if (th.hops >= minHopsToFinish) done.push(finish(th.id, now));
      else archive(th.id);
    }
    return done;
  }

  // ---------- Перевод ходов на язык читателя ----------
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
  async function translations(th, ms, lang) {
    const out = new Map(all('SELECT n, text FROM thread_tr WHERE thread_id = ? AND lang = ?', th.id, lang).map(r => [r.n, r.text]));
    const missing = ms.filter(m => !m.hidden && m.lang !== lang && !out.has(m.n));
    if (!missing.length || !ai?.on?.('threads')) return out;
    try {
      // История переводится целиком: имена, род и согласование между предложениями сохраняются
      const got = await withTimeout(ai.translateBatch(missing.map(m => m.text), lang, { coherent: th.kind === 'story' }), translateTimeoutMs);
      if (!Array.isArray(got) || got.length !== missing.length) return out;
      const ins = sql.prepare('INSERT OR IGNORE INTO thread_tr (thread_id, n, lang, text) VALUES (?, ?, ?, ?)');
      missing.forEach((m, i) => {
        const t = String(got[i] || '').trim().slice(0, 200);
        if (!t) return;
        ins.run(th.id, m.n, lang, t);
        out.set(m.n, t);
      });
    } catch {}
    return out;
  }
  // Заголовок истории для финала, по языкам; кэш — строка n = 0 в thread_tr
  async function title(th, lang, text) {
    if (th.kind !== 'story') return '';
    const hit = get('SELECT text FROM thread_tr WHERE thread_id = ? AND n = 0 AND lang = ?', th.id, lang);
    if (hit) return hit.text;
    if (!ai?.on?.('threads')) return '';
    try {
      const t = String(await withTimeout(ai.threadTitle(text, lang), translateTimeoutMs) || '').trim().slice(0, 60);
      if (t) run('INSERT OR IGNORE INTO thread_tr (thread_id, n, lang, text) VALUES (?, 0, ?, ?)', th.id, lang, t);
      return t;
    } catch { return ''; }
  }

  // Карточка нити глазами viewerId на языке lang: все ходы (переведённые, с оригиналом), маршрут, роль
  async function view(th, lang, viewerId, now = Date.now()) {
    const ms = moves(th.id);
    const tr = await translations(th, ms, lang);
    const mine = ms.find(m => m.user_id === viewerId);
    const card = {
      code: th.code, kind: th.kind, status: th.status, hops: th.hops, maxHops: th.max_hops,
      startedAt: th.started_at, finishedAt: th.finished_at || 0,
      days: Math.max(1, Math.ceil(((th.finished_at || now) - th.started_at) / DAY)),
      from: ms[0]?.country || '', last: ms.at(-1)?.country || '', countries: route(ms),
      holder: th.holder_id === viewerId, starter: th.starter_id === viewerId, myHop: mine?.n || 0,
      canAccept: th.status === 'pool' && !mine && !holding(viewerId),
      moves: ms.map(m => ({
        n: m.n, country: m.country, lang: m.lang, hidden: Boolean(m.hidden), mine: m.user_id === viewerId,
        text: m.hidden ? '' : tr.get(m.n) || m.text,
        orig: m.hidden || m.lang === lang || !tr.has(m.n) ? null : m.text,
      })),
      title: '',
    };
    if (th.status === 'done' && th.kind === 'story') {
      card.title = await title(th, lang, ms.filter(m => !m.hidden).map(m => tr.get(m.n) || m.text).join(' '));
    }
    return card;
  }

  function stats() {
    const n = status => get('SELECT COUNT(*) AS n FROM threads WHERE status = ?', status).n;
    return { threadsLive: n('live'), threadsPool: n('pool'), threadsDone: n('done'), threadsArchived: n('archived') };
  }

  return { kinds, byId, byCode, holding, participated, participants, moves, route, startsLeft, start, take, finish, hideMove, archive, offerFor, accept, release, tick, view, stats };
}
