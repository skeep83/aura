// Клиент к сервису NSFW-модерации (moderation/app.py).
// Если сервис недоступен — кадр пропускается (fail-open), но в лог пишется ошибка.
export class Moderation {
  constructor({ url, token, threshold = 0.85, minorThreshold = 0.8, maxInflight = 8, timeoutMs = 4000 }) {
    this.url = url ? url.replace(/\/$/, '') + '/check' : '';
    this.token = token;
    this.threshold = threshold;
    this.minorThreshold = minorThreshold;
    this.maxInflight = maxInflight;
    this.timeoutMs = timeoutMs;
    this.inflight = 0;
    this.lastErrorLog = 0;
  }

  get enabled() { return Boolean(this.url); }

  // Возвращает { nsfw: 0..1, minor: 0..1 | null } или null, если кадр не проверен
  async score(jpegBase64) {
    if (!this.enabled || this.inflight >= this.maxInflight) return null;
    this.inflight++;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ image: jpegBase64 }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { nsfw, minor } = await res.json();
      if (typeof nsfw !== 'number') return null;
      return { nsfw, minor: typeof minor === 'number' ? minor : null };
    } catch (e) {
      if (Date.now() - this.lastErrorLog > 60_000) {
        this.lastErrorLog = Date.now();
        console.error('moderation unavailable:', e.message);
      }
      return null;
    } finally {
      this.inflight--;
    }
  }

  isViolation(r) { return Boolean(r) && r.nsfw >= this.threshold; }
  isMinor(r) { return Boolean(r) && r.minor !== null && r.minor >= this.minorThreshold; }
}
