import fs from 'node:fs';
import crypto from 'node:crypto';
import { botProfile, pickLang, note } from './bot-profile.js';

// Бот на long polling: /start, комнаты каналов, Aura Hour, оплата Telegram Stars, поддержка, админ-команды.
export function createBot({ token, site, stateFile, appName, adminIds, supportContact, plans, db, appLink, schedule, stats, kick, onPremium, onSalutes = () => {} }) {
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

  // «Позовите, когда соберутся»: в Aura сейчас много людей на языке подписчика
  async function notifyCrowd(users) {
    for (const { id, lang, n, spoken } of users) {
      const name = (() => { try { return new Intl.DisplayNames([lang || 'en'], { type: 'language' }).of(spoken); } catch { return spoken; } })();
      await notify(id, note(lang, 'crowd', { app: appName, n, lang: name }), appButton(note(lang, 'open')));
      await new Promise(r => setTimeout(r, 40));
    }
  }

  // Счёт на языке пользователя (язык Telegram сохраняется при входе)
  function createInvoiceLink(userId, planId) {
    const plan = plans[planId];
    if (!plan) throw new Error('unknown plan');
    const salute = plan.kind === 'salute';
    const lang = db.langOf(userId);
    const title = salute ? note(lang, 'plan_salutes', { n: plan.count }) : note(lang, plan.days >= 30 ? 'plan_month' : 'plan_week');
    return api('createInvoiceLink', {
      title: salute ? `${appName} · 🎆 ${title}` : `${appName} Premium · ${title}`,
      description: note(lang, salute ? 'inv_salute_desc' : 'inv_premium_desc'),
      payload: JSON.stringify({ u: userId, p: planId }),
      currency: 'XTR',
      prices: [{ label: title, amount: plan.stars }],
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
      : { pre_checkout_query_id: q.id, ok: false, error_message: note(q.from?.language_code, 'precheck_fail') });
  }

  async function onPaid(msg) {
    const sp = msg.successful_payment;
    const { u, p } = JSON.parse(sp.invoice_payload);
    const plan = plans[p];
    if (plan.kind === 'salute') {
      if (db.recordPayment({ chargeId: sp.telegram_payment_charge_id, userId: u, plan: p, stars: sp.total_amount })) {
        db.addSalutes(u, plan.count);
        db.event('salute_buy', u, sp.total_amount, p);
      }
      onSalutes(u);
      const lang = db.langOf(u);
      return reply(msg.chat.id, note(lang, 'salutes_bought', { n: plan.count }), appButton(note(lang, 'open')));
    }
    const until = db.addPayment({
      chargeId: sp.telegram_payment_charge_id, userId: u, plan: p, stars: sp.total_amount, days: plan.days,
    });
    onPremium(u, until);
    db.event('premium', u, sp.total_amount, p);
    const lang = db.langOf(u) || msg.from?.language_code;
    const date = new Date(until).toLocaleDateString(lang || 'en');
    await reply(msg.chat.id, note(lang, 'paid', { date }), appButton(note(lang, 'back')));
  }

  async function onMessage(msg) {
    if (msg.successful_payment) return onPaid(msg);
    const text = (msg.text || '').trim();
    const [cmd] = text.split(/\s+/);
    const arg = text.slice(cmd.length).trim();
    const chatId = msg.chat.id;
    const from = String(msg.from?.id || '');
    if (from && msg.chat.type === 'private') db.setAllowsPm(from);
    // Тексты команд — на языке Telegram пользователя
    const lang = msg.from?.language_code || db.langOf(from);
    const n = (key, vars) => note(lang, key, vars);

    switch (cmd.split('@')[0]) {
      case '/start': {
        // _tgr_… — ссылка партнёрской программы Telegram (комиссию начисляет сам Telegram)
        const param = /^(room_|ref_|inv_|duo_|ad_|src_|_tgr_|thread_)[\w-]{1,60}$|^wrapped$/.test(arg) ? arg : '';
        if (param.startsWith('ad_')) db.event('bot_start', from, 0, param);
        if (param.startsWith('src_')) db.event('bot_start', from, 0, param);
        if (param.startsWith('_tgr_')) db.event('bot_start', from, 0, 'affiliate');
        const p = profile[pickLang(msg.from?.language_code)];
        return reply(chatId, p.description, param ? linkButton(p.button, appLink(param)) : appButton(p.button));
      }
      case '/room': {
        if (!arg) return reply(chatId, n('room_help'));
        const room = db.createRoom(from, arg);
        const link = appLink(`room_${room.slug}`);
        return reply(chatId, n('room_created', { title: escape(room.title), link }), linkButton(n('room_open'), link));
      }
      case '/myrooms': {
        const rooms = db.roomsOf(from);
        if (!rooms.length) return reply(chatId, n('myrooms_empty'));
        return reply(chatId, rooms.map(r => n('myrooms_row', { title: escape(r.title), visits: r.visits, matches: r.matches, link: appLink(`room_${r.slug}`) })).join('\n\n'));
      }
      case '/events_off':
        db.setNotify(from, false);
        return reply(chatId, n('events_off'));
      case '/events_on':
        db.setNotify(from, true);
        return reply(chatId, n('events_on'));
      case '/invite': {
        const link = appLink(`ref_${db.refCode(from)}`);
        return reply(chatId, n('invite_msg', { link }),
          linkButton(n('share'), `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(n('invite_share', { app: appName }))}`));
      }
      case '/terms':
        return reply(chatId, n('terms', { site: site.url }));
      case '/paysupport':
      case '/support':
        return reply(chatId, n('support', { contact: supportContact }));
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
        const r = arg ? await refund(arg) : { error: 'not_found' };
        if (r.error) return reply(chatId, '/refund &lt;telegram_payment_charge_id&gt; — ' + (r.error === 'refunded' ? 'уже возвращён' : 'платёж не найден'));
        return reply(chatId, `Возвращено ${r.stars}⭐ пользователю ${r.userId}`);
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

  // Карточка для отправки в чат из Mini App (WebApp.shareMessage): фото + кнопка «Открыть Aura»
  async function prepareShare(userId, { photoUrl, caption, button, url }) {
    const r = await api('savePreparedInlineMessage', {
      user_id: Number(userId),
      result: {
        type: 'photo', id: crypto.randomBytes(8).toString('hex'),
        photo_url: photoUrl, thumbnail_url: photoUrl, caption: String(caption || '').slice(0, 1000),
        reply_markup: { inline_keyboard: [[{ text: button, url }]] },
      },
      allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true, allow_bot_chats: false,
    });
    return r.id;
  }

  // Возврат Stars: из команды /refund и из админ-панели
  async function refund(chargeId) {
    const p = db.payment(chargeId);
    if (!p) return { error: 'not_found' };
    if (p.refunded) return { error: 'refunded' };
    if (!p.charge_id.startsWith('dev-')) {
      await api('refundStarPayment', { user_id: Number(p.user_id), telegram_payment_charge_id: chargeId });
    }
    db.markRefunded(chargeId, plans[p.plan]?.days || 0);
    if (plans[p.plan]?.kind === 'salute') db.addSalutes(p.user_id, -Math.min(plans[p.plan].count, db.user(p.user_id).salutes));
    onPremium(p.user_id, db.user(p.user_id).premium_until);
    return { ok: true, userId: p.user_id, stars: p.stars };
  }

  // Недельные итоги (Aura Wrapped): короткая сводка + кнопка, открывающая карточку в приложении
  async function sendWrapped(users) {
    console.log(`Aura Wrapped: ${users.length} пользователям`);
    let sent = 0;
    for (const { id, lang } of users) {
      const w = db.wrapped(id);
      if (!w.chats) continue;
      const text = note(lang, 'wrapped', { app: appName, chats: w.chats, min: w.minutes, countries: w.countries.length });
      await notify(id, text, linkButton(note(lang, 'wrapped_btn'), appLink('wrapped')));
      sent++;
      await new Promise(r => setTimeout(r, 40));
    }
    return sent;
  }

  return {
    start, createInvoiceLink, notify, remindEvent, notifyCrowd, sendWrapped, setMenu, refund, prepareShare,
    get username() { return self.username; },
  };
}
