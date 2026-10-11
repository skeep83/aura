import fs from 'node:fs';
import crypto from 'node:crypto';
import { botProfile, pickLang, note } from './bot-profile.js';

// Бот на long polling: /start, комнаты каналов, Aura Hour, оплата Telegram Stars, поддержка, админ-команды.
export function createBot({ token, site, stateFile, appName, adminIds, supportContact, plans, db, appLink, schedule, stats, kick, onPremium }) {
  const api = async (method, body) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json();
    if (!json.ok) throw Object.assign(new Error(`${method}: ${json.description}`), { code: json.error_code, retryAfter: json.parameters?.retry_after });
    return json.result;
  };

  const self = { username: '' };
  const profile = botProfile({ appName, eventTime: process.env.EVENT_TIME || '21:00' });
  const reply = (chatId, text, extra = {}) =>
    api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  const isAdmin = id => adminIds.includes(String(id));
  const appButton = (text, url = site.url) => url
    ? { reply_markup: { inline_keyboard: [[{ text, web_app: { url } }]] } }
    : {};
  const linkButton = (text, url) => ({ reply_markup: { inline_keyboard: [[{ text, url }]] } });
  const escape = s => String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

  // Сообщение пользователю; молча пропускаем тех, кто заблокировал бота
  async function notify(userId, text, extra = {}) {
    if (String(userId).startsWith('dev-')) return;
    try { await reply(userId, text, extra); }
    catch (e) { if (e.code !== 403 && e.code !== 400) console.warn('notify:', e.message); }
  }

  // Рассылка с ограничением ~25 сообщений/с (лимит Telegram — 30)
  async function remindEvent(users) {
    const s = schedule.state();
    const m = Math.round(s.roundMs / 60000);
    console.log(`Aura Hour: напоминание ${users.length} пользователям`);
    for (const { id, lang } of users) {
      await notify(id, note(lang, 'remind', { m }), appButton(note(lang, 'open')));
      await new Promise(r => setTimeout(r, 40));
    }
  }

  function createInvoiceLink(userId, planId) {
    const plan = plans[planId];
    if (!plan) throw new Error('unknown plan');
    return api('createInvoiceLink', {
      title: `${appName} Premium · ${plan.title}`,
      description: 'Безлимитный фильтр «кого ищу» и приоритет в очереди. Без автопродления.',
      payload: JSON.stringify({ u: userId, p: planId }),
      currency: 'XTR',
      prices: [{ label: plan.title, amount: plan.stars }],
    });
  }

  async function onPreCheckout(q) {
    let ok = false;
    try {
      const { u, p } = JSON.parse(q.invoice_payload);
      ok = String(q.from.id) === u && plans[p]?.stars === q.total_amount && q.currency === 'XTR'
        && !db.bannedUntil(u);
    } catch {}
    await api('answerPreCheckoutQuery', ok
      ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: 'Платёж не прошёл проверку, попробуйте ещё раз из приложения.' });
  }

  async function onPaid(msg) {
    const sp = msg.successful_payment;
    const { u, p } = JSON.parse(sp.invoice_payload);
    const plan = plans[p];
    const until = db.addPayment({
      chargeId: sp.telegram_payment_charge_id, userId: u, plan: p, stars: sp.total_amount, days: plan.days,
    });
    onPremium(u, until);
    db.event('premium', u, sp.total_amount, p);
    const date = new Date(until).toLocaleDateString('ru-RU');
    await reply(msg.chat.id, `👑 Premium активен до <b>${date}</b>. Спасибо!`, appButton('🎥 Вернуться в чат'));
  }

  async function onMessage(msg) {
    if (msg.successful_payment) return onPaid(msg);
    const text = (msg.text || '').trim();
    const [cmd] = text.split(/\s+/);
    const arg = text.slice(cmd.length).trim();
    const chatId = msg.chat.id;
    const from = String(msg.from?.id || '');
    if (from && msg.chat.type === 'private') db.setAllowsPm(from);

    switch (cmd.split('@')[0]) {
      case '/start': {
        const param = arg.startsWith('room_') || arg.startsWith('ref_') ? arg : '';
        const p = profile[pickLang(msg.from?.language_code)];
        return reply(chatId, p.description, param ? linkButton(p.button, appLink(param)) : appButton(p.button));
      }
      case '/room': {
        if (!arg) {
          return reply(chatId,
            '📢 <b>Рулетка для вашего канала</b>\n\nСвоя комната, где общаются только ваши подписчики.\n' +
            'Создать: <code>/room Название канала</code>\n\n' +
            'Подключите партнёрскую программу бота — и получайте процент со Stars, которые потратят ваши подписчики.');
        }
        const room = db.createRoom(from, arg);
        const link = appLink(`room_${room.slug}`);
        return reply(chatId,
          `✅ Комната «${escape(room.title)}» создана.\n\nСсылка для поста в канале:\n<code>${link}</code>\n\n` +
          'Статистика: /myrooms', linkButton('Открыть комнату', link));
      }
      case '/myrooms': {
        const rooms = db.roomsOf(from);
        if (!rooms.length) return reply(chatId, 'У вас пока нет комнат. Создайте: <code>/room Название</code>');
        return reply(chatId, rooms.map(r =>
          `📢 <b>${escape(r.title)}</b>\nзаходов: ${r.visits} · разговоров: ${r.matches}\n<code>${appLink(`room_${r.slug}`)}</code>`).join('\n\n'));
      }
      case '/events_off':
        db.setNotify(from, false);
        return reply(chatId, 'Напоминания об Aura Hour выключены. Включить: /events_on');
      case '/events_on':
        db.setNotify(from, true);
        return reply(chatId, 'Напоминания об Aura Hour включены 🔥');
      case '/invite': {
        const link = appLink(`ref_${from}`);
        return reply(chatId, `Пригласите друга — вы оба получите Premium на сутки 🎁\n\n<code>${link}</code>`,
          linkButton('Поделиться', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`Залетай в ${appName} — видеочат со всем миром ✨`)}`));
      }
      case '/terms':
        return reply(chatId, `Правила: ${site.url}/terms.html\nКонфиденциальность: ${site.url}/privacy.html`);
      case '/paysupport':
      case '/support':
        return reply(chatId,
          `По вопросам оплаты и возврата пишите: ${supportContact}\nУкажите дату платежа — мы ответим в течение 48 часов.`);
    }
    if (!isAdmin(from)) return;

    switch (cmd) {
      case '/stats':
        return reply(chatId, Object.entries(stats()).map(([k, v]) => `${k}: <b>${v}</b>`).join('\n'));
      case '/ban':
        if (!arg) return reply(chatId, '/ban &lt;telegram_id&gt;');
        db.ban(arg, Infinity, 'admin');
        kick(arg);
        return reply(chatId, `Забанен ${arg}`);
      case '/unban':
        if (!arg) return reply(chatId, '/unban &lt;telegram_id&gt;');
        db.unban(arg);
        return reply(chatId, `Разбанен ${arg}`);
      case '/refund': {
        const p = arg && db.payment(arg);
        if (!p) return reply(chatId, '/refund &lt;telegram_payment_charge_id&gt; — платёж не найден');
        await api('refundStarPayment', { user_id: Number(p.user_id), telegram_payment_charge_id: arg });
        db.markRefunded(arg, plans[p.plan]?.days || 0);
        onPremium(p.user_id, db.user(p.user_id).premium_until);
        return reply(chatId, `Возвращено ${p.stars}⭐ пользователю ${p.user_id}`);
      }
    }
  }

  // Кнопка меню «Aura» открывает Mini App; вызывается и при смене адреса туннеля
  async function setMenu() {
    if (!site.url) return;
    await api('setChatMenuButton', { menu_button: { type: 'web_app', text: appName, web_app: { url: site.url } } })
      .then(() => console.log('menu button →', site.url))
      .catch(e => console.warn('menu button:', e.message));
  }

  // Имя, описания и команды на 17 языках (по умолчанию английский).
  // Отправляем, только если тексты изменились: 68 вызовов на каждый старт упираются в лимиты Telegram.
  async function applyProfile() {
    const hash = crypto.createHash('sha1').update(JSON.stringify(profile)).digest('hex');
    try { if (stateFile && fs.readFileSync(stateFile, 'utf8') === hash) return; } catch {}
    let failed = 0;
    for (const [lang, p] of Object.entries(profile)) {
      const language_code = lang === 'en' ? undefined : lang;
      const calls = [
        ['setMyName', { name: p.name }],
        ['setMyShortDescription', { short_description: p.short }],
        ['setMyDescription', { description: p.description }],
        ['setMyCommands', { commands: p.commands }],
      ];
      for (const [method, body] of calls) {
        const args = { ...body, ...(language_code && { language_code }) };
        for (let attempt = 0; attempt < 2; attempt++) {
          try { await api(method, args); break; }
          catch (e) {
            if (e.code === 429 && e.retryAfter && e.retryAfter <= 120 && attempt === 0) {
              await new Promise(r => setTimeout(r, (e.retryAfter + 1) * 1000));
              continue;
            }
            failed++;
            console.warn(`${method} (${lang}):`, e.message);
            break;
          }
        }
      }
    }
    console.log(`профиль бота: ${Object.keys(profile).length} языков${failed ? `, ошибок ${failed} — повторим при следующем старте` : ''}`);
    if (!failed && stateFile) { try { fs.writeFileSync(stateFile, hash); } catch {} }
  }

  async function start() {
    try {
      self.username = (await api('getMe')).username;
    } catch (e) { console.warn('getMe:', e.message); }
    await applyProfile();
    await setMenu();
    let offset = 0;
    for (;;) {
      try {
        const updates = await api('getUpdates', {
          offset, timeout: 50, allowed_updates: ['message', 'pre_checkout_query'],
        });
        for (const u of updates) {
          offset = u.update_id + 1;
          const job = u.pre_checkout_query ? onPreCheckout(u.pre_checkout_query) : u.message && onMessage(u.message);
          await Promise.resolve(job).catch(e => console.error('bot:', e.message));
        }
      } catch (e) {
        console.error('getUpdates:', e.message);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  return {
    start, createInvoiceLink, notify, remindEvent, setMenu,
    get username() { return self.username; },
  };
}
