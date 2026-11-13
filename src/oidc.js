// Проверка id_token провайдера OIDC по JWKS (HOM-40, план HOM-35 §4.2).
//
// Принципы:
// - без новых зависимостей: подпись RS256 проверяет `crypto` Node 22 (createPublicKey принимает JWK как есть);
// - ключи Google ротируются, поэтому JWKS кэшируется по Cache-Control, а неизвестный kid вызывает
//   не больше одного перечитывания в минуту — иначе чужой мусорный токен станет рычагом на их эндпоинт;
// - проверяем всё, что делает токен доказательством: подпись, iss, aud, срок и nonce нашего запроса.
//   Без nonce id_token, выданный для другого нашего же запроса, годился бы повторно.
import crypto from 'node:crypto';

const FETCH_TIMEOUT_MS = 8000;
const JWKS_TTL_MS = 60 * 60 * 1000;    // час по умолчанию, если провайдер не сказал иначе
const JWKS_MIN_TTL_MS = 5 * 60 * 1000;
const JWKS_REFETCH_MS = 60 * 1000;     // не чаще раза в минуту при неизвестном kid
const SKEW_MS = 2 * 60 * 1000;         // часы клиента и провайдера расходятся — обычный допуск
const MAX_TOKEN_LEN = 8000;

class OidcError extends Error {}
const fail = code => { throw new OidcError(code); };

function ttlFrom(cacheControl) {
  const m = /max-age\s*=\s*(\d+)/i.exec(String(cacheControl || ''));
  if (!m) return JWKS_TTL_MS;
  return Math.max(JWKS_MIN_TTL_MS, Math.min(24 * 60 * 60 * 1000, Number(m[1]) * 1000));
}

// Кэш JWKS одного провайдера. Параллельные колбэки ждут один запрос, а не N.
export function createJwks(url, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  let keys = new Map();
  let expiresAt = 0;
  let fetchedAt = 0;
  let inflight = null;

  function load() {
    if (inflight) return inflight;
    inflight = (async () => {
      const r = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw new OidcError('jwks_' + r.status);
      const body = await r.json();
      const list = Array.isArray(body?.keys) ? body.keys : [];
      const next = new Map();
      for (const k of list) {
        if (!k?.kid || k.kty !== 'RSA') continue;
        if (k.use && k.use !== 'sig') continue;
        if (k.alg && k.alg !== 'RS256') continue;
        next.set(String(k.kid), k);
      }
      if (!next.size) throw new OidcError('jwks_empty');
      keys = next;
      fetchedAt = now();
      expiresAt = fetchedAt + ttlFrom(r.headers.get('cache-control'));
    })().finally(() => { inflight = null; });
    return inflight;
  }

  return {
    async get(kid) {
      if (!kid) return null;
      if (!keys.size || now() >= expiresAt) await load();
      if (!keys.has(kid) && now() - fetchedAt > JWKS_REFETCH_MS) await load();
      return keys.get(kid) || null;
    },
    // для тестов и диагностики
    get size() { return keys.size; },
  };
}

function part(raw, what) {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) fail('jwt_' + what);
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return fail('jwt_' + what); }
}

// Возвращает claims проверенного токена либо бросает OidcError с коротким кодом причины.
export async function verifyIdToken(token, { jwks, audience, issuers, nonce = '', now = Date.now() }) {
  const raw = String(token || '');
  if (!raw || raw.length > MAX_TOKEN_LEN) fail('jwt_size');
  const parts = raw.split('.');
  if (parts.length !== 3) fail('jwt_parts');

  const header = part(parts[0], 'header');
  if (header.alg !== 'RS256') fail('alg');            // Google подписывает только RS256; alg=none и HS* не принимаем
  if (header.typ && header.typ !== 'JWT') fail('typ');
  const jwk = await jwks.get(String(header.kid || ''));
  if (!jwk) fail('kid');

  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    if (key.asymmetricKeyType !== 'rsa') fail('kty');
    ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  } catch (e) {
    if (e instanceof OidcError) throw e;
    fail('signature');
  }
  if (!ok) fail('signature');

  const c = part(parts[1], 'payload');
  const list = Array.isArray(issuers) ? issuers : [issuers];
  if (!list.includes(String(c.iss || ''))) fail('iss');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(audience)) fail('aud');
  // azp появляется, когда токен выписан для другого клиента того же проекта — наш случай это не он
  if (c.azp && c.azp !== audience) fail('azp');
  const sec = v => (Number.isFinite(Number(v)) ? Number(v) * 1000 : NaN);
  if (!(sec(c.exp) > now - SKEW_MS)) fail('expired');
  if (c.iat !== undefined && !(sec(c.iat) < now + SKEW_MS)) fail('iat');
  if (c.nbf !== undefined && !(sec(c.nbf) < now + SKEW_MS)) fail('nbf');
  if (nonce) {
    const got = String(c.nonce || '');
    if (got.length !== nonce.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(nonce))) fail('nonce');
  }
  if (!String(c.sub || '')) fail('sub');
  return c;
}

export { OidcError };
