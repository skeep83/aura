// ИИ-провайдер: настраивается в админ-панели и хранится в таблице settings (ключ в браузер не уходит).
// Поддержка: любой OpenAI-совместимый API (OpenAI, OpenRouter, Groq, DeepSeek, Gemini, свой vLLM) и Anthropic.
// Функции включаются по отдельности; при выключенном ИИ или ошибке всё работает как раньше (тихо, без ИИ).

export const PRESETS = {
  openai: { label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { label: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-5-5' },
  openrouter: { label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-haiku-5-5' },
  gemini: { label: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  groq: { label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  deepseek: { label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  custom: { label: 'Свой сервер (OpenAI-совместимый, vLLM/Ollama)', kind: 'openai', baseUrl: '', model: '' },
};

export const FEATURES = {
  chatModeration: 'Модерация чата: второй слой после правил (угрозы, сексуализация детей, вымогательство, мошенничество)',
  icebreakers: 'Темы для разговора: свежий вопрос под языки и страны собеседников',
  translate: 'Перевод сообщений в чате по нажатию',
  wrapped: 'Личный текст в недельных итогах Aura Wrapped',
  adminAnalyst: 'ИИ-аналитик и разбор пользователей в админ-панели',
};

const DEFAULTS = { enabled: false, preset: 'openai', kind: 'openai', baseUrl: PRESETS.openai.baseUrl, model: PRESETS.openai.model, apiKey: '',
  features: { chatModeration: true, icebreakers: true, translate: true, wrapped: true, adminAnalyst: true }, dailyLimit: 5000 };

const LANG_NAMES = { ru: 'Russian', en: 'English', uk: 'Ukrainian', es: 'Spanish', pt: 'Portuguese', de: 'German', fr: 'French', it: 'Italian', tr: 'Turkish',
  pl: 'Polish', ar: 'Arabic', hi: 'Hindi', id: 'Indonesian', fa: 'Persian', vi: 'Vietnamese', uz: 'Uzbek', kk: 'Kazakh', be: 'Belarusian', zh: 'Chinese' };
const langName = l => LANG_NAMES[l] || 'English';

export function createAI({ db }) {
  db.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const load = () => {
    try { return { ...DEFAULTS, ...JSON.parse(db.db.prepare("SELECT value FROM settings WHERE key = 'ai'").get()?.value || '{}') }; }
    catch { return { ...DEFAULTS }; }
  };
  let cfg = load();
  cfg.features = { ...DEFAULTS.features, ...cfg.features };
  const usage = { day: '', requests: 0, errors: 0, tokensIn: 0, tokensOut: 0, lastError: '', byFeature: {} };
  const cache = new Map(); // короткий кэш одинаковых запросов (модерация одинаковых фраз, переводы)

  function save(next) {
    cfg = { ...cfg, ...next, features: { ...cfg.features, ...(next.features || {}) } };
    db.db.prepare("INSERT INTO settings (key, value) VALUES ('ai', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(cfg));
    cache.clear();
  }

  // Настройки для панели: ключ не возвращаем, только признак и последние 4 символа
  function publicConfig() {
    const { apiKey, ...rest } = cfg;
    return { ...rest, keySet: Boolean(apiKey), keyHint: apiKey ? '…' + apiKey.slice(-4) : '', presets: PRESETS, featureNames: FEATURES, usage: { ...usage } };
  }

  const on = feature => cfg.enabled && Boolean(cfg.apiKey || cfg.preset === 'custom') && cfg.baseUrl && cfg.model && cfg.features[feature] !== false;

  function count(feature, inTok = 0, outTok = 0) {
    const day = new Date().toISOString().slice(0, 10);
    if (usage.day !== day) Object.assign(usage, { day, requests: 0, errors: 0, tokensIn: 0, tokensOut: 0, byFeature: {} });
    usage.requests++;
    usage.tokensIn += inTok; usage.tokensOut += outTok;
    usage.byFeature[feature] = (usage.byFeature[feature] || 0) + 1;
  }

  // Один запрос к модели. messages: [{ role: 'user'|'assistant', content }]
  async function complete({ system, messages, maxTokens = 300, temperature = 0.4, feature = 'other', timeoutMs = 15_000, json = false }) {
    if (usage.day === new Date().toISOString().slice(0, 10) && usage.requests >= cfg.dailyLimit) throw new Error('daily_limit');
    const base = cfg.baseUrl.replace(/\/$/, '');
    let res, data, text, inTok = 0, outTok = 0;
    try {
      if (cfg.kind === 'anthropic') {
        res = await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: cfg.model, system, messages, max_tokens: maxTokens, temperature }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
        text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
        inTok = data.usage?.input_tokens || 0; outTok = data.usage?.output_tokens || 0;
      } else {
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
            'http-referer': 'https://aura-life.online', 'x-title': 'Aura' },
          body: JSON.stringify({
            model: cfg.model, max_tokens: maxTokens, temperature,
            messages: [{ role: 'system', content: system }, ...messages],
            ...(json ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
        text = data.choices?.[0]?.message?.content || '';
        inTok = data.usage?.prompt_tokens || 0; outTok = data.usage?.completion_tokens || 0;
      }
      count(feature, inTok, outTok);
      return text.trim();
    } catch (e) {
      usage.errors++;
      usage.lastError = `${new Date().toISOString().slice(11, 19)} ${feature}: ${e.message}`.slice(0, 200);
      throw e;
    }
  }

  const parseJson = s => { try { return JSON.parse(s.replace(/^```(?:json)?|```$/g, '').trim()); } catch { const m = /\{[\s\S]*\}/.exec(s); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } } };
  const cached = async (key, fn, ttl = 60 * 60 * 1000) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await fn();
    cache.set(key, { value, at: Date.now() });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return value;
  };

  // ---------- Модерация чата: возвращает категорию тяжёлого нарушения или null ----------
  const SEVERE = ['minor_sexual', 'threat', 'sextortion', 'scam', 'hate'];
  async function moderateChat(text) {
    if (!on('chatModeration') || text.length < 6) return null;
    const verdict = await cached('mod:' + text.toLowerCase(), async () => {
      const out = await complete({
        feature: 'chatModeration', maxTokens: 40, temperature: 0, json: true, timeoutMs: 8000,
        system: 'You are a strict but fair content moderator for an 18+ random video chat. Classify ONE chat message. ' +
          'Categories: ok (normal talk, flirting between adults, jokes, mild swearing), minor_sexual (sexualizes children or asks age-play/minors), ' +
          'threat (real threat of violence), sextortion (demands nudes, blackmail with images), scam (money requests, crypto/investment schemes, phishing, selling services), ' +
          'hate (slurs targeting ethnicity/religion/orientation). When in doubt choose ok. Reply only JSON: {"c":"<category>"}',
        messages: [{ role: 'user', content: text.slice(0, 400) }],
      });
      return parseJson(out)?.c || 'ok';
    }, 24 * 60 * 60 * 1000);
    return SEVERE.includes(verdict) ? verdict : null;
  }

  // ---------- Тема для разговора под пару ----------
  async function icebreaker({ lang = 'en', countries = [], recent = [] }) {
    if (!on('icebreakers')) return null;
    const where = countries.filter(Boolean).join(' and ');
    const out = await complete({
      feature: 'icebreakers', maxTokens: 80, temperature: 1,
      system: `You write ONE short, fun, open-ended icebreaker question for two strangers in a video chat${where ? ` (people from ${where})` : ''}. ` +
        `Write in ${langName(lang)}. Light, curious, never about sex, politics or religion, no personal data requests. Max 18 words. Output only the question.`,
      messages: [{ role: 'user', content: recent.length ? `Avoid repeating these: ${recent.slice(-5).join(' | ')}` : 'Give a question.' }],
    });
    return out.replace(/^["«]|["»]$/g, '').slice(0, 200) || null;
  }

  // ---------- Перевод сообщения ----------
  async function translate(text, lang) {
    if (!on('translate')) return null;
    return cached(`tr:${lang}:${text}`, () => complete({
      feature: 'translate', maxTokens: 200, temperature: 0,
      system: `Translate the user's chat message into ${langName(lang)}. Keep tone, slang and emoji. If it is already in ${langName(lang)}, return it unchanged. Output only the translation.`,
      messages: [{ role: 'user', content: text.slice(0, 300) }],
    }));
  }

  // ---------- Личный текст в итогах недели ----------
  async function wrappedLine(w, lang) {
    if (!on('wrapped') || !w.chats) return null;
    return cached(`wr:${lang}:${JSON.stringify(w)}`, () => complete({
      feature: 'wrapped', maxTokens: 90, temperature: 0.9,
      system: `Write ONE warm, playful sentence (max 22 words) in ${langName(lang)} summarizing a user's week in a global video-chat app, based on their stats. ` +
        'Address them as "you". No hashtags, no quotes.',
      messages: [{ role: 'user', content: JSON.stringify({ chats: w.chats, minutes: w.minutes, newCountries: w.countries, vibes: w.vibes, compliments: w.compliments, archetype: w.archetype }) }],
    }), 6 * 60 * 60 * 1000);
  }

  // ---------- Админ: аналитик и разбор пользователя ----------
  async function analyst(question, context) {
    if (!on('adminAnalyst')) throw new Error('ai_off');
    return complete({
      feature: 'adminAnalyst', maxTokens: 900, temperature: 0.3, timeoutMs: 60_000,
      system: 'Ты — продуктовый аналитик сервиса Aura (видеорулетка в Telegram Mini App). Отвечай по-русски, коротко и по делу, с цифрами из данных. ' +
        'Если данных мало — так и скажи. В конце — 1–3 конкретных действия. Данные (JSON): метрики за сутки, ряды по дням, аудитория, вирусные фичи.\n' + JSON.stringify(context),
      messages: [{ role: 'user', content: question.slice(0, 2000) }],
    });
  }

  async function reviewUser(detail) {
    if (!on('adminAnalyst')) throw new Error('ai_off');
    return complete({
      feature: 'adminAnalyst', maxTokens: 500, temperature: 0.2, timeoutMs: 45_000,
      system: 'Ты помогаешь модератору видеорулетки 18+. По данным пользователя (жалобы, баны, события, оценки, платежи) оцени риск: низкий/средний/высокий, ' +
        'объясни в 2–4 пунктах и предложи действие (ничего, предупредить, бан 24 ч, бан 7 дн, навсегда). Не выдумывай фактов. Отвечай по-русски.',
      messages: [{ role: 'user', content: JSON.stringify(detail).slice(0, 12_000) }],
    });
  }

  async function test() {
    const t0 = Date.now();
    const out = await complete({ feature: 'test', maxTokens: 20, temperature: 0, system: 'Reply with the single word: pong', messages: [{ role: 'user', content: 'ping' }] });
    return { ok: true, reply: out.slice(0, 50), ms: Date.now() - t0, model: cfg.model };
  }

  return {
    get config() { return cfg; }, publicConfig, save, on, complete, test,
    moderateChat, icebreaker, translate, wrappedLine, analyst, reviewUser,
    clientFeatures: () => ({ icebreakers: on('icebreakers'), translate: on('translate') }),
  };
}
