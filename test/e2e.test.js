import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Фейковый сервис модерации: кадр 'NSFW' — нарушение
async function fakeModeration() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); return res.end('{"ok":true}'); }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer mod-secret') { res.writeHead(401); return res.end(); }
      const { image } = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ nsfw: image === 'NSFW' ? 0.99 : 0.01, minor: image === 'KID' ? 0.95 : 0.05, face: true }));
    });
  });
  srv.listen(0);
  await once(srv, 'listening');
  return srv;
}

async function startServer(t, extraEnv) {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(port), DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'vr-')),
      DEV_ALLOW_ANON: '1', BOT_TOKEN: '', NODE_NO_WARNINGS: '1', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => srv.kill());
  await once(srv.stdout, 'data');
  return port;
}

// Последнее сообщение типа t, удовлетворяющее условию (пропускает промежуточные)
async function until(c, t, pred) {
  for (;;) { const m = await c.next(t); if (pred(m)) return m; }
}

async function client(port, devId, extra = {}, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
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
      setTimeout(() => reject(new Error('timeout waiting ' + t)), 3000);
    }),
  };
  await once(ws, 'open');
  c.send({ t: 'auth', initData: '', devId, ...extra });
  c.ready = await c.next('ready');
  return c;
}

test('матчинг, сигналинг, чат, далее, жалоба', async t => {
  const port = await startServer(t, { REPORTS_TO_BAN: '1' });
  const a = await client(port, 'dev-aaaa'), b = await client(port, 'dev-bbbb');
  assert.ok(a.ready.ice.length >= 1);
  assert.equal(a.ready.moderation, null);

  a.send({ t: 'find' });
  await a.next('waiting');
  b.send({ t: 'find' });
  assert.equal((await a.next('matched')).initiator, true);
  assert.equal((await b.next('matched')).initiator, false);

  a.send({ t: 'signal', data: { sdp: { type: 'offer', sdp: 'x' } } });
  assert.equal((await b.next('signal')).data.sdp.type, 'offer');

  a.send({ t: 'chat', text: '  привет  ' });
  assert.equal((await b.next('chat')).text, 'привет');

  await sleep(900); // антиспам «Далее»
  b.send({ t: 'next' });
  await a.next('peer_left');

  const c = await client(port, 'dev-cccc');
  c.send({ t: 'find' });
  await c.next('matched');
  c.send({ t: 'report', reason: 'spam' });
  await c.next('reported');
  const banned = await Promise.race([a.next('banned').then(() => 'a'), b.next('banned').then(() => 'b')]);
  assert.ok(['a', 'b'].includes(banned));

  // Забаненный не может войти снова
  const again = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', initData: '', devId: banned === 'a' ? 'dev-aaaa' : 'dev-bbbb' })));
    ws.on('close', code => resolve(code));
  });
  assert.equal(again, 4004);
  for (const x of [a, b, c]) x.ws.close();
});

test('премиум и фильтр: без премиума фильтр сбрасывается, после — работает', async t => {
  const port = await startServer(t, { FREE_FILTER_PER_DAY: '0' });
  const a = await client(port, 'dev-prem');
  a.send({ t: 'profile', gender: 'm', want: 'f' });
  assert.equal((await a.next('me')).me.want, 'any');
  a.send({ t: 'invoice', plan: 'week' }); // в DEV выдаётся без оплаты
  assert.equal((await a.next('me')).me.premium, true);
  a.send({ t: 'profile', want: 'f' });
  assert.equal((await a.next('me')).me.want, 'f');
  a.ws.close();
});

test('автомодерация: страйк, потом бан', async t => {
  const mod = await fakeModeration();
  t.after(() => mod.close());
  const port = await startServer(t, {
    MODERATION_URL: `http://127.0.0.1:${mod.address().port}`, MODERATION_TOKEN: 'mod-secret',
    STRIKES_TO_BAN: '2', FRAME_INTERVAL_MS: '100',
  });
  const bad = await client(port, 'dev-bad1'), good = await client(port, 'dev-good');
  assert.ok(bad.ready.moderation);

  bad.send({ t: 'find' }); good.send({ t: 'find' });
  await bad.next('matched');
  bad.send({ t: 'frame', jpg: 'clean' });
  await sleep(200);
  bad.send({ t: 'frame', jpg: 'NSFW' });
  assert.equal((await bad.next('warning')).strikes, 1);
  assert.equal((await good.next('peer_left')).reason, 'moderation');

  // Повторно с тем же человеком не сведёт — нужен новый собеседник
  good.ws.close(); // иначе новый человек сведётся с good, который снова в очереди
  await sleep(100);
  const other = await client(port, 'dev-oth1');
  other.send({ t: 'find' });
  await sleep(900);
  bad.send({ t: 'find' });
  await bad.next('matched');
  await sleep(200);
  bad.send({ t: 'frame', jpg: 'NSFW' });
  assert.ok((await bad.next('banned')).until > Date.now());
  other.ws.close();
});

test('вайб: контакты раскрываются только при взаимном нажатии; оценка ауры после разговора', async t => {
  const port = await startServer(t, { RATE_MIN_SECONDS: '0' });
  const a = await client(port, 'dev-vibe-a'), b = await client(port, 'dev-vibe-b');
  a.send({ t: 'find' }); b.send({ t: 'find' });
  await a.next('matched'); await b.next('matched');

  a.send({ t: 'vibe' });
  await a.next('vibe_sent');
  b.send({ t: 'vibe' });
  assert.equal((await a.next('vibe_match')).peer.id, 'dev-vibe-b');
  assert.equal((await b.next('vibe_match')).peer.id, 'dev-vibe-a');

  a.send({ t: 'game', data: { g: 'rps', pick: 'rock' } });
  assert.equal((await b.next('game')).data.pick, 'rock');

  await sleep(900);
  await sleep(800); // антиспам «Далее»
  a.send({ t: 'next' });
  await a.next('rate_prompt'); await b.next('rate_prompt');
  b.send({ t: 'rate', v: 1 });
  await b.next('rated');
  a.ws.close(); b.ws.close();
});

test('языки, комнаты и реферал через параметр запуска', async t => {
  const port = await startServer(t);
  const en = await client(port, 'dev-lang-en');
  en.send({ t: 'profile', langs: ['en'] });
  assert.deepEqual((await en.next('me')).me.langs, ['en']);
  const ru = await client(port, 'dev-lang-ru');
  en.send({ t: 'find' }); ru.send({ t: 'find' });
  await ru.next('waiting');
  await sleep(300);
  assert.equal(en.ready.me.langs.length, 1);

  // Комната канала: в общей очереди её участника не видно
  const r1 = await client(port, 'dev-room-1', { startParam: 'room_chan1' });
  assert.equal(r1.ready.room.slug, 'chan1');
  r1.send({ t: 'find' });
  await r1.next('waiting');
  const r2 = await client(port, 'dev-room-2', { startParam: 'room_chan1' });
  r2.send({ t: 'find' });
  await r2.next('matched');

  // Реферал: новый пользователь по ссылке — Premium обоим
  // Новая ссылка — по публичному коду (не Telegram ID); старый формат ref_<id> тоже работает
  const code = ru.ready.me.shareLink.split('/r/')[1];
  assert.match(code, /^[a-z0-9]{6,7}$/);
  assert.ok(ru.ready.me.refLink.endsWith(`ref_${code}`));
  const fresh = await client(port, 'dev-newbie', { startParam: `ref_${code}` });
  assert.equal(fresh.ready.referred, true);
  assert.equal(fresh.ready.me.premium, true);
  assert.equal((await ru.next('referral')).t, 'referral');
  for (const c of [en, ru, r1, r2, fresh]) c.ws.close();
});

test('Aura Hour: раунд заканчивается по таймеру и всех пересаживают', async t => {
  const now = new Date(Date.now() + 3 * 3600_000);
  const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const port = await startServer(t, { EVENT_TIME: hhmm, TZ_OFFSET_HOURS: '3', ROUND_SECONDS: '1', EVENT_MINUTES: '5' });
  const a = await client(port, 'dev-ev-a'), b = await client(port, 'dev-ev-b');
  assert.equal(a.ready.event.active, true);
  a.send({ t: 'find' }); b.send({ t: 'find' });
  await a.next('matched');
  await a.next('round_end');
  await b.next('round_end');
  a.ws.close(); b.ws.close();
});

test('возраст: два кадра «похоже на несовершеннолетнего» из трёх — блок на сутки', async t => {
  const mod = await fakeModeration();
  t.after(() => mod.close());
  const port = await startServer(t, {
    MODERATION_URL: `http://127.0.0.1:${mod.address().port}`, MODERATION_TOKEN: 'mod-secret', FRAME_INTERVAL_MS: '100',
  });
  const kid = await client(port, 'dev-kid1'), other = await client(port, 'dev-adult');
  kid.send({ t: 'find' }); other.send({ t: 'find' });
  await kid.next('matched');
  kid.send({ t: 'frame', jpg: 'KID' });
  await sleep(200);
  kid.send({ t: 'frame', jpg: 'clean' });
  await sleep(200);
  kid.send({ t: 'frame', jpg: 'KID' });
  const b = await kid.next('banned');
  assert.equal(b.reason, 'age');
  assert.equal((await other.next('peer_left')).reason, 'moderation');
  other.ws.close();
});

test('паспорт: страна из заголовка Cloudflare, штамп за новую страну; «Сначала голос» сводит одинаковых', async t => {
  const port = await startServer(t, { STATS: '1' });
  const br = await client(port, 'dev-pass-br', {}, { 'cf-ipcountry': 'BR' });
  const de = await client(port, 'dev-pass-de', {}, { 'cf-ipcountry': 'DE' });
  assert.equal(br.ready.me.country, 'BR');
  br.send({ t: 'find' }); de.send({ t: 'find' });
  const m = await br.next('matched');
  // «Угадай, откуда он»: страна скрыта, 4 варианта, штамп приходит вместе с ответом
  assert.equal(m.peer.country, null);
  assert.equal(m.reveal, false);
  assert.equal(m.peer.guess.options.length, 4);
  assert.ok(m.peer.guess.options.includes('DE'));
  br.send({ t: 'guess', country: 'DE' });
  const g = await br.next('guess_result');
  assert.deepEqual([g.ok, g.country, g.stamp.country, g.stamp.total], [true, 'DE', 'DE', 1]);
  await until(br, 'me', m => m.me.aura === 110);
  const wrong = (await de.next('matched')).peer.guess.options.find(c => c !== 'BR');
  de.send({ t: 'guess', country: wrong });
  assert.equal((await de.next('guess_result')).ok, false);

  // Оба в режиме «Сначала голос» → reveal: true
  const v1 = await client(port, 'dev-voice-1'), v2 = await client(port, 'dev-voice-2');
  v1.send({ t: 'profile', reveal: true }); await v1.next('me');
  v2.send({ t: 'profile', reveal: true }); await v2.next('me');
  v1.send({ t: 'find' }); v2.send({ t: 'find' });
  assert.equal((await v1.next('matched')).reveal, true);
  for (const c of [br, de, v1, v2]) c.ws.close();
});

test('комплимент после разговора, реакции и салюты, итоги недели', async t => {
  const port = await startServer(t, { RATE_MIN_SECONDS: '0' });
  const a = await client(port, 'dev-cmp-a'), b = await client(port, 'dev-cmp-b');
  a.send({ t: 'find' }); b.send({ t: 'find' });
  await a.next('matched'); await b.next('matched');

  a.send({ t: 'react', kind: 'fire' });
  assert.equal((await b.next('react')).kind, 'fire');
  await sleep(320);
  a.send({ t: 'react', kind: 'salute' });
  await a.next('need_salutes');
  await sleep(320);
  a.send({ t: 'invoice', plan: 'salute5' }); // dev: без оплаты
  await a.next('invoice');
  await until(a, 'me', m => m.me.salutes === 5);
  a.send({ t: 'react', kind: 'salute' });
  assert.equal((await b.next('react')).kind, 'salute');
  const bm = (await until(b, 'me', m => m.me.salutesReceived === 1)).me;
  assert.equal(bm.aura, 105);

  await sleep(800); // антиспам «Далее»
  a.send({ t: 'next' });
  await a.next('rate_prompt');
  a.send({ t: 'compliment', kind: 'smile' });
  await a.next('complimented');
  assert.equal((await b.next('compliment')).kind, 'smile');
  b.send({ t: 'wrapped' });
  const w = (await b.next('wrapped')).data;
  assert.equal(w.chats, 1);
  assert.deepEqual(w.compliments, { smile: 1 });
  assert.equal(w.archetype, 'sunny');
  a.ws.close(); b.ws.close();
});

test('Duo: приглашение по коду, поиск пары, сигналы по слотам, чат на четверых', async t => {
  const port = await startServer(t);
  const [a1, a2, b1, b2] = await Promise.all(['dev-duo-a1', 'dev-duo-a2', 'dev-duo-b1', 'dev-duo-b2'].map(id => client(port, id)));
  a1.send({ t: 'duo_create' });
  const code = (await a1.next('duo')).duo.code;
  a2.send({ t: 'duo_join', code });
  assert.equal((await a2.next('duo')).duo.size, 2);
  a1.send({ t: 'duo_search' });
  await a1.next('duo_waiting');

  // Вторая пара входит по ссылке duo_<код>
  const b1c = await client(port, 'dev-duo-b1x');
  b1c.send({ t: 'duo_create' });
  const code2 = (await b1c.next('duo')).duo.code;
  const b2c = await client(port, 'dev-duo-b2x', { startParam: `duo_${code2}` });
  assert.equal((await b2c.next('duo')).duo.size, 2);
  b2c.send({ t: 'duo_search' });
  const ms = await Promise.all([a1, a2, b1c, b2c].map(c => c.next('duo_matched')));
  assert.deepEqual(ms.map(m => m.you).sort(), [0, 1, 2, 3]);
  assert.equal(ms[0].peers.length, 3);

  a1.send({ t: 'duo_signal', to: ms[3].you, data: { sdp: 'x' } });
  const sig = await b2c.next('duo_signal');
  assert.deepEqual([sig.from, sig.data.sdp], [ms[0].you, 'x']);
  a2.send({ t: 'chat', text: 'привет' });
  assert.equal((await b1c.next('chat')).text, 'привет');

  a1.send({ t: 'duo_leave' });
  for (const c of [a2, b1c, b2c]) assert.equal((await c.next('duo_ended')).reason, 'partner_left');
  for (const c of [a1, a2, b1, b2, b1c, b2c]) c.ws.close();
});

test('админ-API: без токена закрыт, с токеном — обзор, поиск, бан/разбан, Premium, графики', async t => {
  const port = await startServer(t, { ADMIN_API_TOKEN: 'adm-secret-token-0123456789' });
  const call = async (p, { method = 'GET', body, token = 'adm-secret-token-0123456789' } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/${p}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  assert.equal((await call('overview', { token: 'wrong' })).status, 401);

  const a = await client(port, 'dev-adm-a'), b = await client(port, 'dev-adm-b');
  a.send({ t: 'find' }); b.send({ t: 'find' });
  await a.next('matched');

  const o = (await call('overview')).data;
  assert.equal(o.live.online, 2);
  assert.equal(o.live.talking, 2);
  assert.ok(o.totals.users >= 2);

  const list = (await call('users?q=dev-adm-a')).data;
  assert.equal(list.users[0].id, 'dev-adm-a');
  assert.equal(list.users[0].online, true);

  assert.equal((await call('users/dev-adm-b/premium', { method: 'POST', body: { days: 3 } })).data.ok, true);
  await until(b, 'me', m => m.me.premium === true);

  assert.equal((await call('users/dev-adm-a/ban', { method: 'POST', body: { hours: 2, reason: 'test' } })).status, 200);
  assert.ok((await a.next('banned')).until > Date.now());
  const d = (await call('users/dev-adm-a')).data;
  assert.equal(d.user.banReason, 'test');
  assert.equal((await call('users/dev-adm-a/unban', { method: 'POST', body: {} })).data.ok, true);
  assert.equal((await call('users/dev-adm-a')).data.user.bannedUntil, 0);

  const ad = await client(port, 'dev-adm-ad', { startParam: 'ad_ru_test' });
  const src = (await call('sources?days=7')).data;
  assert.ok(src.appLink.includes('ad_CODE'));
  ad.ws.close();
  assert.equal((await call('users/dev-adm-ad')).data.user.id, 'dev-adm-ad');

  const s = (await call('series?days=7')).data;
  assert.equal(s.length, 7);
  assert.ok(s.at(-1).matches >= 1);
  assert.equal((await call('users/nope/ban', { method: 'POST', body: {} })).status, 400);
  b.ws.close();
});

test('чат: ссылки и контакты скрываются, тяжёлое не доставляется, 3 нарушения — бан', async t => {
  const port = await startServer(t);
  const a = await client(port, 'dev-chat-a'), b = await client(port, 'dev-chat-b');
  a.send({ t: 'find' }); b.send({ t: 'find' });
  await a.next('matched'); await b.next('matched');
  a.send({ t: 'chat', text: 'пиши мне @kate_super или t.me/kate' });
  assert.equal((await b.next('chat')).text, 'пиши мне @••• или 🔗•••');
  assert.equal((await a.next('chat_masked')).reason, 'contact');
  for (let i = 1; i <= 2; i++) {
    await sleep(450);
    a.send({ t: 'chat', text: 'скинь нюдсы' });
    assert.equal((await a.next('chat_blocked')).strikes, i);
  }
  await sleep(450);
  a.send({ t: 'chat', text: 'скинь нюдсы' });
  await a.next('banned');
  await assert.rejects(b.next('chat'));
  b.ws.close();
});

test('модерация: без кадров камеры разговор прерывается', async t => {
  const mod = await fakeModeration();
  t.after(() => mod.close());
  const port = await startServer(t, {
    MODERATION_URL: `http://127.0.0.1:${mod.address().port}`, MODERATION_TOKEN: 'mod-secret',
    FRAME_GRACE_MS: '800', FRAME_MAX_GAP_MS: '600', FRAME_INTERVAL_MS: '100',
  });
  await sleep(300); // первая проверка здоровья модерации
  const ok = await client(port, 'dev-fr-ok'), silent = await client(port, 'dev-fr-silent');
  ok.send({ t: 'find' }); silent.send({ t: 'find' });
  await ok.next('matched');
  const timer = setInterval(() => ok.send({ t: 'frame', jpg: 'x'.repeat(2000) }), 150);
  t.after(() => clearInterval(timer));
  assert.equal((await silent.next('error')).code, 'no_frames');
  await silent.next('stopped');
  assert.equal((await ok.next('peer_left')).reason, 'moderation');
  clearInterval(timer);
  ok.ws.close(); silent.ws.close();
});
