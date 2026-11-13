import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.js';
import { createAnalytics, normalizePlatform } from '../src/analytics.js';
import { resolveStartParam, staticRegistry } from '../src/attribution.js';

const memDb = () => new Db(':memory:');
const mk = (db, env = {}) => createAnalytics({ db, env });
const T0 = Date.parse('2026-11-02T10:00:00Z');
const registry = new Map(staticRegistry().map(r => [r.token, r]));

test('реестр: exact lookup, мусор отвергается, r1_ требует существующего referrer', () => {
  const resolver = k => (k === 42 || k === 'code42' ? '42' : null);
  assert.equal(resolveStartParam('a1_tt_v01', registry, resolver).utm.utm_source, 'tiktok');
  assert.equal(resolveStartParam('a1_dir_miniappsme', registry, resolver).utm.utm_source, 'miniapps_me');
  assert.equal(resolveStartParam('a1_hn_p02', registry, resolver).utm.placement_id, 'hn_p02');
  assert.equal(resolveStartParam('a1_tt_v13', registry, resolver), null); // незарегистрированный
  assert.equal(resolveStartParam('src_seo', registry, resolver).kind, 'legacy');
  assert.equal(resolveStartParam('r1_16', registry, resolver).referrerId, '42'); // base36(42)='16'
  assert.equal(resolveStartParam('r1_zzz', registry, resolver), null);
  assert.equal(resolveStartParam('ref_code42', registry, resolver).referrerId, '42');
  assert.equal(resolveStartParam('oops!', registry, resolver), null);
  assert.equal(resolveStartParam('x'.repeat(65), registry, resolver), null);
});

test('first touch: первое подтверждённое касание не перезаписывается; органика unknown', () => {
  const db = memDb(); const a = mk(db);
  const u = '1001';
  a.onValidatedOpen({ userId: u, startParam: 'a1_tt_v01', kind: 'initdata', at: T0, platform: 'android' });
  let row = db.user(u);
  assert.equal(row.utm_source, 'tiktok');
  assert.equal(row.first_touch_token, 'a1_tt_v01');
  // повторное открытие с другим токеном — не перезаписывает
  a.onValidatedOpen({ userId: u, startParam: 'a1_hn_p01', kind: 'initdata', at: T0 + 1000, platform: 'android' });
  row = db.user(u);
  assert.equal(row.first_touch_token, 'a1_tt_v01');
  // органика без токена
  a.onValidatedOpen({ userId: '1002', kind: 'initdata', at: T0, platform: 'ios' });
  assert.equal(db.user('1002').utm_source, 'unknown');
  // два открытия — две сессии, две записи mini_app_open
  const opens = db.db.prepare("SELECT session_id FROM events_v2 WHERE event_name='mini_app_open' AND user_id=?").all(u);
  assert.equal(opens.length, 2);
  assert.notEqual(opens[0].session_id, opens[1].session_id);
  // invalid token — только технический счётчик, источник не меняется
  a.onValidatedOpen({ userId: u, startParam: 'a1_bogus', kind: 'initdata', at: T0 + 2000 });
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM events_v2 WHERE event_name='invalid_start_token'").get().n, 1);
  assert.equal(db.user(u).first_touch_token, 'a1_tt_v01');
});

test('активация: ≥30 с одна строка на жизнь, 29.999 с — ноль, ≥120 good_conversation на пару', () => {
  const db = memDb(); const a = mk(db);
  const [u1, u2] = ['2001', '2002'];
  // звонок 29.999 с — не активация
  let c = cryptoCall(a, u1, u2, T0);
  a.onConnOk({ callId: c, userId: u1, at: T0 + 1000 });
  a.onCallEnd({ callId: c, at: T0 + 1000 + 29_999 });
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM events_v2 WHERE event_name='first_useful_action'").get().n, 0);
  // звонок ровно 30 с — активация у обоих участников (user-level события, один call_id)
  c = cryptoCall(a, u1, u2, T0 + 60_000);
  a.onConnOk({ callId: c, userId: u1, at: T0 + 61_000 });
  a.onCallEnd({ callId: c, at: T0 + 61_000 + 30_000 });
  const fua = db.db.prepare("SELECT user_id FROM events_v2 WHERE event_name='first_useful_action'").all();
  assert.deepEqual(fua.map(r => r.user_id).sort(), ['2001', '2002']);
  // ещё один ≥30 с — второй строки у того же пользователя нет (partial unique)
  c = cryptoCall(a, u1, u2, T0 + 200_000);
  a.onConnOk({ callId: c, userId: u1, at: T0 + 201_000 });
  a.onCallEnd({ callId: c, at: T0 + 201_000 + 40_000 });
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM events_v2 WHERE event_name='first_useful_action' AND user_id=?").get(u1).n, 1);
  // 119.999 — нет good; 120.000 — есть, по строке на каждого участника
  c = cryptoCall(a, u1, u2, T0 + 400_000);
  a.onConnOk({ callId: c, userId: u1, at: T0 + 401_000 });
  a.onCallEnd({ callId: c, at: T0 + 401_000 + 119_999 });
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM events_v2 WHERE event_name='good_conversation'").get().n, 0);
  c = cryptoCall(a, u1, u2, T0 + 600_000);
  a.onConnOk({ callId: c, userId: u1, at: T0 + 601_000 });
  a.onCallEnd({ callId: c, at: T0 + 601_000 + 120_000 });
  const good = db.db.prepare("SELECT user_id FROM events_v2 WHERE event_name='good_conversation'").all();
  assert.deepEqual(good.map(r => r.user_id).sort(), ['2001', '2002']);
});

test('без conn_ok разговор не верифицирован: call_end есть, активации нет', () => {
  const db = memDb(); const a = mk(db);
  const c = cryptoCall(a, '3001', '3002', T0);
  a.onCallEnd({ callId: c, at: T0 + 90_000 });
  const ev = db.db.prepare("SELECT * FROM events_v2 WHERE event_name='call_end' AND user_id='3001'").get();
  assert.equal(ev.duration_ms, null);
  assert.match(ev.properties_json, /duration_unknown/);
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM events_v2 WHERE event_name='first_useful_action'").get().n, 0);
});

test('рефералка: кандидат до активации, награда и событие ровно один раз после 30 с', () => {
  const db = memDb(); const a = mk(db);
  db.user('4001'); // пригласивший
  const invitee = '4002';
  const r = a.onValidatedOpen({ userId: invitee, startParam: 'r1_' + (4001).toString(36), kind: 'initdata', at: T0 });
  assert.equal(r.resolution.referrerId, '4001');
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM events_v2 WHERE event_name='invite_open'").get().n, 1);
  // повторное открытие — новой кандидатуры нет
  a.onValidatedOpen({ userId: invitee, startParam: 'r1_' + (4001).toString(36), kind: 'initdata', at: T0 + 1000 });
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM events_v2 WHERE event_name='invite_open'").get().n, 1);
  // звонок <30 с — награды нет
  let c = cryptoCall(a, invitee, '4003', T0 + 5000);
  a.onConnOk({ callId: c, userId: invitee, at: T0 + 6000 });
  a.onCallEnd({ callId: c, at: T0 + 6000 + 10_000 });
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM events_v2 WHERE event_name='referred_first_useful_action'").get().n, 0);
  // ≥30 с — ровно одно событие и премия
  const before = db.user('4001').premium_until;
  c = cryptoCall(a, invitee, '4003', T0 + 20_000);
  a.onConnOk({ callId: c, userId: invitee, at: T0 + 21_000 });
  a.onCallEnd({ callId: c, at: T0 + 21_000 + 35_000 });
  const ev = db.db.prepare("SELECT * FROM events_v2 WHERE event_name='referred_first_useful_action'").all();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].user_id, '4001');
  assert.ok(db.user('4001').premium_until > before);
  // третий звонок ≥30 с — второго referred нет
  c = cryptoCall(a, invitee, '4003', T0 + 100_000);
  a.onConnOk({ callId: c, userId: invitee, at: T0 + 101_000 });
  a.onCallEnd({ callId: c, at: T0 + 101_000 + 40_000 });
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM events_v2 WHERE event_name='referred_first_useful_action'").get().n, 1);
});

test('self-invite не даёт кандидата и first touch', () => {
  const db = memDb(); const a = mk(db);
  db.user('5001');
  const r = a.onValidatedOpen({ userId: '5001', startParam: 'r1_' + (5001).toString(36), kind: 'initdata', at: T0 });
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM events_v2 WHERE event_name='invite_open'").get().n, 0);
  assert.equal(db.user('5001').utm_source, 'unknown');
});

test('return_d1/d7: открытие на D0/D2 не даёт D1; на D1 даёт ровно одну строку', () => {
  const db = memDb(); const a = mk(db);
  const u = '6001';
  a.onValidatedOpen({ userId: u, kind: 'initdata', at: T0 });
  // активация на T0
  const c = cryptoCall(a, u, '6002', T0 + 1000);
  a.onConnOk({ callId: c, userId: u, at: T0 + 2000 });
  a.onCallEnd({ callId: c, at: T0 + 2000 + 30_000 });
  const DAY = 86_400_000;
  a.onValidatedOpen({ userId: u, kind: 'initdata', at: T0 + DAY / 2 });            // тот же день
  assert.equal(n(db, 'return_d1'), 0);
  a.onValidatedOpen({ userId: u, kind: 'initdata', at: T0 + DAY + 1000 });          // D1
  assert.equal(n(db, 'return_d1'), 1);
  a.onValidatedOpen({ userId: u, kind: 'initdata', at: T0 + DAY + 2000 });          // D1 повторно
  assert.equal(n(db, 'return_d1'), 1);
  a.onValidatedOpen({ userId: u, kind: 'initdata', at: T0 + 2 * DAY });             // D2 — не D1
  assert.equal(n(db, 'return_d1'), 1);
  a.onValidatedOpen({ userId: u, kind: 'initdata', at: T0 + 7 * DAY });             // D7
  assert.equal(n(db, 'return_d7'), 1);
  a.onValidatedOpen({ userId: u, kind: 'initdata', at: T0 + 6 * DAY });             // D6 — не D7 (уже поздно, проверка на exact)
  assert.equal(n(db, 'return_d7'), 1);
});

test('aura_hour_join: 20:45–21:30 UTC, один раз на пользователя за сутки', () => {
  const db = memDb(); const a = mk(db);
  const day = '2026-11-02';
  a.onSearchEnter({ userId: '7001', at: Date.parse(`${day}T20:44:59Z`) });
  assert.equal(n(db, 'aura_hour_join'), 0);
  a.onSearchEnter({ userId: '7001', at: Date.parse(`${day}T20:45:01Z`) });
  a.onSearchEnter({ userId: '7001', at: Date.parse(`${day}T21:00:00Z`) }); // повтор за день
  assert.equal(n(db, 'aura_hour_join'), 1);
  a.onSearchEnter({ userId: '7001', at: Date.parse(`${day}T21:31:00Z`) });
  assert.equal(n(db, 'aura_hour_join'), 1);
  a.onSearchEnter({ userId: '7002', at: Date.parse(`${day}T21:30:00Z`) });
  assert.equal(n(db, 'aura_hour_join'), 2);
});

test('searching_concurrency: 2 ищущих + 1 в разговоре = 2; повтор снапшота гасится', () => {
  const db = memDb(); const a = mk(db);
  const at = Date.parse('2026-11-02T20:50:00Z');
  a.onSearchEnter({ userId: '8001', at });
  a.onSearchEnter({ userId: '8002', at });
  a.onSearchEnter({ userId: '8003', at: at - 2000 });
  a.onSearchLeave({ userId: '8003', at: at - 1000 }); // ушёл в разговор до границы минуты
  assert.equal(a.searchingSnapshot({ at }), true);
  assert.equal(a.searchingSnapshot({ at }), false); // та же минута — не дублируется
  const row = db.db.prepare("SELECT * FROM events_v2 WHERE event_name='searching_concurrency'").get();
  assert.equal(row.searching_users, 2);
  assert.equal(row.user_id, '0');
  assert.equal(row.platform, 'system');
  assert.match(row.session_id, /^job:\d{8}$/);
});

test('onboarding_complete: первый полный профиль один раз', () => {
  const db = memDb(); const a = mk(db);
  const u = '9001';
  a.onValidatedOpen({ userId: u, kind: 'initdata', at: T0 });
  db.setProfile(u, { gender: 'x', want: 'any', langs: ['ru'] });
  assert.equal(a.onProfileSaved({ userId: u, at: T0 + 100 }), false); // пол не выбран
  db.setProfile(u, { gender: 'f', want: 'any', langs: ['ru'] });
  assert.equal(a.onProfileSaved({ userId: u, at: T0 + 200 }), true);
  assert.equal(a.onProfileSaved({ userId: u, at: T0 + 300 }), false); // повторный save — вторая строка не нужна
  assert.equal(n(db, 'onboarding_complete'), 1);
});

test('payment_success: replay webhook гасится бизнес-ключом', () => {
  const db = memDb(); const a = mk(db);
  assert.equal(a.paymentSuccess({ userId: '1101', paymentId: 'chg-1', amountMinor: 199, at: T0 }), true);
  assert.equal(a.paymentSuccess({ userId: '1101', paymentId: 'chg-1', amountMinor: 199, at: T0 + 5000 }), false);
  const row = db.db.prepare("SELECT * FROM events_v2 WHERE event_name='payment_success'").get();
  assert.equal(row.payment_id, 'chg-1');
  assert.match(row.properties_json, /"amount_minor":199/);
  assert.match(row.properties_json, /"currency":"XTR"/);
});

test('dev-пользователи получают is_test=1; platform нормализуется', () => {
  const db = memDb(); const a = mk(db);
  a.onValidatedOpen({ userId: 'dev-test1', kind: 'initdata', at: T0, platform: 'ios' });
  const row = db.db.prepare("SELECT * FROM events_v2 WHERE user_id='dev-test1' LIMIT 1").get();
  assert.equal(row.is_test, 1);
  assert.equal(row.platform, 'ios');
  assert.equal(normalizePlatform('tdesktop'), 'desktop');
  assert.equal(normalizePlatform('android_x'), 'android');
  assert.equal(normalizePlatform('webk'), 'desktop');
  assert.equal(normalizePlatform(''), 'unknown');
});

test('each event carries mandatory contract fields', () => {
  const db = memDb(); const a = mk(db);
  a.onValidatedOpen({ userId: '1201', startParam: 'a1_rd_p01', kind: 'initdata', at: T0, platform: 'desktop' });
  const rows = db.db.prepare("SELECT * FROM events_v2 WHERE user_id='1201'").all();
  assert.ok(rows.length >= 3);
  for (const r of rows) {
    assert.match(r.event_id, /^[0-9a-f-]{36}$/);
    assert.match(r.occurred_at_utc, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assert.ok(r.user_id && r.session_id);
    assert.ok(r.utm_source);            // unknown допустим, пусто — нет
    assert.ok(r.app_version);
    assert.ok(r.platform);
    assert.equal(r.event_schema_version, 1);
  }
});

function cryptoCall(a, u1, u2, at) {
  const callId = 'call-' + Math.random().toString(36).slice(2);
  a.onMatch({ callId, a: u1, b: u2, sessionA: 's1', sessionB: 's2', at });
  return callId;
}
const n = (db, name) => db.db.prepare('SELECT COUNT(*) n FROM events_v2 WHERE event_name=?').get(name).n;

test('HOM-31: веб-аноним (kind=web_anon) не тестовый и помечен в событии', () => {
  const db = memDb(); const a = mk(db);
  a.onValidatedOpen({ userId: 'web-abc123', kind: 'web_anon', at: T0, platform: 'web' });
  const open = db.db.prepare("SELECT * FROM events_v2 WHERE event_name='mini_app_open' AND user_id='web-abc123'").get();
  assert.match(open.properties_json, /"auth_kind":"web_anon"/);
  const row = db.db.prepare("SELECT is_test FROM users WHERE id='web-abc123'").get();
  assert.equal(Number(row.is_test), 0);
});

// ---------- HOM-36: веб-атрибуция ?src= / ?ref= ----------

test('HOM-36: веб-токены первой волны в реестре; dir_/yt_/tt_ — по схеме без правки реестра', () => {
  const resolver = k => (k === 'code42' ? '42' : null);
  const reg = new Map(staticRegistry().map(r => [r.token, r]));
  for (const t of ['seo_ru', 'seo_en', 'seo_es', 'seo_tr', 'seo_uk', 'seo_id', 'blog_cta', 'share_story', 'invite_link', 'qr', 'pwa']) {
    const r = resolveStartParam(t, reg, resolver);
    assert.ok(r, t);
    assert.ok(r.utm.utm_source, t);
  }
  // dir_<любой slug> — валиден без регистрации (живые листинги Growth правит только по URL)
  const dir = resolveStartParam('dir_newcatalog-2', reg, resolver);
  assert.equal(dir.kind, 'scheme');
  assert.equal(dir.utm.utm_medium, 'directory');
  assert.equal(dir.utm.utm_source, 'newcatalog_2');
  assert.equal(resolveStartParam('yt_13', reg, resolver).utm.utm_source, 'youtube_shorts');
  assert.equal(resolveStartParam('tt_7', reg, resolver).utm.utm_source, 'tiktok');
  assert.equal(resolveStartParam('yt_100', reg, resolver), null);   // вне схемы (1-99)
  assert.equal(resolveStartParam('dir_', reg, resolver), null);     // пустой slug
  assert.equal(resolveStartParam('test_manual', reg, resolver).kind, 'test');
});

test('HOM-36: ?src= фиксирует first touch, регистрирует схемный токен, первое касание не перезаписывается', () => {
  const db = memDb(); const a = mk(db);
  const u = 'web-src-1';
  a.onValidatedOpen({ userId: u, startParam: 'dir_newcatalog-2', kind: 'web_anon', at: T0, platform: 'web' });
  let row = db.user(u);
  assert.equal(row.first_touch_token, 'dir_newcatalog-2');
  assert.equal(row.utm_source, 'newcatalog_2');
  // токен схемы попал в attribution_tokens (переживёт рестарт, уйдёт в tokens.csv)
  assert.ok(db.db.prepare("SELECT 1 FROM attribution_tokens WHERE token='dir_newcatalog-2'").get());
  // повторное открытие с другим токеном — не перезаписывает (правило первого касания)
  a.onValidatedOpen({ userId: u, startParam: 'blog_cta', kind: 'web_anon', at: T0 + 1000, platform: 'web' });
  assert.equal(db.user(u).first_touch_token, 'dir_newcatalog-2');
  // событие mini_app_open carries entry_token
  const ev = db.db.prepare("SELECT properties_json FROM events_v2 WHERE event_name='mini_app_open' AND user_id=? AND properties_json LIKE '%dir_newcatalog-2%'").get(u);
  assert.match(ev.properties_json, /"entry_token":"dir_newcatalog-2"/);
});

test('HOM-36: ?ref=<код> привязывает пригласившего; src+ref вместе — utm из src, referrer из ref', () => {
  const db = memDb(); const a = mk(db);
  db.touch('9001', { id: '9001' });
  const code = db.refCode('9001');
  a.onValidatedOpen({ userId: 'web-ref-1', refCode: code, kind: 'web_anon', at: T0, platform: 'web' });
  let row = db.user('web-ref-1');
  assert.equal(row.referrer_id, '9001');
  assert.equal(row.utm_source, 'referral');
  assert.ok(db.db.prepare("SELECT 1 FROM referrals WHERE invitee_user_id='web-ref-1' AND referrer_id='9001'").get());
  // комбинация: источник из src, пригласивший из ref
  a.onValidatedOpen({ userId: 'web-ref-2', startParam: 'blog_cta', refCode: code, kind: 'web_anon', at: T0, platform: 'web' });
  row = db.user('web-ref-2');
  assert.equal(row.first_touch_token, 'blog_cta');
  assert.equal(row.utm_source, 'aura_blog');
  assert.equal(row.referrer_id, '9001');
  // несуществующий ref — не ломает атрибуцию источника
  a.onValidatedOpen({ userId: 'web-ref-3', startParam: 'qr', refCode: 'nope', kind: 'web_anon', at: T0, platform: 'web' });
  row = db.user('web-ref-3');
  assert.equal(row.first_touch_token, 'qr');
  assert.equal(row.referrer_id, null);
  // self-ref — не источник
  a.onValidatedOpen({ userId: '9001', refCode: code, kind: 'web_anon', at: T0, platform: 'web' });
  assert.equal(db.user('9001').referrer_id, null);
});
