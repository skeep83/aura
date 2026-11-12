// Реестр startapp-токенов Aura (спека aura-analytics-spec §4).
// Непрозрачный ключ в серверном реестре: сервер делает exact lookup и никогда
// не парсит slug как источник. Изменение смысла существующего токена запрещено —
// только добавление новых; реестр versioned здесь и выгружается в tokens.csv.
export const REGISTRY_REVISION = 'v1';
export const CAMPAIGN = 'aura_gtm_2026_11';

const pad = n => String(n).padStart(2, '0');

// Ключи месяца из спеки. utm_content = placement_id (идентификатор публикации).
const STATIC_TOKENS = [];
for (let i = 1; i <= 12; i++) {
  STATIC_TOKENS.push({ token: `a1_tt_v${pad(i)}`, utm_source: 'tiktok', utm_medium: 'organic_video', placement_id: `tt_v${pad(i)}`, creative_id: `video_${pad(i)}` });
  STATIC_TOKENS.push({ token: `a1_yt_v${pad(i)}`, utm_source: 'youtube_shorts', utm_medium: 'organic_video', placement_id: `yt_v${pad(i)}`, creative_id: `video_${pad(i)}` });
}
const DIRS = [
  ['botsarchive', 'botsarchive'], ['toptelegrambots', 'toptelegrambots'], ['awesome_telegram', 'awesome_telegram'],
  ['miniappsme', 'miniapps_me'], ['tgdrio', 'tgdr_io'], ['telegramstore', 'telegram_store'],
  ['tlgbotru', 'tlgbot_ru'], ['telegrambotlist', 'telegrambotlist_com'], ['telegrambotlistcom', 'telegrambotlist_com'],
  ['tglist', 'tglist_info'], ['botspulse', 'botspulse'], ['besttelegram', 'besttelegram'],
  ['besttelegrambot', 'besttelegrambot'], ['findmini', 'findmini'], ['tgmini', 'tgmini'], ['launchingnext', 'launchingnext'],
];
for (const [slug, source] of DIRS) {
  STATIC_TOKENS.push({ token: `a1_dir_${slug}`, utm_source: source, utm_medium: 'directory', placement_id: `dir_${slug}`, creative_id: 'listing_main' });
}
// Кросс-промо: до публикации Hermes меняет ЗНАЧЕНИЯ partner_XX в реестре на реальные имена, токены не меняет.
STATIC_TOKENS.push({ token: 'a1_cross_p01_c01', utm_source: 'partner_01', utm_medium: 'cross_promo', placement_id: 'cross_p01', creative_id: 'cross_card_01' });
STATIC_TOKENS.push({ token: 'a1_cross_p02_c01', utm_source: 'partner_02', utm_medium: 'cross_promo', placement_id: 'cross_p02', creative_id: 'cross_card_01' });
STATIC_TOKENS.push({ token: 'a1_rd_p01', utm_source: 'reddit', utm_medium: 'community', placement_id: 'reddit_p01', creative_id: 'post_01' });
STATIC_TOKENS.push({ token: 'a1_rd_p02', utm_source: 'reddit', utm_medium: 'community', placement_id: 'reddit_p02', creative_id: 'post_02' });
STATIC_TOKENS.push({ token: 'a1_hn_p01', utm_source: 'hacker_news', utm_medium: 'community', placement_id: 'hn_p01', creative_id: 'post_01' });
STATIC_TOKENS.push({ token: 'a1_hn_p02', utm_source: 'hacker_news', utm_medium: 'community', placement_id: 'hn_p02', creative_id: 'post_02' });

// Старые src_* остаются alias (первое внедрение 22.10). src_direct — не канал: в отчёте unknown.
const LEGACY_ALIASES = [
  ['src_seo', 'seo', 'organic'], ['src_tg', 'telegram_content', 'organic'], ['src_tgchat', 'telegram_chats', 'community'],
  ['src_github', 'github', 'directory'], ['src_catalog', 'directories', 'directory'], ['src_vc', 'vc_ru', 'organic'],
  ['src_video', 'short_video', 'organic_video'], ['src_cross', 'cross_promo_legacy', 'cross_promo'],
];

// Полный статический реестр: токен → атрибуция. referrer_id у статических токенов всегда NULL.
export function staticRegistry() {
  const rows = STATIC_TOKENS.map(t => ({ ...t, utm_campaign: CAMPAIGN, utm_content: t.placement_id, referrer_id: null, legacy: 0 }));
  for (const [token, source, medium] of LEGACY_ALIASES) {
    rows.push({ token, utm_source: source, utm_medium: medium, utm_campaign: CAMPAIGN, utm_content: token, placement_id: token, creative_id: null, referrer_id: null, legacy: 1 });
  }
  return rows;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Разбор start_param по серверному реестру.
// Возвращает null (не наш токен — счётчик invalid_start_token) или
// { token, utm..., referrerId (внутренний id пригласившего), kind: 'registry'|'referral'|'legacy' }.
// referralResolver(base) → внутренний id пользователя или null (r1_<base36>, legacy ref_/inv_).
export function resolveStartParam(sp, registryRows, referralResolver) {
  if (!sp || !TOKEN_RE.test(sp)) return null;
  const row = registryRows.get(sp);
  if (row) return { token: sp, kind: row.legacy ? 'legacy' : 'registry', referrerId: null, utm: row };
  const m = /^r1_([a-z0-9]{1,13})$/.exec(sp);
  if (m) {
    const n = Number.parseInt(m[1], 36);
    const referrerId = Number.isInteger(n) && n > 0 ? referralResolver(n) : null;
    if (referrerId === null) return null;
    return { token: sp, kind: 'referral', referrerId, utm: referralAttribution(referrerId) };
  }
  // legacy ref_<ref_code|tg id> / inv_<...>: тот же смысл рефералки, id проверяется серверным mapping
  const legacy = /^ref_(.+)$/.exec(sp);
  if (legacy) {
    const referrerId = referralResolver(legacy[1]);
    if (referrerId === null) return null;
    return { token: sp, kind: 'referral', referrerId, utm: referralAttribution(referrerId) };
  }
  return null;
}

export function referralAttribution(referrerId) {
  return {
    utm_source: 'referral', utm_medium: 'referral', utm_campaign: CAMPAIGN,
    utm_content: 'invite_link', placement_id: `ref_${referrerId}`, creative_id: 'invite_default',
  };
}
