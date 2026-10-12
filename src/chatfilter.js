// Модерация текстового чата. Быстрые правила на сервере (без задержки), ИИ — вторым слоем (src/ai.js).
//   block — не доставлять (тяжёлое: сексуализация детей, угрозы, вымогательство), нарушителю страйк чата
//   mask  — доставить, скрыв ссылки, контакты и мат (обменяться контактами можно через «Вайб»)
//   spam  — одинаковое сообщение со ссылкой/контактом разным людям

// Две нормализации: латиница → похожая кириллица («xуй», «п0рно») и цифры/символы → латиница («p0rn», «s3x»)
const TO_CYR = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', b: 'в', h: 'н', '0': 'о', '3': 'з', '@': 'а', '6': 'б' };
const TO_LAT = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };
const squash = s => s.toLowerCase().replace(/ё/g, 'е').replace(/[\s.\-_*~|/\\,+'"`]+/g, '');
const normCyr = s => squash(s).replace(/[a-z0-9@]/g, ch => TO_CYR[ch] || ch);
const normLat = s => squash(s).replace(/[0-9@$!]/g, ch => TO_LAT[ch] || ch);

// Границы слова для кириллицы (\b в JS работает только с латиницей)
const W = '(?<![а-яёa-z])';
const R = (src, flags = 'iu') => new RegExp(src, flags);
// Корни мата: маскируем, но не блокируем
const PROFANITY = [
  R('х[уy][йеёяию]'), R('пизд'), R(W + 'еб[ауоие]'), R('ёб'), R(W + 'бля'), R('муд[аои]к'), R('пид[оа]р'), R('залуп'), R('шлюх'),
  R(W + 'хер'), R(W + 'сук[аи]' + '(?![а-яё])'), R('\\b(fuck|shit|bitch|cunt|whore|slut|fag)'), R('\\bdick\\b'),
];
// Тяжёлое: не доставляем. Проверяется по обеим нормализациям
const SEVERE = [
  /(детск|малолет|школьниц|несовершеннолет|child|kid|teen|minor|loli)\S{0,12}(порн|porn|секс|sex|nud|голы|интим)/,
  /(порн|porn|секс|sex|nud|голы|интим)\S{0,12}(детск|малолет|школьниц|несовершеннолет|child|kid|loli)/,
  /(убью|зарежу|застрелю|изнасил|killyou|rapeyou)/,
  /(скинь|пришли|отправь|sendme)\S{0,10}(нюдс|nudes|голые|интимн)/,
  /(разошлю(всем|твои)|покажувсем|сольювсеть|blackmail|sextort)/,
];
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(?:com|ru|net|org|io|me|app|xyz|top|site|online|store|shop|link|click|info|biz|cc|su|ua|kz|by|tk|gg|ly|to|tv|pro|club|vip|win|bet|casino)\b\S*|\bt\.me\/\S+/gi;
const HANDLE_RE = /(^|[^\w])@[a-z0-9_]{4,32}\b/gi;
const PHONE_RE = /(?:\+?\d[\s\-()]?){9,14}\d/g;
const CONTACT_WORDS = /(telegram|телеграм|телега|tg|инст|insta|instagram|whatsapp|ватсап|вацап|viber|вайбер|snapchat|снап|onlyfans|онлифанс|discord|дискорд)\s*[:\-]?\s*[a-z0-9_.]{3,}/gi;

export class ChatFilter {
  constructor({ strikesToBan = 3 } = {}) {
    this.strikesToBan = strikesToBan;
    this.recent = new Map(); // senderId -> [{ norm, to, at }] — для поиска рассылки
  }

  check(text, { from, to, now = Date.now() } = {}) {
    const norm = normCyr(text), lat = normLat(text);
    for (const re of SEVERE) if (re.test(norm) || re.test(lat)) return { action: 'block', reason: 'severe', text: '' };

    let out = text;
    let masked = false;
    const hide = (re, repl) => { out = out.replace(re, (...m) => { masked = true; return typeof repl === 'function' ? repl(...m) : repl; }); };
    hide(URL_RE, '🔗•••');
    hide(CONTACT_WORDS, m => m.split(/[\s:\-]/)[0] + ' •••');
    hide(HANDLE_RE, (m, pre) => `${pre}@•••`);
    hide(PHONE_RE, '📞•••');
    const contact = masked;
    for (const re of PROFANITY) {
      const g = new RegExp(re.source + '[а-яёa-z]*', 'giu');
      out = out.replace(g, w => { masked = true; return w[0] + '*'.repeat(Math.max(2, w.length - 1)); });
    }

    // Рассылка: одно и то же сообщение с контактом/ссылкой трём разным людям за 10 минут
    if (contact && from) {
      const list = (this.recent.get(from) || []).filter(r => now - r.at < 10 * 60 * 1000);
      list.push({ norm, to, at: now });
      this.recent.set(from, list.slice(-30));
      const same = new Set(list.filter(r => r.norm === norm).map(r => r.to));
      if (same.size >= 3) return { action: 'block', reason: 'spam', text: '' };
    }
    return masked ? { action: 'mask', reason: contact ? 'contact' : 'profanity', text: out } : { action: 'ok', text };
  }

  // Периодическая чистка истории рассылок
  sweep(now = Date.now()) {
    for (const [k, list] of this.recent) {
      const fresh = list.filter(r => now - r.at < 10 * 60 * 1000);
      if (fresh.length) this.recent.set(k, fresh); else this.recent.delete(k);
    }
  }
}
