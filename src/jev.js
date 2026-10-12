// Jev (TypeSafe AI) — модель решений: состояние + типизированные вопросы → ответы с вероятностями.
// POST {baseUrl}/v1/systemone { state, model, questions: { id: { type: noul|choice|score, instructions, criteria } } }
// Ответ: { model, answers: { id: { type, noul | choice+probabilities | score+probabilities } }, usage }
// В Aura Jev — быстрый и дешёвый «судья»: модерация чата, разбор жалоб, оценка риска пользователя.
// Настройки — в таблице settings (ключ 'jev'), ключ API в браузер не отдаётся.

export const JEV_FEATURES = {
  chatModeration: 'Модерация чата: вероятность угроз, сексуализации детей, вымогательства, мошенничества (заменяет ИИ-модерацию — дешевле и быстрее)',
  reportTriage: 'Разбор каждой жалобы: рекомендация «оставить / предупредить / бан 24 ч / бан 7 дн» с уверенностью',
  autoBan: 'Автобан по жалобе, если Jev уверен ≥ 90% и на человека уже есть другие жалобы',
  riskScore: 'Оценка риска пользователя в админке (0–4) с вероятностями',
};

const DEFAULTS = {
  enabled: false, baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', apiKey: '',
  features: { chatModeration: true, reportTriage: true, autoBan: false, riskScore: true },
  chatThreshold: 0.85, dailyLimit: 20000,
};

export function createJev({ db }) {
  db.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const load = () => {
    try { return { ...DEFAULTS, ...JSON.parse(db.db.prepare("SELECT value FROM settings WHERE key = 'jev'").get()?.value || '{}') }; }
    catch { return { ...DEFAULTS }; }
  };
  let cfg = load();
  cfg.features = { ...DEFAULTS.features, ...cfg.features };
  const usage = { day: '', requests: 0, errors: 0, tokensIn: 0, lastError: '', byFeature: {} };
  const cache = new Map();

  function save(next) {
    cfg = { ...cfg, ...next, features: { ...cfg.features, ...(next.features || {}) } };
    db.db.prepare("INSERT INTO settings (key, value) VALUES ('jev', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(cfg));
    cache.clear();
  }
  function publicConfig() {
    const { apiKey, ...rest } = cfg;
    return { ...rest, keySet: Boolean(apiKey), keyHint: apiKey ? '…' + apiKey.slice(-4) : '', featureNames: JEV_FEATURES, usage: { ...usage } };
  }
  const on = f => cfg.enabled && Boolean(cfg.apiKey) && cfg.features[f] !== false;

  async function ask(state, questions, feature = 'other', timeoutMs = 8000) {
    const day = new Date().toISOString().slice(0, 10);
    if (usage.day !== day) Object.assign(usage, { day, requests: 0, errors: 0, tokensIn: 0, byFeature: {} });
    if (usage.requests >= cfg.dailyLimit) throw new Error('daily_limit');
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ state, model: cfg.model, questions }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || data?.detail || `HTTP ${res.status}`);
      usage.requests++;
      usage.tokensIn += data.usage?.input_tokens || 0;
      usage.byFeature[feature] = (usage.byFeature[feature] || 0) + 1;
      return data.answers || {};
    } catch (e) {
      usage.errors++;
      usage.lastError = `${new Date().toISOString().slice(11, 19)} ${feature}: ${e.message}`.slice(0, 200);
      throw e;
    }
  }

  // ---------- Модерация чата: категория тяжёлого нарушения или null ----------
  const CHAT_Q = {
    minor_sexual: 'The message sexualizes children or minors, or asks a minor for sexual content',
    threat: 'The message contains a real threat of violence against the other person',
    sextortion: 'The message demands nude images or blackmails with intimate images',
    scam: 'The message is a scam: asks for money, promotes crypto/investment schemes, phishing or paid services',
    hate: 'The message contains slurs or hate against ethnicity, religion, nationality or sexual orientation',
  };
  async function moderateChat(text) {
    if (!on('chatModeration') || text.length < 6) return null;
    const key = 'chat:' + text.toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit.v;
    const questions = Object.fromEntries(Object.entries(CHAT_Q).map(([id, instructions]) => [id, { type: 'noul', instructions }]));
    const answers = await ask(`Chat message in an 18+ random video chat between two adults: """${text.slice(0, 400)}"""`, questions, 'chatModeration');
    let worst = null, p = 0;
    for (const id of Object.keys(CHAT_Q)) {
      const v = Number(answers[id]?.noul ?? 0);
      if (v > p) { p = v; worst = id; }
    }
    const v = p >= cfg.chatThreshold ? worst : null;
    cache.set(key, { v });
    if (cache.size > 3000) cache.delete(cache.keys().next().value);
    return v;
  }

  // ---------- Разбор жалобы: рекомендация с вероятностями ----------
  async function triageReport(detail) {
    if (!on('reportTriage')) return null;
    const answers = await ask(detail, {
      action: {
        type: 'choice',
        instructions: 'Moderation decision for the REPORTED user of an 18+ random video chat, based only on the facts in the state',
        criteria: {
          ignore: 'Likely a false or retaliatory report, no other signals of bad behavior',
          warn: 'Some signals of bad behavior, but not enough for a ban',
          ban_24h: 'Clear violation: multiple independent reports or moderation strikes',
          ban_7d: 'Repeated serious violations: many reports, NSFW strikes or chat blocks',
        },
      },
    }, 'reportTriage');
    const a = answers.action;
    if (!a?.choice) return null;
    return { action: a.choice, confidence: Number(a.confidence ?? a.probabilities?.[a.choice] ?? 0), probabilities: a.probabilities || {} };
  }

  // ---------- Риск пользователя для админки ----------
  async function riskScore(detail) {
    if (!on('riskScore')) throw new Error('jev_off');
    const answers = await ask(detail, {
      risk: {
        type: 'score',
        instructions: 'How risky is this user for other people in an 18+ random video chat, judging by reports, bans, moderation strikes, ratings and activity',
        criteria: ['No risk: normal user', 'Low risk', 'Medium: some complaints', 'High: repeated complaints or strikes', 'Very high: clear abuser'],
      },
      bot: { type: 'noul', instructions: 'The account behaves like a spammer or a bot rather than a real person' },
    }, 'riskScore', 15_000);
    return { risk: answers.risk || null, bot: answers.bot?.noul ?? null };
  }

  async function test() {
    const t0 = Date.now();
    const a = await ask('Message: "Hello! Nice to meet you, where are you from?"', { friendly: { type: 'noul', instructions: 'The message is friendly' } }, 'test');
    return { ok: true, friendly: a.friendly?.noul ?? null, ms: Date.now() - t0, model: cfg.model };
  }

  return { get config() { return cfg; }, publicConfig, save, on, moderateChat, triageReport, riskScore, test };
}
