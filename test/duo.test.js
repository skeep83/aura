import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DuoManager } from '../src/duo.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mk = id => ({ id, langs: ['ru'], gender: 'x', country: '', inbox: [], send(m) { this.inbox.push(m); }, last(t) { return [...this.inbox].reverse().find(m => m.t === t); } });

// Две полные Duo, сведённые в группу
function group(opts = {}) {
  const duos = new DuoManager(opts);
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(mk);
  duos.create(a1); duos.join(a2, a1.duo.code);
  duos.create(b1); duos.join(b2, b1.duo.code);
  duos.search(a1);
  duos.search(b1);
  return { duos, a1, a2, b1, b2 };
}

test('duo: группа живёт, только когда соединились все — таймер снимается после 12 отчётов', async () => {
  const { duos, a1, a2, b1, b2 } = group({ connTimeoutMs: 40 });
  const all = [a1, a2, b1, b2];
  for (const c of all) assert.ok(c.last('duo_matched'));
  const slot = c => c.last('duo_matched').you;
  let r = null;
  for (const c of all) for (const o of all) if (o !== c) r = duos.conn(c, slot(o), true);
  assert.equal(r, 'all');
  assert.equal(duos.connected(duos.groupOf(a1)), true);
  await sleep(60);
  for (const c of all) assert.equal(c.last('duo_ended'), undefined, 'соединённая группа не распадается по таймеру');
  assert.equal(duos.conn(a1, slot(a1), true), null, 'отчёт о себе игнорируется');
});

test('duo: без отчётов группа распадается по таймауту, обе Duo снова ищут, но не друг с другом', async () => {
  const { duos, a1, a2, b1, b2 } = group({ connTimeoutMs: 30, avoidMs: 80 });
  await sleep(50);
  for (const c of [a1, a2, b1, b2]) assert.equal(c.last('duo_ended')?.reason, 'conn');
  assert.equal(duos.stats().duoInCall, 0);
  assert.equal(duos.stats().duoQueue, 2, 'обе двойки в очереди');
  assert.equal(a1.last('duo_waiting') && b1.last('duo_waiting') && true, true);
  duos.search(a1);
  assert.equal(duos.groupOf(a1), null, 'сразу друг с другом не сводим');
  await sleep(90);
  duos.search(a1);
  assert.ok(duos.groupOf(a1), 'после паузы можно снова');
  assert.equal(duos.groupOf(a1), duos.groupOf(b1));
});

test('duo: отвал одного соединения — группа распадается с причиной conn, третья Duo подхватывает', () => {
  const { duos, a1, a2, b1, b2 } = group({ connTimeoutMs: 10_000, avoidMs: 60_000 });
  const slot = c => c.last('duo_matched').you;
  assert.equal(duos.conn(b2, slot(a1), false), 'failed');
  for (const c of [a1, a2, b1, b2]) assert.equal(c.last('duo_ended')?.reason, 'conn');
  assert.equal(duos.conn(b2, slot(a1), false), null, 'группы уже нет');
  const [c1, c2] = ['c1', 'c2'].map(mk);
  duos.create(c1); duos.join(c2, c1.duo.code);
  duos.search(c1);
  assert.ok(duos.groupOf(c1), 'новая Duo сводится с одной из ждущих');
  const partner = duos.groupOf(c1).duos.find(d => d !== c1.duo);
  assert.ok([a1.duo, b1.duo].includes(partner));
  const left = partner === a1.duo ? b1 : a1;
  assert.equal(duos.groupOf(left), null);
});

test('duo: человек с нового соединения занимает своё место, старое не ломает Duo при закрытии', () => {
  const duos = new DuoManager();
  const a1 = mk('a1'), a2 = mk('a2'), a1b = mk('a1');
  duos.create(a1); duos.join(a2, a1.duo.code);
  assert.equal(duos.join(a1b, a1.duo.code), 'ok');
  assert.deepEqual(a2.duo.members, [a1b, a2], 'новое соединение заняло место старого');
  assert.equal(a1.duo, null, 'старое соединение больше не участник');
  duos.leave(a1); // закрылся старый сокет
  assert.equal(a2.duo.members.length, 2, 'Duo осталась полной');
  assert.equal(duos.search(a1b), true);
});
