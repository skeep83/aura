import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.js';
import { createThreads } from '../src/threads.js';

const DAY = 86_400_000, HOUR = 3_600_000;
// Заглушка ИИ: считает запросы, переводит префиксом языка
function fakeAi() {
  const calls = [];
  return {
    calls,
    on: () => true,
    async translateBatch(texts, lang) { calls.push(texts.length); return texts.map(t => `[${lang}] ${t}`); },
    async threadTitle() { return 'Заголовок'; },
  };
}
const mk = (ai = null, extra = {}) => createThreads({ db: new Db(':memory:'), ai, ...extra });

test('нити: старт → ходы → финал на max_hops; закрывший получает карточку с финалом', async () => {
  const th = mk(null, { kinds: { story: { maxHops: 3, maxLen: 120 } } });
  const s = th.start('a', { kind: 'story', text: 'Жил-был кот.', lang: 'ru', country: 'MD' }, 1000);
  assert.ok(s.thread);
  assert.equal(th.holding('a').id, s.thread.id);
  assert.equal(th.startsLeft('a', false, 1000), 0, 'одна своя нить в сутки');
  assert.equal(th.startsLeft('a', true, 1000), 2, 'Premium — три');

  const r1 = th.take(s.thread.id, 'a', 'b', { text: 'Он любил дождь.', lang: 'en', country: 'AR' }, 2000);
  assert.equal(r1.finished, false);
  assert.equal(th.holding('a'), null, 'отдавший больше не держит');
  assert.equal(th.holding('b').hops, 2);

  const r2 = th.take(s.thread.id, 'b', 'c', { text: 'И однажды уплыл.', lang: 'es', country: 'ES' }, 3000);
  assert.equal(r2.finished, true);
  assert.equal(r2.thread.status, 'done');
  assert.equal(th.holding('c'), null, 'закрытая нить ни у кого в кармане');

  const card = await th.view(r2.thread, 'ru', 'b', 4000);
  assert.deepEqual(card.countries, ['MD', 'AR', 'ES']);
  assert.equal(card.myHop, 2);
  assert.equal(card.moves.length, 3);
  assert.equal(card.moves[1].orig, null, 'без ИИ показываем оригинал');
});

test('нити: один человек не бывает в нити дважды, не держит две нити, не передаёт чужую', () => {
  const th = mk();
  const { thread } = th.start('a', { kind: 'question', text: 'Что тебя сегодня порадовало?' }, 0);
  assert.equal(th.take(thread.id, 'a', 'a', { text: 'Солнце' }).error, 'already');
  assert.equal(th.take(thread.id, 'b', 'c', { text: 'Солнце' }).error, 'not_holder');
  th.take(thread.id, 'a', 'b', { text: 'Кофе' });
  assert.equal(th.take(thread.id, 'b', 'a', { text: 'Снова я' }).error, 'already', 'автор уже участвовал');
  const other = th.start('z', { kind: 'wish', text: 'Пусть всё получится' }, 0).thread;
  assert.equal(th.take(other.id, 'z', 'b', { text: 'И тебе' }).error, 'holding', 'у b уже есть нить в кармане');
  assert.equal(th.start('b', { kind: 'wish', text: 'Своя' }).error, 'holding');
  assert.equal(th.start('q', { kind: 'nope', text: 'x' }).error, 'kind');
  assert.equal(th.start('q', { kind: 'wish', text: ' ' }).error, 'text');
});

test('нити: застрявшая уходит в пул и вручается тому, кто в ней не был; три раза подряд — архив', () => {
  const th = mk(null, { stuckMs: HOUR, maxDrops: 3 });
  const { thread } = th.start('a', { kind: 'wish', text: 'Тепла тебе' }, 0);
  th.take(thread.id, 'a', 'b', { text: 'И тебе' }, 10);
  assert.deepEqual(th.tick(HOUR / 2), []);
  assert.equal(th.byId(thread.id).status, 'live');
  th.tick(2 * HOUR);
  assert.equal(th.byId(thread.id).status, 'pool');
  assert.equal(th.holding('b'), null);
  assert.equal(th.offerFor('a'), null, 'автор уже в нити — ему не предлагаем');
  assert.equal(th.offerFor('c').id, thread.id);
  assert.equal(th.accept(thread.id, 'c', 2 * HOUR).thread.holder_id, 'c');
  assert.equal(th.accept(thread.id, 'd').error, 'gone', 'уже забрали');
  th.tick(4 * HOUR); // второй раз застряла
  assert.equal(th.byId(thread.id).drops, 2);
  th.accept(thread.id, 'd', 4 * HOUR);
  th.tick(6 * HOUR); // третий — архив
  assert.equal(th.byId(thread.id).status, 'archived');
  assert.equal(th.offerFor('e'), null);
});

test('нити: по сроку — финал, если ходов достаточно, иначе архив; ход автора после финала невозможен', () => {
  const th = mk(null, { ttlMs: DAY, minHopsToFinish: 3 });
  const short = th.start('a', { kind: 'story', text: 'Коротко' }, 0).thread;
  const long = th.start('b', { kind: 'story', text: 'Раз' }, 0).thread;
  th.take(long.id, 'b', 'c', { text: 'Два' }, 1);
  th.take(long.id, 'c', 'd', { text: 'Три' }, 2);
  const done = th.tick(2 * DAY);
  assert.equal(done.length, 1);
  assert.equal(done[0].id, long.id);
  assert.equal(th.byId(short.id).status, 'archived');
  assert.equal(th.take(long.id, 'd', 'e', { text: 'Четыре' }).error, 'gone');
  assert.deepEqual(th.participants(long.id).map(p => p.id), ['b', 'c', 'd']);
});

test('нити: скрытый ход не рвёт цепочку, скрытый первый ход — архив', async () => {
  const th = mk();
  const { thread } = th.start('a', { kind: 'question', text: 'Вопрос?' }, 0);
  th.take(thread.id, 'a', 'b', { text: 'Плохой ответ' }, 1);
  th.take(thread.id, 'b', 'c', { text: 'Хороший ответ' }, 2);
  th.hideMove(thread.id, 2);
  const card = await th.view(th.byId(thread.id), 'ru', 'c');
  assert.equal(card.hops, 3);
  assert.equal(card.moves[1].hidden, true);
  assert.equal(card.moves[1].text, '');
  assert.equal(card.moves[2].text, 'Хороший ответ');
  th.hideMove(thread.id, 1);
  assert.equal(th.byId(thread.id).status, 'archived');
});

test('нити: перевод пакетом на язык читателя, кэш в базе — второй просмотр без ИИ', async () => {
  const ai = fakeAi();
  const th = mk(ai, { kinds: { story: { maxHops: 3, maxLen: 120 } } });
  const { thread } = th.start('a', { kind: 'story', text: 'Era una vez', lang: 'es', country: 'AR' }, 0);
  th.take(thread.id, 'a', 'b', { text: 'Жил-был', lang: 'ru', country: 'MD' }, 1);
  let card = await th.view(th.byId(thread.id), 'ru', 'b');
  assert.equal(card.moves[0].text, '[ru] Era una vez');
  assert.equal(card.moves[0].orig, 'Era una vez');
  assert.equal(card.moves[1].text, 'Жил-был', 'свой язык не переводится');
  assert.equal(card.moves[1].orig, null);
  assert.deepEqual(ai.calls, [1], 'переведён только один чужой ход');
  card = await th.view(th.byId(thread.id), 'ru', 'b');
  assert.deepEqual(ai.calls, [1], 'повторный просмотр — из кэша');
  const r = th.take(thread.id, 'b', 'c', { text: 'Once upon a time', lang: 'en', country: 'GB' }, 2);
  assert.equal(r.finished, true);
  const fin = await th.view(r.thread, 'de', 'c');
  assert.deepEqual(ai.calls, [1, 3], 'для немецкого — все три хода одним запросом');
  assert.equal(fin.title, 'Заголовок');
  assert.equal(fin.days, 1);
  assert.deepEqual(th.stats(), { threadsLive: 0, threadsPool: 0, threadsDone: 1 });
});

test('нити: ИИ молчит дольше таймаута — карточка уходит с оригиналами, кэш не портится', async () => {
  const ai = { on: () => true, translateBatch: () => new Promise(() => {}), threadTitle: () => new Promise(() => {}) };
  const th = mk(ai, { translateTimeoutMs: 20 });
  const { thread } = th.start('a', { kind: 'wish', text: 'Suerte', lang: 'es' }, 0);
  const card = await th.view(thread, 'ru', 'b');
  assert.equal(card.moves[0].text, 'Suerte');
  assert.equal(card.moves[0].orig, null);
});
