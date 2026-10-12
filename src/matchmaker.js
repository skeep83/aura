import { shareLang } from './langs.js';

// Очередь ожидания и пары.
// Клиент: { id, gender: 'm'|'f'|'x', want: 'any'|'m'|'f', premium, langs: ['ru',…], room: slug|null,
//           tier: 'low'|'ok' (по ауре), send(msg) }.
// Мягкие ограничения ослабевают со временем ожидания, чтобы при малом онлайне никто не зависал:
//   повтор с последним собеседником — после rematchAfterMs, смешение уровней ауры — после tierRelaxMs.
// Жёсткие — никогда: общий язык, одна комната, фильтр по полу.
const wants = (a, b) => a.want === 'any' || a.want === b.gender;

export class Matchmaker {
  constructor({ rematchAfterMs = 10_000, tierRelaxMs = 15_000, newbieRelaxMs = 40_000, onPair = () => {}, onUnpair = () => {}, peerInfo = null } = {}) {
    this.newbieRelaxMs = newbieRelaxMs;
    // peerInfo(self, other, common) → что клиент self узнаёт о собеседнике (сервер прячет страну на время игры «Угадай»)
    this.peerInfo = peerInfo;
    this.rematchAfterMs = rematchAfterMs;
    this.tierRelaxMs = tierRelaxMs;
    this.onPair = onPair;
    this.onUnpair = onUnpair;
    this.waiting = [];          // FIFO
    this.queuedAt = new Map();  // client -> время постановки в очередь
    this.pairs = new Map();     // client -> peer
    this.pairedAt = new Map();  // client -> время начала разговора
    this.lastPeer = new Map();  // userId -> userId последнего собеседника
  }

  waited(c, now) { return now - this.queuedAt.get(c); }

  canPair(a, b, now) {
    if (a === b || a.id === b.id) return false;
    if ((a.room || null) !== (b.room || null)) return false;
    if (!shareLang(a.langs || ['ru'], b.langs || ['ru'])) return false;
    if (!wants(a, b) || !wants(b, a)) return false;
    const both = ms => this.waited(a, now) >= ms && this.waited(b, now) >= ms;
    if ((a.tier || 'ok') !== (b.tier || 'ok') && !both(this.tierRelaxMs)) return false;
    // Новичка не сводим с людьми с плохой репутацией — первое впечатление решает, вернётся ли он
    if (((a.newbie && b.tier === 'low') || (b.newbie && a.tier === 'low')) && !both(this.newbieRelaxMs)) return false;
    // Режим «Сначала голос» — сводим одинаковых, смешиваем только если оба долго ждут
    if (Boolean(a.reveal) !== Boolean(b.reveal) && !both(this.tierRelaxMs)) return false;
    const recent = this.lastPeer.get(a.id) === b.id || this.lastPeer.get(b.id) === a.id;
    return !recent || both(this.rematchAfterMs);
  }

  // Кандидат для client: Premium вперёд; новичку — лучший собеседник (высокая аура, не новичок);
  // при равенстве — кто дольше ждёт (очередь FIFO)
  score(client, o) {
    let s = o.premium ? 100 : 0;
    if (client.newbie) s += (o.good ? 50 : 0) + (o.newbie ? 0 : 20);
    if (o.newbie && client.good) s += 10;
    return s;
  }
  pick(client, now, from = this.waiting) {
    let best = null, bestScore = -1;
    for (const o of from) {
      if (!this.canPair(client, o, now)) continue;
      const sc = this.score(client, o);
      if (sc > bestScore) { best = o; bestScore = sc; }
    }
    return best;
  }

  pair(initiator, other, now = Date.now()) {
    const waits = [this.waited(initiator, now), this.waited(other, now)];
    for (const c of [initiator, other]) {
      this.waiting.splice(this.waiting.indexOf(c), 1);
      this.queuedAt.delete(c);
      this.pairedAt.set(c, now);
    }
    this.pairs.set(initiator, other);
    this.pairs.set(other, initiator);
    this.lastPeer.set(initiator.id, other.id);
    this.lastPeer.set(other.id, initiator.id);
    const common = (initiator.langs || ['ru']).filter(l => (other.langs || ['ru']).includes(l));
    const reveal = Boolean(initiator.reveal && other.reveal);
    const describe = (self, o) => this.peerInfo
      ? this.peerInfo(self, o, common)
      : { gender: o.gender, langs: common, country: o.country || null };
    initiator.send({ t: 'matched', initiator: true, reveal, peer: describe(initiator, other) });
    other.send({ t: 'matched', initiator: false, reveal, peer: describe(other, initiator) });
    this.onPair(initiator, other, now, waits);
  }

  // Пара без очереди: звонок другу, комната стримера. Прежние разговоры обоих разрываются.
  // Возвращает бывших собеседников (их нужно вернуть в очередь)
  forcePair(a, b, now = Date.now()) {
    const former = [a, b].map(c => this.leave(c, { t: 'peer_left' }, now)).filter(p => p && p !== a && p !== b);
    for (const c of [a, b]) { this.waiting.push(c); this.queuedAt.set(c, now); }
    this.pair(a, b, now);
    return former;
  }

  enqueue(client, now = Date.now()) {
    this.leave(client, undefined, now);
    this.waiting.push(client);
    this.queuedAt.set(client, now);
    const other = this.pick(client, now);
    if (other) this.pair(other, client, now); // оффер создаёт тот, кто ждал дольше
    else client.send({ t: 'waiting' });
  }

  // Периодический проход: сводит тех, кому раньше мешали мягкие ограничения
  tick(now = Date.now()) {
    for (let i = 0; i < this.waiting.length; i++) {
      const a = this.waiting[i];
      const b = this.pick(a, now, this.waiting.slice(i + 1));
      if (b) { this.pair(a, b, now); i--; }
    }
  }

  isWaiting(client) { return this.queuedAt.has(client); }
  peerOf(client) { return this.pairs.get(client) || null; }
  talkingSince(client) { return this.pairedAt.get(client) || 0; }

  // Пары, которые говорят дольше ms (для раундов события)
  pairsOlderThan(ms, now = Date.now()) {
    const out = [];
    for (const [a, b] of this.pairs) {
      if (a.id < b.id && now - this.pairedAt.get(a) >= ms) out.push([a, b]);
    }
    return out;
  }

  // Убирает клиента из очереди и разрывает пару. Возвращает бывшего собеседника.
  leave(client, notice = { t: 'peer_left' }, now = Date.now()) {
    const i = this.waiting.indexOf(client);
    if (i !== -1) { this.waiting.splice(i, 1); this.queuedAt.delete(client); }
    const peer = this.pairs.get(client);
    if (!peer) return null;
    const startedAt = this.pairedAt.get(client);
    this.pairs.delete(client);
    this.pairs.delete(peer);
    this.pairedAt.delete(client);
    this.pairedAt.delete(peer);
    peer.send(notice);
    this.onUnpair(client, peer, now - startedAt);
    return peer;
  }

  online(room = null) {
    let n = 0;
    for (const c of this.waiting) if ((c.room || null) === room) n++;
    for (const c of this.pairs.keys()) if ((c.room || null) === room) n++;
    return n;
  }

  stats() {
    return { waiting: this.waiting.length, talking: this.pairs.size };
  }
}
