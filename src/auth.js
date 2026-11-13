import crypto from 'node:crypto';

const MAX_AGE_SEC = 24 * 60 * 60;

// Проверка подписи Telegram WebApp initData:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function validateInitData(initData, botToken, now = Date.now()) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (expected.length !== hash.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > MAX_AGE_SEC) return null;

  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { return null; }
  if (!user?.id) return null;
  return {
    id: String(user.id),
    lang: user.language_code || 'ru',
    username: user.username || '',
    name: [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 64),
    allowsPm: Boolean(user.allows_write_to_pm),
    isPremium: Boolean(user.is_premium),
    // Параметр запуска (?startapp=…) подписан вместе с initData — подделать нельзя
    startParam: params.get('start_param') || '',
  };
}

// Проверка подписи Telegram Login Widget (вход на сайте, не в Mini App):
// https://core.telegram.org/widgets/login#checking-authorization
// Отличие от initData: секрет — SHA-256 от токена бота, а не HMAC по 'WebAppData'.
export function validateLoginWidget(fields, botToken, now = Date.now()) {
  if (!fields || !botToken) return null;
  const params = fields instanceof URLSearchParams ? new URLSearchParams(fields) : new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v ?? '')]));
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secret = crypto.createHash('sha256').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > MAX_AGE_SEC) return null;
  const id = String(params.get('id') || '');
  if (!/^\d{1,20}$/.test(id)) return null;
  return {
    id,
    username: params.get('username') || '',
    name: [params.get('first_name'), params.get('last_name')].filter(Boolean).join(' ').slice(0, 64),
    avatar: params.get('photo_url') || '',
  };
}

// Временные учётки для coturn (static-auth-secret / TURN REST API)
export function turnCredentials(userId, secret, ttlSec = 6 * 60 * 60) {
  const username = `${Math.floor(Date.now() / 1000) + ttlSec}:${userId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}
