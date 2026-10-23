import crypto from 'node:crypto';
import { shareLang } from './langs.js';

// Duo — «двое на двое» с двух телефонов. Двое друзей объединяются в Duo по коду-приглашению и вместе ищут другую пару.
// Звонок — mesh из 4 участников: каждый соединён с каждым, сигналы адресуются по слоту 0..3.
// Группа живёт, только пока соединены все: клиенты сообщают итог каждого соединения (duo_conn); отвал или
// молчание дольше connTimeoutMs — группа распадается с причиной 'conn', обе двойки ищут дальше и
// avoidMs не сводятся друг с другом снова.
// Клиент: { id, langs, gender, country, send(msg) }.
export class DuoManager {
  constructor({ onGroupEnd = () => {}, connTimeoutMs = 20_000, avoidMs = 15_000 } = {}) {
    this.duos = new Map();    // code -> duo { code, members: [client], group, avoid: { code, until } }
    this.queue = [];          // duo в поиске
    this.onGroupEnd = onGroupEnd;
    this.connTimeoutMs = connTimeoutMs;
    this.avoidMs = avoidMs;
  }

  langsOf(duo) {
    // Общие языки участников; если пересечения нет — языки первого (лидера)
    const [a, b] = duo.members;
    if (!b) return a.langs || ['ru'];
    const common = (a.langs || ['ru']).filter(l => (b.langs || ['ru']).includes(l));
    return common.length ? common : a.langs || ['ru'];
  }

  info(duo) {
    return {
      code: duo.code, size: duo.members.length, searching: this.queue.includes(duo), inCall: Boolean(duo.group),
      partner: null,
    };
  }

  notify(duo) {
    for (const m of duo.members) {
      const partner = duo.members.find(x => x !== m);
      m.send({ t: 'duo', duo: { ...this.info(duo), partner: partner ? { gender: partner.gender, country: partner.country || null } : null } });
    }
  }

  create(client) {
    this.leave(client);
    let code;
    do { code = crypto.randomBytes(4).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toLowerCase(); }
    while (!code || this.duos.has(code));
    const duo = { code, members: [client], group: null, avoid: null };
    this.duos.set(code, duo);
    client.duo = duo;
    this.notify(duo);
    return duo;
  }

  join(client, code) {
    const duo = this.duos.get(String(code || '').toLowerCase());
    if (!duo) return 'not_found';
    const same = duo.members.findIndex(m => m.id === client.id);
    if (same !== -1) {
      // Тот же человек с нового соединения: занимает своё место, старое соединение больше не участник
      if (duo.members[same] !== client) { duo.members[same].duo = null; duo.members[same] = client; }
      client.duo = duo;
      this.notify(duo);
      return 'ok';
    }
    if (duo.members.length >= 2) return 'full';
    this.leave(client);
    duo.members.push(client);
    client.duo = duo;
    this.notify(duo);
    return 'ok';
  }

  leave(client) {
    const duo = client.duo;
    if (!duo) return;
    client.duo = null;
    if (!duo.members.includes(client)) return; // место уже занято новым соединением того же человека
    this.endGroup(duo, 'partner_left');
    this.unqueue(duo);
    duo.members = duo.members.filter(m => m !== client);
    if (!duo.members.length) this.duos.delete(duo.code);
    else this.notify(duo);
  }

  unqueue(duo) {
    const i = this.queue.indexOf(duo);
    if (i !== -1) this.queue.splice(i, 1);
  }

  avoids(a, b, now) {
    return (a.avoid?.code === b.code && now < a.avoid.until) || (b.avoid?.code === a.code && now < b.avoid.until);
  }

  // Поиск пары: нужна полная Duo; сводим с другой Duo, у которой есть общий язык и с которой только что не распались
  search(client, now = Date.now()) {
    const duo = client.duo;
    if (!duo || duo.members.length < 2 || duo.group) return false;
    this.unqueue(duo);
    const other = this.queue.find(d => d !== duo && shareLang(this.langsOf(duo), this.langsOf(d))
      && !this.avoids(duo, d, now)
      && !d.members.some(m => duo.members.some(x => x.id === m.id)));
    if (other) {
      this.unqueue(other);
      this.startGroup(other, duo, now);
    } else {
      this.queue.push(duo);
      this.notify(duo);
      for (const m of duo.members) m.send({ t: 'duo_waiting' });
    }
    return true;
  }

  startGroup(d1, d2, now = Date.now()) {
    const members = [...d1.members.map(c => ({ c, team: 'A' })), ...d2.members.map(c => ({ c, team: 'B' }))];
    const group = { members: members.map((m, slot) => ({ ...m, slot })), duos: [d1, d2], at: now, ok: new Map(), timer: null };
    d1.group = d2.group = group;
    // Пока не соединились все со всеми — ждём не дольше connTimeoutMs
    group.timer = setTimeout(() => this.failGroup(group, 'conn'), this.connTimeoutMs);
    group.timer.unref?.();
    for (const me of group.members) {
      me.c.send({
        t: 'duo_matched', you: me.slot, team: me.team,
        peers: group.members.filter(p => p !== me).map(p => ({ slot: p.slot, team: p.team, gender: p.c.gender, country: p.c.country || null })),
      });
    }
  }

  groupOf(client) { return client.duo?.group || null; }
  slotOf(client) { return this.groupOf(client)?.members.find(m => m.c === client)?.slot ?? null; }

  // Итог соединения с участником слота `to`: все соединены — таймер снимается; любой отвал — группа распадается.
  // Возвращает 'ok' | 'all' (соединились все) | 'failed' | null (не в группе)
  conn(client, to, ok) {
    const g = this.groupOf(client);
    const from = this.slotOf(client);
    if (!g || from === null || !g.members.some(m => m.slot === Number(to)) || Number(to) === from) return null;
    if (!ok) { this.failGroup(g, 'conn'); return 'failed'; }
    if (!g.ok.has(from)) g.ok.set(from, new Set());
    g.ok.get(from).add(Number(to));
    const all = g.members.every(m => (g.ok.get(m.slot)?.size || 0) >= g.members.length - 1);
    if (all && g.timer) { clearTimeout(g.timer); g.timer = null; }
    return all ? 'all' : 'ok';
  }
  connected(group) { return Boolean(group && !group.timer); }

  // Группа распалась: все узнают причину, обе Duo запоминают друг друга и, если полные, ищут дальше
  failGroup(group, reason = 'conn') {
    if (!group || group.duos.some(d => d.group !== group)) return false;
    this.teardown(group, reason);
    const [d1, d2] = group.duos;
    const until = Date.now() + this.avoidMs;
    d1.avoid = { code: d2.code, until };
    d2.avoid = { code: d1.code, until };
    for (const d of group.duos) if (d.members.length === 2) this.search(d.members[0]);
    return true;
  }

  teardown(group, reason) {
    if (group.timer) { clearTimeout(group.timer); group.timer = null; }
    for (const d of group.duos) d.group = null;
    for (const m of group.members) m.c.send({ t: 'duo_ended', reason });
    this.onGroupEnd(group, Date.now() - group.at);
  }

  // Адресный сигнал WebRTC: от слота к слоту внутри группы
  relay(client, to, data) {
    const g = this.groupOf(client);
    const from = this.slotOf(client);
    const target = g?.members.find(m => m.slot === Number(to));
    if (!target || target.c === client) return false;
    target.c.send({ t: 'duo_signal', from, data });
    return true;
  }

  // Рассылка всем остальным участникам группы (чат, реакции)
  broadcast(client, msg) {
    const g = this.groupOf(client);
    if (!g) return 0;
    const from = this.slotOf(client);
    let n = 0;
    for (const m of g.members) if (m.c !== client) { m.c.send({ ...msg, from }); n++; }
    return n;
  }

  // «Далее» или выход: группа распадается, остальные полные Duo снова ищут
  endGroup(duo, reason = 'next') {
    const g = duo?.group;
    if (!g) return;
    this.teardown(g, reason);
    for (const d of g.duos) {
      if (d.members.length === 2 && d !== duo) this.search(d.members[0]);
    }
  }

  next(client) {
    const duo = client.duo;
    if (!duo?.group) return this.search(client);
    this.endGroup(duo, 'next');
    return this.search(client);
  }

  stats() {
    let inCall = 0;
    for (const d of this.duos.values()) if (d.group) inCall++;
    return { duos: this.duos.size, duoQueue: this.queue.length, duoInCall: inCall };
  }
}
