// Языки общения. Матчим только тех, у кого есть общий язык.
export const LANGS = ['ru', 'en', 'uk', 'kk', 'uz', 'be', 'es', 'de', 'fr', 'it', 'pt', 'tr', 'pl', 'ar', 'hi', 'zh', 'id', 'fa', 'vi'];

// Основной язык страны (ISO 3166-1 alpha-2 → код из LANGS): новичку без поддерживаемого языка устройства
// язык общения берём по стране, а не «русский по умолчанию» — иначе каталонец в Испании говорил бы только с русскоязычными
export const COUNTRY_LANG = {
  RU: 'ru', BY: 'be', KZ: 'kk', UZ: 'uz', UA: 'uk', MD: 'ru', KG: 'ru', TJ: 'ru', AM: 'ru', AZ: 'ru', GE: 'ru',
  US: 'en', GB: 'en', CA: 'en', AU: 'en', NZ: 'en', IE: 'en', ZA: 'en', NG: 'en', KE: 'en', GH: 'en', PH: 'en', SG: 'en', PK: 'en', BD: 'en', LK: 'en', MY: 'en',
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es', VE: 'es', EC: 'es', GT: 'es', CU: 'es', BO: 'es', DO: 'es', HN: 'es', PY: 'es', SV: 'es', NI: 'es', CR: 'es', PA: 'es', UY: 'es', PR: 'es',
  BR: 'pt', PT: 'pt', AO: 'pt', MZ: 'pt',
  DE: 'de', AT: 'de', CH: 'de', LI: 'de',
  FR: 'fr', BE: 'fr', LU: 'fr', MC: 'fr', SN: 'fr', CI: 'fr', CM: 'fr', MG: 'fr', HT: 'fr',
  IT: 'it', SM: 'it', TR: 'tr', CY: 'tr', PL: 'pl',
  SA: 'ar', AE: 'ar', EG: 'ar', IQ: 'ar', MA: 'ar', DZ: 'ar', TN: 'ar', JO: 'ar', LB: 'ar', SY: 'ar', YE: 'ar', OM: 'ar', KW: 'ar', QA: 'ar', BH: 'ar', LY: 'ar', SD: 'ar', PS: 'ar',
  IN: 'hi', NP: 'hi', CN: 'zh', TW: 'zh', HK: 'zh', MO: 'zh', ID: 'id', IR: 'fa', AF: 'fa', VN: 'vi',
};
export const countryLang = c => COUNTRY_LANG[String(c || '').toUpperCase()] || '';

// fallback — код или список кандидатов (язык устройства, язык страны, …): берётся первый поддерживаемый, иначе английский
export function normalizeLangs(input, fallback = 'en') {
  const list = (Array.isArray(input) ? input : String(input || '').split(','))
    .map(s => String(s).trim().toLowerCase().slice(0, 2))
    .filter(l => LANGS.includes(l));
  const uniq = [...new Set(list)].slice(0, 5);
  if (uniq.length) return uniq;
  const fb = (Array.isArray(fallback) ? fallback : [fallback]).map(f => String(f || '').slice(0, 2).toLowerCase()).find(f => LANGS.includes(f));
  return [fb || 'en'];
}

export const shareLang = (a, b) => a.some(l => b.includes(l));
