import crypto from 'node:crypto';
import { shareLang } from './langs.js';

// Duo — «двое на двое». Двое друзей объединяются в Duo по коду-приглашению и вместе ищут другую пару.
// Звонок — mesh из 4 участников: каждый соединён с каждым, сигналы адресуются по слоту 0..3.
// Клиент: { id, langs, gender, country, send(msg) }.
export class DuoManager {
  constructor({ onGroupEnd = () => {} } = {}) {
    this.duos = new Map();    // code -> duo { code, members: [client], waiting, group }
    this.queue = [];          // duo в поиске
    this.onGroupEnd = onGroupEnd;
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
    const duo = { code, members: [client], group: null };
    this.duos.set(code, duo);
    client.duo = duo;
    this.notify(duo);
    return duo;
  }

  join(client, code) {
    const duo = this.duos.get(String(code || '').toLowerCase());
    if (!duo) return 'not_found';
    if (duo.members.some(m => m.id === client.id)) { client.duo = duo; this.notify(duo); return 'ok'; }
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

  // Поиск пары: нужна полная Duo; сводим с другой Duo, у которой есть общий язык
  search(client) {
    const duo = client.duo;
    if (!duo || duo.members.length < 2 || duo.group) return false;
    this.unqueue(duo);
    const other = this.queue.find(d => d !== duo && shareLang(this.langsOf(duo), this.langsOf(d))
      && !d.members.some(m => duo.members.some(x => x.id === m.id)));
    if (other) {
      this.unqueue(other);
      this.startGroup(other, duo);
    } else {
      this.queue.push(duo);
      this.notify(duo);
      for (const m of duo.members) m.send({ t: 'duo_waiting' });
    }
    return true;
  }

  startGroup(d1, d2) {
    const members = [...d1.members.map(c => ({ c, team: 'A' })), ...d2.members.map(c => ({ c, team: 'B' }))];
    const group = { members: members.map((m, slot) => ({ ...m, slot })), duos: [d1, d2], at: Date.now() };
    d1.group = d2.group = group;
    for (const me of group.members) {
      me.c.send({
        t: 'duo_matched', you: me.slot, team: me.team,
        peers: group.members.filter(p => p !== me).map(p => ({ slot: p.slot, team: p.team, gender: p.c.gender, country: p.c.country || null })),
      });
    }
  }

  groupOf(client) { return client.duo?.group || null; }
  slotOf(client) { return this.groupOf(client)?.members.find(m => m.c === client)?.slot ?? null; }

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

  // «Далее» или выход: группа распадается, полные Duo снова ищут
  endGroup(duo, reason = 'next') {
    const g = duo?.group;
    if (!g) return;
    for (const d of g.duos) d.group = null;
    for (const m of g.members) m.c.send({ t: 'duo_ended', reason });
    this.onGroupEnd(g, Date.now() - g.at);
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
