import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateInitData } from '../src/auth.js';
import { Matchmaker } from '../src/matchmaker.js';
import { Db } from '../src/db.js';
import { EventSchedule, localDay } from '../src/events.js';
import { normalizeLangs } from '../src/langs.js';
import { botProfile, pickLang } from '../src/bot-profile.js';

const TOKEN = '123456:TEST-token';

export function signInitData(fields, token = TOKEN) {
  const params = new URLSearchParams(fields);
  const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const fresh = () => String(Math.floor(Date.now() / 1000));

test('initData: валидная подпись принимается', () => {
  const data = signInitData({ auth_date: fresh(), query_id: 'q', user: JSON.stringify({ id: 42, language_code: 'ru' }) });
  const u = validateInitData(data, TOKEN);
  assert.equal(u.id, '42');
  assert.equal(u.lang, 'ru');
});

test('initData: подделка, чужой токен и протухшая дата отклоняются', () => {
  const user = JSON.stringify({ id: 42 });
  const ok = signInitData({ auth_date: fresh(), user });
  assert.equal(validateInitData(ok.replace('42', '43'), TOKEN), null);
  assert.equal(validateInitData(signInitData({ auth_date: fresh(), user }, '1:other'), TOKEN), null);
  assert.equal(validateInitData(signInitData({ auth_date: '1000', user }), TOKEN), null);
  assert.equal(validateInitData('', TOKEN), null);
});

const mk = (id, extra = {}) => ({ id, gender: 'x', want: 'any', premium: false, langs: ['ru'], room: null, tier: 'ok', inbox: [], send(m) { this.inbox.push(m.t); }, ...extra });

test('matchmaker: сводит двоих, не сводит себя с собой', () => {
  const mm = new Matchmaker();
  const a = mk('a'), a2 = mk('a'), b = mk('b');
  mm.enqueue(a); mm.enqueue(a2);
  assert.equal(mm.peerOf(a), null);
  mm.enqueue(b);
  assert.equal(mm.peerOf(b), a);
  assert.equal(a.inbox.at(-1), 'matched');
});

test('matchmaker: последний собеседник только после ожидания', () => {
  const mm = new Matchmaker({ rematchAfterMs: 10_000 });
  const a = mk('a'), b = mk('b');
  mm.enqueue(a, 0); mm.enqueue(b, 0);
  mm.leave(a);
  mm.enqueue(b, 1000);
  mm.enqueue(a, 1000);
  assert.equal(mm.peerOf(a), null, 'сразу не сводим повторно');
  mm.tick(5000);
  assert.equal(mm.peerOf(a), null);
  mm.tick(12_000);
  assert.equal(mm.peerOf(a), b, 'после ожидания сводим');
});

test('matchmaker: фильтр по полу работает в обе стороны', () => {
  const mm = new Matchmaker();
  const boy = mk('boy', { gender: 'm', want: 'f', premium: true });
  const boy2 = mk('boy2', { gender: 'm' });
  const girl = mk('girl', { gender: 'f' });
  mm.enqueue(boy); mm.enqueue(boy2);
  assert.equal(mm.peerOf(boy2), null, 'парень с фильтром «девушки» не сводится с парнем');
  mm.enqueue(girl);
  assert.equal(mm.peerOf(girl), boy);
});

test('matchmaker: премиум получает собеседника раньше', () => {
  const mm = new Matchmaker();
  const regular = mk('r'), vip = mk('v', { premium: true }), newcomer = mk('n');
  mm.enqueue(regular, 0);
  // regular и vip сразу сведутся — разведём через фильтр, чтобы оба ждали
  regular.want = 'f'; vip.want = 'f'; vip.gender = 'm'; regular.gender = 'm';
  mm.leave(regular); mm.enqueue(regular, 0); mm.enqueue(vip, 1);
  regular.want = 'any'; vip.want = 'any';
  mm.enqueue(newcomer, 2);
  assert.equal(mm.peerOf(newcomer), vip);
});

test('db: жалобы до порога, бан, разбан', () => {
  const db = new Db(':memory:', { reportsToBan: 2 });
  assert.equal(db.report('x', 'r1', 'spam'), 0);
  assert.equal(db.report('x', 'r1', 'spam'), 0, 'повторная жалоба того же человека не считается');
  assert.ok(db.report('x', 'r2', 'abuse') > Date.now());
  assert.ok(db.bannedUntil('x'));
  db.unban('x');
  assert.equal(db.bannedUntil('x'), 0);
});

test('db: платёж идемпотентен, премиум продлевается, возврат списывает', () => {
  const db = new Db(':memory:');
  const now = Date.now();
  const u1 = db.addPayment({ chargeId: 'c1', userId: 'u', plan: 'week', stars: 75, days: 7 }, now);
  assert.equal(db.addPayment({ chargeId: 'c1', userId: 'u', plan: 'week', stars: 75, days: 7 }, now), u1);
  const u2 = db.addPayment({ chargeId: 'c2', userId: 'u', plan: 'month', stars: 199, days: 30 }, now);
  assert.equal(u2 - u1, 30 * 864e5);
  assert.equal(db.stats().stars, 274);
  db.markRefunded('c2', 30);
  assert.equal(db.user('u').premium_until, u1);
  assert.equal(db.markRefunded('c2', 30), null);
});

test('initData: start_param и username доступны после проверки подписи', () => {
  const data = signInitData({ auth_date: fresh(), start_param: 'room_abc', user: JSON.stringify({ id: 7, username: 'neo', first_name: 'Neo', allows_write_to_pm: true }) });
  const u = validateInitData(data, TOKEN);
  assert.equal(u.startParam, 'room_abc');
  assert.equal(u.username, 'neo');
  assert.equal(u.allowsPm, true);
});

test('языки: нормализация и матчинг только при общем языке', () => {
  assert.deepEqual(normalizeLangs(['EN', 'xx', 'ru', 'en']), ['en', 'ru']);
  assert.deepEqual(normalizeLangs('', 'de'), ['de']);
  const mm = new Matchmaker();
  const ru = mk('ru1'), en = mk('en1', { langs: ['en'] }), both = mk('both', { langs: ['ru', 'en'] });
  mm.enqueue(ru); mm.enqueue(en);
  assert.equal(mm.peerOf(ru), null, 'нет общего языка — не сводим');
  mm.enqueue(both);
  assert.equal(mm.peerOf(both), ru, 'общий русский');
});

test('комнаты: сводим только внутри своей комнаты', () => {
  const mm = new Matchmaker();
  const a = mk('a', { room: 'chan' }), b = mk('b'), c = mk('c', { room: 'chan' });
  mm.enqueue(a); mm.enqueue(b);
  assert.equal(mm.peerOf(a), null);
  mm.enqueue(c);
  assert.equal(mm.peerOf(c), a);
});

test('аура: низкий уровень не смешивается с обычным, пока оба не подождут', () => {
  const mm = new Matchmaker({ tierRelaxMs: 15_000 });
  const troll = mk('t', { tier: 'low' }), nice = mk('n');
  mm.enqueue(troll, 0); mm.enqueue(nice, 0);
  assert.equal(mm.peerOf(troll), null);
  mm.tick(16_000);
  assert.equal(mm.peerOf(troll), nice);
});

test('matchmaker: onUnpair получает длительность разговора', () => {
  let got = null;
  const mm = new Matchmaker({ onUnpair: (a, b, ms) => { got = ms; } });
  const a = mk('a'), b = mk('b');
  mm.enqueue(a, 1000); mm.enqueue(b, 1000);
  mm.leave(a, undefined, 21_000);
  assert.equal(got, 20_000);
});

test('db: реферал — только новый, не сам себя, бонус обоим', () => {
  const db = new Db(':memory:');
  db.user('old');
  assert.equal(db.applyReferral('old', 'old'), false);
  assert.equal(db.applyReferral('new', 'ghost'), false, 'пригласивший должен существовать');
  assert.equal(db.applyReferral('new', 'old'), true);
  assert.equal(db.applyReferral('new', 'old'), false, 'второй раз не начисляем');
  assert.ok(db.user('new').premium_until > Date.now());
  assert.ok(db.user('old').premium_until > Date.now());
  assert.equal(db.user('old').referrals, 1);
});

test('db: бесплатные подборы по фильтру сбрасываются каждый день', () => {
  const db = new Db(':memory:');
  assert.equal(db.filterLeft('u', '2026-10-11', 2), 2);
  db.useFilter('u', '2026-10-11'); db.useFilter('u', '2026-10-11');
  assert.equal(db.filterLeft('u', '2026-10-11', 2), 0);
  assert.equal(db.filterLeft('u', '2026-10-12', 2), 2);
});

test('db: серия дней растёт подряд и сбрасывается после пропуска', () => {
  const db = new Db(':memory:');
  assert.deepEqual(db.bumpStreak('u', '2026-10-10', '2026-10-09'), { streak: 1, bumped: true });
  assert.deepEqual(db.bumpStreak('u', '2026-10-10', '2026-10-09'), { streak: 1, bumped: false });
  assert.deepEqual(db.bumpStreak('u', '2026-10-11', '2026-10-10'), { streak: 2, bumped: true });
  assert.deepEqual(db.bumpStreak('u', '2026-10-13', '2026-10-12'), { streak: 1, bumped: true });
});

test('db: оценка ауры — одна от человека в сутки', () => {
  const db = new Db(':memory:');
  assert.equal(db.rate('a', 'b', 1), true);
  assert.equal(db.rate('a', 'b', 1), false);
  assert.equal(db.rate('b', 'b', 1), false);
  assert.equal(db.user('b').karma_up, 1);
});

test('db: комнаты создаются и считают заходы', () => {
  const db = new Db(':memory:');
  const r = db.createRoom('owner', 'Мой канал');
  db.roomVisit(r.slug); db.roomMatch(r.slug);
  assert.equal(db.room(r.slug).visits, 1);
  assert.equal(db.roomsOf('owner').length, 1);
});

test('событие: активно в окне, переходит через полночь, напоминание за 5 минут', () => {
  const s = new EventSchedule({ time: '21:00', tzOffsetHours: 3, minutes: 60 });
  const at = iso => Date.parse(iso);
  assert.equal(s.state(at('2026-10-11T18:30:00Z')).active, true);   // 21:30 МСК
  assert.equal(s.state(at('2026-10-11T17:00:00Z')).active, false);  // 20:00 МСК
  assert.ok(s.reminderDue(at('2026-10-11T17:57:00Z')));             // 20:57 МСК
  assert.equal(s.reminderDue(at('2026-10-11T17:40:00Z')), null);
  const late = new EventSchedule({ time: '23:30', tzOffsetHours: 3, minutes: 60 });
  assert.equal(late.state(at('2026-10-11T21:10:00Z')).active, true); // 00:10 МСК следующего дня
  assert.equal(localDay(at('2026-10-11T22:00:00Z'), 3), '2026-10-12');
});

test('профиль бота: все языки укладываются в лимиты Telegram', () => {
  const p = botProfile({ appName: 'Aura', eventTime: '21:00' });
  assert.ok(Object.keys(p).length >= 17);
  for (const [lang, v] of Object.entries(p)) {
    assert.ok(v.name.length <= 64, `${lang} name`);
    assert.ok(v.short.length <= 120, `${lang} short`);
    assert.ok(v.description.length <= 512, `${lang} description`);
    assert.equal(v.commands.length, 6, `${lang} commands`);
    assert.ok(!v.description.includes('{'), `${lang} placeholders`);
  }
  assert.equal(pickLang('pt-br'), 'pt');
  assert.equal(pickLang('ja'), 'en');
});

test('db: паспорт и воронка метрик', () => {
  const db = new Db(':memory:');
  assert.equal(db.stamp('u', 'BR'), true);
  assert.equal(db.stamp('u', 'BR'), false);
  assert.equal(db.stamp('u', 'XX'), false, 'неизвестная страна не считается');
  assert.deepEqual(db.passport('u'), ['BR']);
  db.event('session', 'u'); db.event('match', 'u', 4000); db.event('call_end', 'u', 3000); db.event('call_end', 'u', 60000);
  const f = db.funnel();
  assert.equal(f.dau, 1);
  assert.equal(f.matches, 1);
  assert.equal(f.quickSkipPct, 50);
});
