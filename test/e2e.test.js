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
  const fresh = await client(port, 'dev-newbie', { startParam: 'ref_dev-lang-ru' });
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
  assert.equal(m.peer.country, 'DE');
  assert.equal(m.reveal, false);
  const st = await br.next('stamp');
  assert.deepEqual([st.country, st.total], ['DE', 1]);

  // Оба в режиме «Сначала голос» → reveal: true
  const v1 = await client(port, 'dev-voice-1'), v2 = await client(port, 'dev-voice-2');
  v1.send({ t: 'profile', reveal: true }); await v1.next('me');
  v2.send({ t: 'profile', reveal: true }); await v2.next('me');
  v1.send({ t: 'find' }); v2.send({ t: 'find' });
  assert.equal((await v1.next('matched')).reveal, true);
  for (const c of [br, de, v1, v2]) c.ws.close();
});
