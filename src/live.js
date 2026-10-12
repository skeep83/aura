// Комната стримера: зрители встают в очередь по ссылке startapp=live_<код стримера> и по одному
// разговаривают со стримером. Ход длится roundSec, «Далее» у стримера — следующий зритель.
// Зрители между собой не сводятся. Пары создаются через matchmaker.forcePair, поэтому сигналинг,
// чат, реакции и модерация работают как в обычном разговоре.
const ROUNDS = [60, 120, 180, 300];

export class LiveManager {
  constructor({ mm, onLive = () => {}, requeue = () => {}, linkFor = code => code }) {
    this.mm = mm;
    this.onLive = onLive;         // стример начал эфир (уведомить подписчиков)
    this.requeue = requeue;       // что делать с бывшими собеседниками при forcePair
    this.linkFor = linkFor;
    this.rooms = new Map();       // code -> { code, host, title, roundMs, queue, current, timer, nextTimer, startedAt, turns }
  }

  room(code) { return this.rooms.get(code) || null; }
  roomOfHost(host) { return host?.live?.role === 'host' ? this.rooms.get(host.live.code) : null; }

  start(host, code, { title, roundSec }) {
    this.stop(host, 'restart');
    const room = {
      code, host, title: String(title || '').trim().slice(0, 40) || host.name || 'Aura Live',
      roundMs: (ROUNDS.includes(Number(roundSec)) ? Number(roundSec) : 120) * 1000,
      queue: [], current: null, timer: null, nextTimer: null, startedAt: Date.now(), turns: 0,
    };
    this.rooms.set(code, room);
    host.live = { role: 'host', code };
    this.requeue(this.mm.leave(host));
    this.status(room);
    this.onLive(room);
    return room;
  }

  stop(host, reason = 'ended') {
    const room = this.roomOfHost(host);
    if (!room) return;
    clearTimeout(room.timer);
    clearTimeout(room.nextTimer);
    this.rooms.delete(room.code);
    for (const v of room.queue) { v.live = null; v.send({ t: 'live', state: 'ended', title: room.title }); }
    const cur = room.current;
    room.queue = [];
    room.current = null;
    host.live = null;
    if (cur && this.mm.peerOf(host) === cur) this.mm.leave(host, { t: 'peer_left', reason: 'live_ended' });
    if (cur) { cur.live = null; cur.send({ t: 'live', state: 'ended', title: room.title }); }
    host.send({ t: 'live', role: 'host', state: 'stopped', reason });
  }

  // Зритель по ссылке: в очередь, если эфир идёт; иначе — «не в эфире»
  join(viewer, code) {
    const room = this.rooms.get(code);
    if (!room || room.host === viewer) return false;
    this.leave(viewer);
    this.requeue(this.mm.leave(viewer));
    viewer.live = { role: 'viewer', code };
    room.queue.push(viewer);
    this.status(room);
    this.next(room);
    return true;
  }

  leave(viewer) {
    if (viewer?.live?.role !== 'viewer') return;
    const room = this.rooms.get(viewer.live.code);
    viewer.live = null;
    if (!room) return;
    room.queue = room.queue.filter(v => v !== viewer);
    this.status(room);
  }

  // Следующий зритель к свободному стримеру
  next(room) {
    clearTimeout(room.nextTimer);
    if (!this.rooms.has(room.code) || this.mm.peerOf(room.host)) return;
    const v = room.queue.shift();
    if (!v) { room.current = null; return this.status(room); }
    room.current = v;
    room.turns++;
    room.host.direct = v.direct = 'live';
    for (const c of [room.host, v]) c.directEnded = false;
    this.mm.forcePair(room.host, v).forEach(p => this.requeue(p));
    clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      if (this.mm.peerOf(room.host) === v) this.mm.leave(room.host, { t: 'peer_left', reason: 'live_turn' });
    }, room.roundMs);
    room.turnEndsAt = Date.now() + room.roundMs;
    this.status(room);
  }

  // Разговор в эфире закончился (таймер, «Далее», выход): зритель — «ваш ход окончен», стримеру — следующий
  onUnpair(a, b) {
    for (const [host, viewer] of [[a, b], [b, a]]) {
      const room = this.roomOfHost(host);
      if (!room || room.current !== viewer) continue;
      clearTimeout(room.timer);
      room.current = null;
      viewer.live = null;
      viewer.send({ t: 'live', state: 'done', code: room.code, title: room.title });
      room.nextTimer = setTimeout(() => this.next(room), 1500);
      this.status(room);
    }
  }

  status(room) {
    const link = this.linkFor(room.code);
    room.host.send({
      t: 'live', role: 'host', state: 'on', code: room.code, title: room.title, link, queue: room.queue.length,
      roundSec: room.roundMs / 1000, turnEndsAt: room.current ? room.turnEndsAt : 0, turns: room.turns,
    });
    room.queue.forEach((v, i) => v.send({ t: 'live', role: 'viewer', state: 'queue', title: room.title, position: i + 1, size: room.queue.length }));
  }

  // Отключение клиента: стример — конец эфира, зритель — выход из очереди
  drop(client) {
    if (client?.live?.role === 'host') this.stop(client, 'disconnected');
    else this.leave(client);
  }

  stats() {
    let viewers = 0;
    for (const r of this.rooms.values()) viewers += r.queue.length + (r.current ? 1 : 0);
    return { liveRooms: this.rooms.size, liveViewers: viewers };
  }
}
