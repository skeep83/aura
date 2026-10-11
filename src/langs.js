// Языки общения. Матчим только тех, у кого есть общий язык.
export const LANGS = ['ru', 'en', 'uk', 'kk', 'uz', 'be', 'es', 'de', 'fr', 'it', 'pt', 'tr', 'pl', 'ar', 'hi', 'zh', 'id', 'fa', 'vi'];

export function normalizeLangs(input, fallback = 'ru') {
  const list = (Array.isArray(input) ? input : String(input || '').split(','))
    .map(s => String(s).trim().toLowerCase().slice(0, 2))
    .filter(l => LANGS.includes(l));
  const uniq = [...new Set(list)].slice(0, 5);
  if (uniq.length) return uniq;
  const fb = String(fallback || '').slice(0, 2).toLowerCase();
  return [LANGS.includes(fb) ? fb : 'ru'];
}

export const shareLang = (a, b) => a.some(l => b.includes(l));
