#!/usr/bin/env node
// Ежедневная выгрузка метрик Aura (спека aura-analytics-spec §5).
//   node scripts/export-analytics.mjs [--date YYYY-MM-DD] [--out DIR]
// По умолчанию выгружает вчерашние UTC-сутки. Архив: aura_analytics_<date>_v1.zip
// (несжатые CSV — формат zip обязателен манифесту; если zip недоступен, кладём .tar.gz и пишем об этом в манифест).
// Считаем из consistent snapshot: sqlite3 .backup во временный файл, затем read transaction.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../src/db.js';
import { createAnalytics } from '../src/analytics.js';

const DAY = 24 * 60 * 60 * 1000;
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const date = arg('--date', new Date(Date.now() - DAY).toISOString().slice(0, 10));
const outDir = arg('--out', path.join(DATA_DIR, 'exports'));
const from = `${date}T00:00:00.000Z`;
const dayStart = Date.parse(`${date}T00:00:00Z`), dayEnd = dayStart + DAY;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-export-'));
const snap = path.join(tmp, 'snapshot.db');
// Снапшот: VACUUM INTO через node:sqlite (read-only) — консистентный снимок с учётом WAL.
// sqlite3 CLI на хосте/в контейнере нет; копирование файла потеряло бы незакоммиченный WAL.
try {
  const src = new DatabaseSync(path.join(DATA_DIR, 'roulette.db'), { readOnly: true });
  src.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  src.close();
} catch { fs.copyFileSync(path.join(DATA_DIR, 'roulette.db'), snap); }
const db = new Db(snap);
const analytics = createAnalytics({ db, env: { APP_VERSION: process.env.APP_VERSION || 'export' } });
const d = db.db;

const csvEscape = v => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
};
// Строка CSV: принимает и массив значений, и объект (тогда берёт поля по заголовку).
const csv = (header, rows) => [header.join(','), ...rows.map(r => (Array.isArray(r) ? r : header.map(h => r[h])).map(csvEscape).join(','))].join('\n') + '\n';
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const CRC_TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const codeVersion = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.join(process.cwd()) }).toString().trim(); } catch { return process.env.APP_VERSION || 'unknown'; } })();

// users.csv
const users = d.prepare('SELECT * FROM users').all().map(u => ({
  user_id: u.id, created_at_utc: new Date(u.created_at).toISOString(),
  first_validated_at_utc: u.first_validated_at ? new Date(u.first_validated_at).toISOString() : null,
  first_activation_at_utc: u.first_activation_at ? new Date(u.first_activation_at).toISOString() : null,
  first_touch_confirmed_at_utc: u.first_touch_confirmed_at ? new Date(u.first_touch_confirmed_at).toISOString() : null,
  first_touch_token: u.first_touch_token, utm_source: u.utm_source || 'unknown', utm_medium: u.utm_medium, utm_campaign: u.utm_campaign,
  utm_content: u.utm_content, placement_id: u.placement_id, creative_id: u.creative_id, referrer_id: u.referrer_id,
  legacy_source_raw: u.source, onboarding_completed_at_utc: u.onboarding_completed_at ? new Date(u.onboarding_completed_at).toISOString() : null,
  is_test: u.is_test || 0,
}));

// events.csv (все события v1 за сутки D; поздние исправления приходят в архив своей даты)
const ev2cols = ['event_id', 'event_name', 'occurred_at_utc', 'ingested_at_utc', 'user_id', 'session_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'placement_id', 'creative_id', 'referrer_id', 'app_version', 'platform', 'event_schema_version', 'is_test', 'call_id', 'duration_ms', 'threshold_at_utc', 'payment_id', 'snapshot_minute_utc', 'searching_users', 'properties_json'];
const events = d.prepare('SELECT * FROM events_v2 WHERE occurred_at_utc >= ? AND occurred_at_utc < ? ORDER BY occurred_at_utc').all(from, new Date(dayEnd).toISOString())
  .map(e => Object.fromEntries(ev2cols.map(c => [c, e[c] ?? ''])));

// legacy_events.csv — старые события (schema v0), чтобы OpenAI не смешивал методики
const legacy = d.prepare('SELECT * FROM events WHERE at >= ? AND at < ? ORDER BY at').all(dayStart, dayEnd)
  .map(e => ({ event_id: `legacy:${e.at}:${e.type}:${e.user_id}`, event_name: e.type, occurred_at_utc: new Date(e.at).toISOString(), user_id: e.user_id, value: e.value, tag: e.tag, event_schema_version: 0 }));

// calls.csv
const calls = d.prepare('SELECT * FROM calls WHERE ended_at IS NOT NULL AND ended_at >= ? AND ended_at < ?').all(dayStart, dayEnd).map(c => {
  const iso = ms => ms == null ? '' : new Date(ms).toISOString();
  return {
    call_id: c.call_id, user_id: c.user_a, partner_user_id: c.user_b, session_id: c.session_a,
    conn_ok_at_utc: iso(c.conn_ok_at), talk_started_at_utc: iso(c.talk_started_at), call_ended_at_utc: iso(c.ended_at),
    duration_ms: c.duration_ms ?? '', end_reason: c.end_reason || '', clock_fallback: c.clock_fallback,
    verification_status: c.verified ? 'verified' : 'duration_unknown',
    is_test: (String(c.user_a).startsWith('dev-') ? 1 : 0),
  };
});

// payments.csv
const payments = d.prepare('SELECT * FROM payments WHERE at >= ? AND at < ?').all(dayStart, dayEnd).map(p => ({
  payment_id: p.charge_id, user_id: p.user_id, occurred_at_utc: new Date(p.at).toISOString(),
  status: p.refunded ? 'refunded' : 'success', amount_minor: p.stars, currency: 'XTR', provider: 'telegram_stars',
  is_test: (db.user(p.user_id).is_test || 0),
}));

// tokens.csv
const tokens = d.prepare('SELECT * FROM attribution_tokens ORDER BY token').all().map(t => ({
  token: t.token, canonical_token: t.token, utm_source: t.utm_source, utm_medium: t.utm_medium, utm_campaign: t.utm_campaign,
  utm_content: t.utm_content || '', placement_id: t.placement_id || '', creative_id: t.creative_id || '',
  referrer_id: t.referrer_id || '', active: 1, created_at_utc: t.created_at_utc, registry_revision: 'v1',
}));

// daily_totals.csv / daily_sources.csv — контрольный серверный SQL
const q = (sql, ...a) => d.prepare(sql).get(...a);
const notTest = "user_id NOT LIKE 'dev-%' AND is_test = 0";
const dau = q(`SELECT COUNT(DISTINCT user_id) n FROM events_v2 WHERE event_name='mini_app_open' AND occurred_at_utc>=? AND occurred_at_utc<? AND ${notTest}`, from, new Date(dayEnd).toISOString()).n;
const wau = q(`SELECT COUNT(DISTINCT user_id) n FROM events_v2 WHERE event_name='mini_app_open' AND occurred_at_utc>=? AND occurred_at_utc<? AND ${notTest}`, new Date(dayStart - 6 * DAY).toISOString(), new Date(dayEnd).toISOString()).n;
const fua = q(`SELECT COUNT(DISTINCT user_id) n FROM events_v2 WHERE event_name='first_useful_action' AND occurred_at_utc>=? AND occurred_at_utc<? AND ${notTest}`, from, new Date(dayEnd).toISOString()).n;
const good = q(`SELECT COUNT(*) n FROM events_v2 WHERE event_name='good_conversation' AND occurred_at_utc>=? AND occurred_at_utc<? AND ${notTest}`, from, new Date(dayEnd).toISOString()).n;
const refFua = q(`SELECT COUNT(*) n FROM events_v2 WHERE event_name='referred_first_useful_action' AND occurred_at_utc>=? AND occurred_at_utc<? AND ${notTest}`, from, new Date(dayEnd).toISOString()).n;
const invites = q(`SELECT COUNT(*) n FROM events_v2 WHERE event_name='invite_open' AND occurred_at_utc>=? AND occurred_at_utc<? AND ${notTest}`, from, new Date(dayEnd).toISOString()).n;
const payN = q(`SELECT COUNT(DISTINCT charge_id) n FROM payments p WHERE at>=? AND at<? AND refunded=0 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=p.user_id AND u.is_test=1)`, dayStart, dayEnd).n;
// D1/D7 когорты: n/N по созревшим данным (числитель — авторизованные mini_app_open ровно на D0+1/D0+7)
function cohort(n) {
  const den = q(`SELECT COUNT(*) n FROM users WHERE first_activation_at>=? AND first_activation_at<? AND is_test=0`, dayStart - n * DAY, dayEnd - n * DAY).n;
  const winStart = new Date(dayStart - n * DAY).toISOString(), winEnd = new Date(dayEnd - n * DAY).toISOString();
  const num = q(`SELECT COUNT(DISTINCT e.user_id) n FROM events_v2 e JOIN users u ON u.id=e.user_id
    WHERE e.event_name='mini_app_open' AND e.occurred_at_utc>=? AND e.occurred_at_utc<? AND u.is_test=0
      AND u.first_activation_at>=? AND u.first_activation_at<?`, winStart, winEnd, dayStart - n * DAY, dayEnd - n * DAY).n;
  return { n: num, den };
}
const d1 = cohort(1), d7 = cohort(7);
const snapsExpected = 46;
const snapsPresent = q(`SELECT COUNT(DISTINCT snapshot_minute_utc) n FROM events_v2 WHERE event_name='searching_concurrency' AND snapshot_minute_utc>=? AND snapshot_minute_utc<?`, `${date}T20:45:00.000Z`, new Date(Date.parse(`${date}T21:30:00Z`) + 60000).toISOString()).n;
const totals = [{
  date_utc: date, dau, wau_7d: wau, first_useful_actions: fua, good_conversations: good,
  referred_first_useful_actions: refFua, invite_opens: invites,
  return_d1_n: d1.n, return_d1_den: d1.den, return_d7_n: d7.n, return_d7_den: d7.den,
  payment_success_count: payN, search_snapshots_expected: snapsExpected, search_snapshots_present: snapsPresent,
}];
const sourceCols = ['date_utc', 'utm_source', 'utm_medium', 'utm_campaign', 'placement_id', 'creative_id', 'activated_users'];
const sources = d.prepare(`
  SELECT date(occurred_at_utc) date_utc, COALESCE(NULLIF(utm_source,''),'unknown') utm_source,
    COALESCE(utm_medium,'') utm_medium, COALESCE(utm_campaign,'') utm_campaign,
    COALESCE(placement_id,'') placement_id, COALESCE(creative_id,'') creative_id,
    COUNT(DISTINCT user_id) activated_users
  FROM events_v2 WHERE event_name='first_useful_action' AND occurred_at_utc>=? AND occurred_at_utc<?
    AND user_id NOT LIKE 'dev-%' AND is_test=0
  GROUP BY 1,2,3,4,5,6 ORDER BY activated_users DESC`).all(from, new Date(dayEnd).toISOString())
  .map(s => sourceCols.map(c => s[c] ?? ''));

const files = {
  'users.csv': csv(Object.keys(users[0] || { user_id: '' }), users),
  'events.csv': csv(ev2cols, events),
  'legacy_events.csv': csv(['event_id', 'event_name', 'occurred_at_utc', 'user_id', 'value', 'tag', 'event_schema_version'], legacy),
  'calls.csv': csv(['call_id', 'user_id', 'partner_user_id', 'session_id', 'conn_ok_at_utc', 'talk_started_at_utc', 'call_ended_at_utc', 'duration_ms', 'end_reason', 'clock_fallback', 'verification_status', 'is_test'], calls),
  'payments.csv': csv(['payment_id', 'user_id', 'occurred_at_utc', 'status', 'amount_minor', 'currency', 'provider', 'is_test'], payments),
  'tokens.csv': csv(Object.keys(tokens[0] || {}), tokens),
  'daily_totals.csv': csv(Object.keys(totals[0]), totals),
  'daily_sources.csv': csv(['date_utc', 'utm_source', 'utm_medium', 'utm_campaign', 'placement_id', 'creative_id', 'activated_users'], sources),
};
const manifest = {
  schema_version: 1,
  exported_at_utc: new Date().toISOString(),
  period_start_utc: from, period_end_utc: new Date(dayEnd).toISOString(),
  db_snapshot_at_utc: new Date().toISOString(),
  revision: 1, reason: 'initial', code_version: codeVersion,
  errors: [], missing_minutes: [],
  files: Object.fromEntries(Object.entries(files).map(([n, c]) => [n, { sha256: sha256(Buffer.from(c)), rows: c.split('\n').length - 1 }])),
};
files['manifest.json'] = JSON.stringify(manifest, null, 2);

fs.mkdirSync(outDir, { recursive: true });
const dir = path.join(outDir, `aura_analytics_${date}_v1`);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
// zip без зависимостей: stored (без сжатия) записи — валидный ZIP
try {
  const entries = Object.entries(files);
  const chunks = [], central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const [name, content] of entries) {
    const data = enc.encode(content), nm = enc.encode(name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
    chunks.push(Buffer.from(lh.buffer), Buffer.from(nm), Buffer.from(data));
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
    central.push(Buffer.from(ch.buffer), Buffer.from(nm));
    offset += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), cdSize = cd.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const zipPath = path.join(outDir, `aura_analytics_${date}_v1.zip`);
  fs.writeFileSync(zipPath, Buffer.concat([...chunks, cd, Buffer.from(end.buffer)]));
  fs.rmSync(dir, { recursive: true });
  console.log(zipPath);
} catch (e) {
  console.log(dir + ' (zip не собран: ' + e.message + ')');
}

