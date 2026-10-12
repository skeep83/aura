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
    this.base = url ? url.replace(/\/$/, '') : '';
    this.up = null;          // результат последней проверки /healthz
    this.counters = { checked: 0, dropped: 0, failed: 0, msTotal: 0 };
  }

  // Живой ли сервис на самом деле (а не просто «настроен»)
  async ping() {
    if (!this.base) return;
    try {
      const res = await fetch(this.base + '/healthz', { signal: AbortSignal.timeout(3000) });
      this.up = res.ok;
    } catch { this.up = false; }
  }

  stats() {
    const c = this.counters;
    return { up: this.up, checked: c.checked, dropped: c.dropped, failed: c.failed, avgMs: c.checked ? Math.round(c.msTotal / c.checked) : 0, inflight: this.inflight };
  }

  get enabled() { return Boolean(this.url); }

  // Возвращает { nsfw: 0..1, minor: 0..1 | null } или null, если кадр не проверен
  async score(jpegBase64) {
    if (!this.enabled) return null;
    if (this.inflight >= this.maxInflight) { this.counters.dropped++; return null; }
    this.inflight++;
    const t0 = Date.now();
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
      this.counters.checked++;
      this.counters.msTotal += Date.now() - t0;
      return { nsfw, minor: typeof minor === 'number' ? minor : null };
    } catch (e) {
      this.counters.failed++;
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
