// Aura Admin: одностраничная панель. Данные — через свой сервер (/api/* → продакшен /api/admin/*).
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Number(n || 0).toLocaleString('ru-RU');
  const flag = c => /^[A-Z]{2}$/.test(c || '') ? String.fromCodePoint(...[...c].map(x => 0x1F1E6 + x.charCodeAt(0) - 65)) : '🏳️';
  const regions = (() => { try { return new Intl.DisplayNames(['ru'], { type: 'region' }); } catch { return null; } })();
  const country = c => { try { return c ? regions?.of(c) || c : '—'; } catch { return c; } };
  const FOREVER = 8.64e15;
  const ago = t => {
    if (!t) return '—';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'только что';
    if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
    if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
    return `${Math.floor(s / 86400)} дн назад`;
  };
  const date = t => t ? new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const until = t => !t || t < Date.now() ? '' : t >= FOREVER / 2 ? 'навсегда' : `до ${date(t)}`;
  const gender = g => ({ m: '👨', f: '👩' }[g] || '·');

  function toast(text, bad = false) {
    const t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.textContent = text;
    $('toasts').append(t);
    setTimeout(() => t.remove(), 3500);
  }

  async function api(path, opts = {}) {
    const res = await fetch('/api/' + path, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json', 'x-aura-admin': '1' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { showLogin(); throw new Error('login'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.status);
    return data;
  }

  // ---------- Тема ----------
  const theme = localStorage.getItem('adminTheme') || 'dark';
  document.documentElement.dataset.theme = theme;
  $('theme-btn').onclick = () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    localStorage.setItem('adminTheme', t);
    if (state.series) drawCharts(state.series);
  };

  // ---------- Вход ----------
  function showLogin(hint) {
    $('app').hidden = true;
    $('login').hidden = false;
    if (hint) $('login-hint').textContent = hint;
    $('password').focus();
  }
  $('login-form').onsubmit = async e => {
    e.preventDefault();
    $('login-error').hidden = true;
    const res = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { $('password').value = ''; start(); return; }
    $('login-error').hidden = false;
    $('login-error').textContent = data.error === 'locked' ? `Слишком много попыток. Подождите ${data.retryAfterSec} с.`
      : data.error === 'no_password' ? 'Пароль ещё не задан — запустите set_admin_password.py' : 'Неверный пароль';
  };
  $('logout-btn').onclick = async () => { await fetch('/auth/logout', { method: 'POST' }); showLogin(); };

  // ---------- Навигация ----------
  const TITLES = { overview: 'Обзор', users: 'Пользователи', reports: 'Жалобы', payments: 'Платежи', moderation: 'Модерация', rooms: 'Комнаты', ai: 'ИИ', system: 'Система' };
  const state = { page: 'overview', days: 30, series: null, overview: null, users: { q: '', filter: '', sort: 'recent', offset: 0, limit: 50 } };
  function go(page) {
    state.page = page;
    for (const a of $('nav').children) a.classList.toggle('on', a.dataset.page === page);
    for (const s of document.querySelectorAll('.page')) s.hidden = s.id !== 'page-' + page;
    $('page-title').textContent = TITLES[page];
    location.hash = page;
    load();
  }
  $('nav').onclick = e => { const p = e.target.closest('[data-page]')?.dataset.page; if (p) go(p); };
  $('refresh-btn').onclick = () => load();

  async function load() {
    try {
      const loader = { overview: loadOverview, users: loadUsers, reports: loadReports, payments: loadPayments, moderation: loadModeration, rooms: loadRooms, ai: loadAI, system: loadSystem }[state.page];
      await loader();
      $('updated').textContent = 'обновлено ' + new Date().toLocaleTimeString('ru-RU');
    } catch (e) { if (e.message !== 'login') toast('Ошибка: ' + e.message, true); }
  }

  // ---------- Обзор ----------
  function kpi(label, value, sub = '', hot = false) {
    return `<div class="kpi${hot ? ' hot' : ''}"><small>${esc(label)}</small><b>${esc(value)}</b><span>${esc(sub)}</span></div>`;
  }
  async function loadOverview() {
    const [o, s] = await Promise.all([api('overview'), api(`series?days=${state.days}`)]);
    state.overview = o; state.series = s;
    const L = o.live, f = o.funnel, T = o.totals;
    $('side-online').textContent = fmt(L.online);
    $('kpis').innerHTML = [
      kpi('Онлайн сейчас', fmt(L.online), `в разговоре ${fmt(L.talking)} · в очереди ${fmt(L.waiting)}`, true),
      kpi('DAU / WAU / MAU', `${fmt(f.dau)}`, `${fmt(o.wau)} за неделю · ${fmt(o.mau)} за месяц`),
      kpi('Новые за сутки', fmt(f.newUsers), `всего ${fmt(T.users)}`),
      kpi('Разговоров за сутки', fmt(f.matches), `медиана ${f.callMedianSec} с · до пары ${f.ttmMedianSec} с`),
      kpi('Не соединилось', `${f.connFailPct}%`, o.system.turn ? 'TURN включён' : 'TURN выключен'),
      kpi('Доход', `${fmt(T.stars)} ⭐`, `за сутки ${fmt(f.stars)} ⭐ · Premium ${fmt(T.premium)}`),
      kpi('Удержание D1', f.d1, `вайбов ${fmt(f.vibeMatches)}`),
      kpi('Безопасность', `${fmt(f.reports)}`, `жалоб · NSFW ${f.nsfwStrikes} · возраст ${f.ageBlocks} · бан ${T.banned}`),
    ].join('');
    $('nav-reports').hidden = !f.reports;
    $('nav-reports').textContent = f.reports;
    const funnel = [['Сессии (DAU)', f.dau], ['Разговоров', f.matches], ['До собеседника, медиана', `${f.ttmMedianSec} с`], ['Длительность, медиана', `${f.callMedianSec} с`],
      ['«Далее» в первые 5 с', `${f.quickSkipPct}%`], ['Вайбы / взаимные', `${f.vibes} / ${f.vibeMatches}`], ['Покупок Premium', f.premiumBuys], ['Откуда пришли', f.sources]];
    $('funnel').innerHTML = funnel.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
    const V = o.viral;
    const viral = [['🎯 Угадали страну', V.guess_ok], ['💌 Комплименты', V.compliment], ['🎆 Салюты отправлено', V.salute], ['🎆 Покупок салютов', V.salute_buy],
      ['👫 Duo создано', V.duo_create], ['👫 Звонков Duo', V.duo_call], ['✨ Взаимных вайбов', Math.round(V.vibe_match / 2)]];
    $('viral').innerHTML = viral.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmt(v)}</td></tr>`).join('');
    const bars = (rows, label, key = 'n') => {
      const max = Math.max(1, ...rows.map(r => r[key]));
      return `<div class="bars">${rows.map(r => `<div class="bar"><span>${label(r)}</span><i style="width:${(100 * r[key] / max).toFixed(1)}%"></i><em>${fmt(r[key])}</em></div>`).join('') || '<span class="muted">нет данных</span>'}</div>`;
    };
    $('audience').innerHTML = '<h3>Страны</h3>' + bars(o.countries.slice(0, 8), r => `${flag(r.country)} ${esc(r.country)}`)
      + '<h3>Языки Telegram</h3>' + bars(o.langs.slice(0, 6), r => esc(r.lang))
      + '<h3>Пол</h3>' + bars(o.genders, r => ({ m: '👨 Парни', f: '👩 Девушки', x: '· не указан' }[r.gender] || r.gender));
    drawCharts(s);
  }

  $('range-seg').onclick = e => {
    const d = e.target.closest('[data-d]')?.dataset.d;
    if (!d) return;
    state.days = Number(d);
    for (const b of $('range-seg').children) b.classList.toggle('on', b.dataset.d === d);
    loadOverview();
  };

  // Простые SVG-графики: линии и столбики, ось X — даты
  function chart(el, rows, series, { bars = false } = {}) {
    const W = el.clientWidth || 500, H = el.clientHeight || 200, P = { l: 34, r: 34, t: 10, b: 22 };
    const n = rows.length, iw = W - P.l - P.r, ih = H - P.t - P.b;
    const x = i => P.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
    const scales = {};
    for (const s of series) {
      const axis = s.axis || 'left';
      scales[axis] = Math.max(scales[axis] || 1, ...rows.map(r => r[s.key] || 0));
    }
    const y = (v, axis = 'left') => P.t + ih - (ih * v) / (scales[axis] * 1.1);
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><g class="grid">`;
    for (let k = 0; k <= 4; k++) { const yy = P.t + (ih * k) / 4; svg += `<line x1="${P.l}" x2="${W - P.r}" y1="${yy}" y2="${yy}"/>`; }
    svg += '</g><g class="ax">';
    for (const [axis, max] of Object.entries(scales)) {
      const xx = axis === 'left' ? P.l - 6 : W - P.r + 6;
      svg += `<text x="${xx}" y="${P.t + 8}" text-anchor="${axis === 'left' ? 'end' : 'start'}">${fmt(Math.round(max * 1.1))}</text>`;
    }
    const step = Math.max(1, Math.ceil(n / 7));
    rows.forEach((r, i) => { if (i % step === 0 || i === n - 1) svg += `<text x="${x(i)}" y="${H - 4}" text-anchor="middle">${r.day.slice(5).replace('-', '.')}</text>`; });
    svg += '</g>';
    for (const s of series) {
      const col = getComputedStyle(document.documentElement).getPropertyValue(s.color).trim();
      if (bars || s.bars) {
        const bw = Math.max(2, iw / n * 0.6);
        rows.forEach((r, i) => { const v = r[s.key] || 0; const yy = y(v, s.axis); svg += `<rect x="${x(i) - bw / 2}" y="${yy}" width="${bw}" height="${P.t + ih - yy}" rx="3" fill="${col}" opacity=".85"><title>${r.day}: ${fmt(v)}</title></rect>`; });
      } else {
        const pts = rows.map((r, i) => `${x(i)},${y(r[s.key] || 0, s.axis)}`);
        svg += `<polygon points="${P.l},${P.t + ih} ${pts.join(' ')} ${x(n - 1)},${P.t + ih}" fill="${col}" opacity=".10"/>`;
        svg += `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
        rows.forEach((r, i) => { svg += `<circle cx="${x(i)}" cy="${y(r[s.key] || 0, s.axis)}" r="${n > 40 ? 0 : 2.5}" fill="${col}"><title>${r.day}: ${fmt(r[s.key])}</title></circle>`; });
      }
    }
    el.innerHTML = svg + '</svg>';
  }
  function drawCharts(rows) {
    const q = rows.map(r => ({ ...r, failPct: r.connOk + r.connFail ? Math.round(100 * r.connFail / (r.connOk + r.connFail)) : 0 }));
    chart($('chart-users'), rows, [{ key: 'dau', color: '--c1' }, { key: 'newUsers', color: '--c2' }]);
    chart($('chart-talk'), rows, [{ key: 'matches', color: '--c1', bars: true }, { key: 'talkMin', color: '--c3', axis: 'right' }]);
    chart($('chart-stars'), rows, [{ key: 'stars', color: '--c5' }], { bars: true });
    chart($('chart-quality'), q, [{ key: 'failPct', color: '--c4' }, { key: 'reports', color: '--c5', axis: 'right', bars: true }]);
  }
  window.addEventListener('resize', () => { if (state.page === 'overview' && state.series) drawCharts(state.series); });

  // ---------- Пользователи ----------
  function userRow(u) {
    const initial = esc((u.name || u.username || '?').trim().slice(0, 1).toUpperCase() || '?');
    const tags = [
      u.premiumUntil > Date.now() ? '<span class="tag gold">👑 Premium</span>' : '',
      u.bannedUntil > Date.now() ? `<span class="tag bad">⛔ ${esc(u.banReason || 'бан')}</span>` : '',
      u.reports ? `<span class="tag warn">⚑ ${u.reports}</span>` : '',
    ].join(' ');
    return `<tr class="click" data-id="${esc(u.id)}">
      <td><div class="who"><span class="ava${u.online ? ' on' : ''}">${initial}</span><div><b>${esc(u.name || '—')}</b><small>${u.username ? '@' + esc(u.username) : esc(u.id)}</small></div></div></td>
      <td>${flag(u.country)} ${gender(u.gender)}</td>
      <td class="num">✨ ${fmt(u.aura)}</td>
      <td>${tags}</td>
      <td class="muted">${ago(u.lastSeen)}</td>
      <td class="muted">${date(u.createdAt)}</td>
    </tr>`;
  }
  async function loadUsers() {
    const U = state.users;
    const p = new URLSearchParams({ q: U.q, filter: U.filter, sort: U.sort, limit: U.limit, offset: U.offset });
    const d = await api('users?' + p);
    $('users-table').innerHTML = `<thead><tr><th>Пользователь</th><th>Откуда</th><th class="num">Аура</th><th>Статус</th><th>Заходил</th><th>Регистрация</th></tr></thead>
      <tbody>${d.users.map(userRow).join('') || '<tr><td colspan="6" class="empty">Никого не найдено</td></tr>'}</tbody>`;
    $('page-info').textContent = d.total ? `${U.offset + 1}–${Math.min(U.offset + U.limit, d.total)} из ${fmt(d.total)}` : '0';
    $('prev').disabled = U.offset === 0;
    $('next').disabled = U.offset + U.limit >= d.total;
  }
  let searchTimer;
  $('user-q').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.users.q = $('user-q').value.trim(); state.users.offset = 0; loadUsers(); }, 300); };
  $('user-filter').onclick = e => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    state.users.filter = b.dataset.f; state.users.offset = 0;
    for (const x of $('user-filter').children) x.classList.toggle('on', x === b);
    loadUsers();
  };
  $('user-sort').onchange = () => { state.users.sort = $('user-sort').value; state.users.offset = 0; loadUsers(); };
  $('prev').onclick = () => { state.users.offset = Math.max(0, state.users.offset - state.users.limit); loadUsers(); };
  $('next').onclick = () => { state.users.offset += state.users.limit; loadUsers(); };
  document.addEventListener('click', e => {
    const row = e.target.closest('tr[data-id]');
    if (row && !e.target.closest('button')) openUser(row.dataset.id);
  });

  // ---------- Карточка пользователя ----------
  const EVENT_NAMES = { session: 'вход', match: 'разговор', call_end: 'конец разговора', talk: 'время в разговоре', vibe: 'вайб', vibe_match: 'взаимный вайб', report: 'пожаловался',
    conn_ok: 'соединение ок', conn_fail: 'соединение не удалось', nsfw: 'NSFW', age_block: 'блок по возрасту', premium: 'купил Premium', guess_ok: 'угадал страну',
    compliment: 'комплимент', salute: 'салют', salute_buy: 'купил салюты', duo_create: 'создал Duo', duo_join: 'вошёл в Duo', admin_ban: 'бан (админ)', admin_unban: 'разбан (админ)',
    admin_premium: 'Premium (админ)', admin_salutes: 'салюты (админ)', admin_aura: 'аура (админ)', admin_message: 'сообщение (админ)', admin_clear_reports: 'жалобы сброшены' };
  const COMPL = { smile: '😊 Улыбка', funny: '😂 Смешно', smart: '🧠 Умно', kind: '💛 Добрый', voice: '🎙️ Голос', world: '🌍 Интересно' };
  let current = null;
  async function openUser(id) {
    const d = await api('users/' + encodeURIComponent(id));
    current = d;
    const u = d.user;
    const banned = u.bannedUntil > Date.now();
    const premium = u.premiumUntil > Date.now();
    $('drawer-body').innerHTML = `
      <div class="who"><span class="ava${u.online ? ' on' : ''}" style="width:48px;height:48px;font-size:20px">${esc((u.name || '?').slice(0, 1).toUpperCase())}</span>
        <div><h2>${esc(u.name || '—')}</h2><small class="muted">${u.username ? '@' + esc(u.username) + ' · ' : ''}ID ${esc(u.id)}</small></div></div>
      <div class="tags">
        ${u.online ? '<span class="tag ok">● онлайн</span>' : `<span class="tag">заходил ${ago(u.lastSeen)}</span>`}
        <span class="tag">${flag(u.country)} ${esc(country(u.country))}</span>
        <span class="tag">${gender(u.gender)} ищет: ${esc({ any: 'всех', m: 'парней', f: 'девушек' }[u.want] || u.want)}</span>
        <span class="tag">🗣 ${esc(u.langs.join(', ') || u.lang || '—')}</span>
        ${premium ? `<span class="tag gold">👑 Premium ${until(u.premiumUntil)}</span>` : ''}
        ${banned ? `<span class="tag bad">⛔ ${esc(u.banReason || 'бан')} ${until(u.bannedUntil)}</span>` : ''}
        ${u.reveal ? '<span class="tag">🎧 сначала голос</span>' : ''}
        ${u.allowsPm ? '<span class="tag">✉️ бот может писать</span>' : ''}
      </div>
      <div class="stats">
        <div><b>${fmt(u.aura)}</b><small>аура</small></div>
        <div><b>${fmt(d.wrapped.chats)}</b><small>разговоров 7д</small></div>
        <div><b>${fmt(u.salutes)}/${fmt(u.salutesReceived)}</b><small>салюты есть/получ.</small></div>
        <div><b>${fmt(u.referrals)}</b><small>рефералов</small></div>
      </div>

      <section><h3>Действия</h3>
        <div class="actions">
          ${banned ? '<button class="btn ok sm" data-act="unban">Разбанить</button>'
            : '<button class="btn danger sm" data-ban="1">Бан 1 ч</button><button class="btn danger sm" data-ban="24">Бан 24 ч</button><button class="btn danger sm" data-ban="168">Бан 7 дн</button><button class="btn danger sm" data-ban="forever">Навсегда</button>'}
          ${u.online ? '<button class="btn ghost sm" data-act="kick">Отключить сейчас</button>' : ''}
          ${u.reports ? '<button class="btn ghost sm" data-act="clear_reports">Сбросить жалобы</button>' : ''}
          <button class="btn ghost sm" data-act="ai_review">✨ ИИ-разбор</button>
        </div>
        <div id="ai-review"></div>
        <div class="act-row"><span class="muted small">Premium:</span>
          <button class="btn ghost sm" data-prem="1">+1 день</button><button class="btn ghost sm" data-prem="7">+7</button><button class="btn ghost sm" data-prem="30">+30</button></div>
        <div class="act-row"><span class="muted small">Салюты:</span>
          <button class="btn ghost sm" data-sal="5">+5</button><button class="btn ghost sm" data-sal="20">+20</button><button class="btn ghost sm" data-sal="-5">−5</button>
          <span class="muted small" style="margin-left:10px">Аура:</span>
          <button class="btn ghost sm" data-aura="50">+50</button><button class="btn ghost sm" data-aura="-50">−50</button></div>
        <div class="act-row" style="flex-direction:column;align-items:stretch">
          <textarea id="msg-text" placeholder="Сообщение от бота этому пользователю…" maxlength="1000"></textarea>
          <button class="btn primary sm" data-act="message" style="align-self:flex-start"${u.allowsPm ? '' : ' title="Пользователь мог не разрешить сообщения от бота"'}>Отправить через бота</button>
        </div>
      </section>

      <section><h3>Паспорт · ${d.passport.length}</h3><div class="flags">${d.passport.map(p => `<span title="${esc(country(p.country))} · ${date(p.at)}">${flag(p.country)}</span>`).join('') || '<span class="muted small">пусто</span>'}</div></section>
      <section><h3>Комплименты</h3><div class="tags">${Object.entries(d.compliments).map(([k, n]) => `<span class="tag">${COMPL[k] || k} · ${n}</span>`).join('') || '<span class="muted small">пока нет</span>'}</div></section>
      <section><h3>Жалобы на него · ${d.reportsAgainst.length}</h3>
        <div class="timeline">${d.reportsAgainst.map(r => `<div><b>${esc(r.reason)}</b><span>от ${esc(r.reporter)} · ${date(r.at)}</span></div>`).join('') || '<span class="muted small">нет</span>'}</div></section>
      <section><h3>Платежи</h3>
        <div class="timeline">${d.payments.map(p => `<div><b>${esc(p.plan)} · ${p.stars} ⭐${p.refunded ? ' (возврат)' : ''}</b><span>${date(p.at)}</span></div>`).join('') || '<span class="muted small">нет</span>'}</div></section>
      <section><h3>Последние события</h3>
        <div class="timeline">${d.events.map(e => `<div><b>${esc(EVENT_NAMES[e.type] || e.type)}${e.tag ? ' · ' + esc(e.tag) : ''}</b><span>${date(e.at)}</span></div>`).join('') || '<span class="muted small">нет</span>'}</div></section>
      <p class="muted small">Регистрация ${date(u.createdAt)}${u.referredBy ? ' · пришёл по ссылке ' + esc(u.referredBy) : ''} · страйков NSFW: ${u.strikes}</p>`;
    $('scrim').hidden = $('drawer').hidden = false;
  }
  function closeDrawer() { $('scrim').hidden = $('drawer').hidden = true; current = null; }
  $('scrim').onclick = closeDrawer;
  $('drawer-close').onclick = closeDrawer;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

  async function act(action, body = {}, confirmText) {
    if (!current) return;
    if (confirmText && !confirm(confirmText)) return;
    const id = current.user.id;
    try {
      await api(`users/${encodeURIComponent(id)}/${action}`, { method: 'POST', body });
      toast('Готово');
      await openUser(id);
      if (state.page !== 'overview') load();
    } catch (e) { if (e.message !== 'login') toast('Не получилось: ' + e.message, true); }
  }
  $('drawer').onclick = e => {
    const b = e.target.closest('button');
    if (!b || !current) return;
    const name = current.user.name || current.user.id;
    if (b.dataset.ban) {
      const reason = prompt(`Причина бана для ${name}:`, 'нарушение правил');
      if (reason !== null) act('ban', { hours: b.dataset.ban, reason });
    } else if (b.dataset.prem) act('premium', { days: Number(b.dataset.prem), notify: true });
    else if (b.dataset.sal) act('salutes', { n: Number(b.dataset.sal) });
    else if (b.dataset.aura) act('aura', { n: Number(b.dataset.aura) });
    else if (b.dataset.act === 'message') {
      const text = $('msg-text').value.trim();
      if (text) act('message', { text }, `Отправить сообщение ${name}?`);
    } else if (b.dataset.act === 'unban') act('unban');
    else if (b.dataset.act === 'kick') act('kick', {}, `Отключить ${name} от текущего разговора?`);
    else if (b.dataset.act === 'ai_review') aiReview(current.user.id, b);
    else if (b.dataset.act === 'clear_reports') act('clear_reports', {}, 'Удалить все жалобы на этого пользователя?');
  };

  async function aiReview(id, btn) {
    const box = $('ai-review');
    btn.disabled = true;
    box.className = 'ai-review';
    box.textContent = 'ИИ изучает историю пользователя…';
    try { box.textContent = (await api(`ai/user/${encodeURIComponent(id)}`, { method: 'POST', body: {} })).answer; }
    catch (e) { box.textContent = e.message === 'ai_off' ? 'ИИ выключен — включите его в разделе «ИИ».' : 'Не получилось: ' + e.message; }
    btn.disabled = false;
  }

  // ---------- ИИ ----------
  let aiCfg = null;
  async function loadAI() {
    aiCfg = await api('ai');
    const c = aiCfg;
    $('ai-enabled').checked = c.enabled;
    $('ai-enabled-label').textContent = c.enabled ? 'Включён' : 'Выключен';
    $('ai-preset').innerHTML = Object.entries(c.presets).map(([k, p]) => `<option value="${esc(k)}"${k === c.preset ? ' selected' : ''}>${esc(p.label)}</option>`).join('');
    $('ai-base').value = c.baseUrl;
    $('ai-model').value = c.model;
    $('ai-key').value = '';
    $('ai-key-state').textContent = c.keySet ? `Ключ сохранён (${c.keyHint}). Хранится только на сервере.` : 'Ключ не задан.';
    $('ai-limit').value = c.dailyLimit;
    $('ai-features').innerHTML = Object.entries(c.featureNames).map(([k, label]) =>
      `<label><input type="checkbox" data-f="${esc(k)}"${c.features[k] !== false ? ' checked' : ''}><span>${esc(label)}</span></label>`).join('');
    const u = c.usage;
    $('ai-usage').innerHTML = [['Запросов', `${fmt(u.requests)} из ${fmt(c.dailyLimit)}`], ['Токенов вход/выход', `${fmt(u.tokensIn)} / ${fmt(u.tokensOut)}`], ['Ошибок', fmt(u.errors)],
      ...Object.entries(u.byFeature || {}).map(([k, n]) => [`· ${k}`, fmt(n)]), ['Последняя ошибка', esc(u.lastError || '—')]]
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  }
  $('ai-enabled').onchange = () => { $('ai-enabled-label').textContent = $('ai-enabled').checked ? 'Включён' : 'Выключен'; };
  $('ai-preset').onchange = () => {
    const p = aiCfg?.presets[$('ai-preset').value];
    if (!p) return;
    if (p.baseUrl) $('ai-base').value = p.baseUrl;
    if (p.model) $('ai-model').value = p.model;
  };
  $('ai-form').onsubmit = async e => {
    e.preventDefault();
    const preset = $('ai-preset').value;
    const features = Object.fromEntries([...document.querySelectorAll('#ai-features [data-f]')].map(i => [i.dataset.f, i.checked]));
    try {
      await api('ai', { method: 'POST', body: {
        enabled: $('ai-enabled').checked, preset, kind: aiCfg.presets[preset]?.kind || 'openai',
        baseUrl: $('ai-base').value.trim(), model: $('ai-model').value.trim(), apiKey: $('ai-key').value, dailyLimit: Number($('ai-limit').value), features,
      } });
      toast('Настройки ИИ сохранены');
      loadAI();
    } catch (err) { toast('Не сохранилось: ' + err.message, true); }
  };
  $('ai-test').onclick = async () => {
    $('ai-test-result').textContent = 'Проверяем…';
    try { const r = await api('ai/test', { method: 'POST', body: {} }); $('ai-test-result').textContent = `✅ Работает: ${r.model}, ответ за ${r.ms} мс`; }
    catch (err) { $('ai-test-result').textContent = '❌ ' + err.message; }
    loadAI();
  };
  $('ai-clear-key').onclick = async () => {
    if (!confirm('Удалить сохранённый API-ключ? ИИ-функции перестанут работать.')) return;
    await api('ai', { method: 'POST', body: { clearKey: true, enabled: false } });
    toast('Ключ удалён'); loadAI();
  };
  async function askAI(q) {
    if (!q) return;
    const chat = $('ai-chat');
    const qa = document.createElement('div'); qa.className = 'q'; qa.textContent = q;
    const an = document.createElement('div'); an.className = 'a busy'; an.textContent = 'Думаю над данными…';
    chat.append(qa, an);
    chat.scrollTop = chat.scrollHeight;
    try { an.textContent = (await api('ai/ask', { method: 'POST', body: { question: q } })).answer; }
    catch (e) { an.textContent = e.message === 'ai_off' ? 'ИИ выключен или не задан ключ — настройте провайдера слева.' : 'Ошибка: ' + e.message; }
    an.classList.remove('busy');
    chat.scrollTop = chat.scrollHeight;
  }
  $('ai-ask').onsubmit = e => { e.preventDefault(); const q = $('ai-question').value.trim(); $('ai-question').value = ''; askAI(q); };
  $('ai-suggest').onclick = e => { const q = e.target.closest('[data-q]')?.dataset.q; if (q) askAI(q); };

  // ---------- Жалобы ----------
  const REASONS = { nudity: '🔞 18+', minor: '🧒 Несовершеннолетний', abuse: '🤬 Оскорбления', spam: '📢 Спам', other: 'Другое' };
  async function loadReports() {
    const d = await api('reports');
    $('report-reasons').innerHTML = d.byReason.map(r => `<span class="tag">${REASONS[r.reason] || esc(r.reason)} · ${r.n}</span>`).join('');
    $('reports-table').innerHTML = `<thead><tr><th>На кого</th><th>Причина</th><th class="num">Всего жалоб</th><th>Статус</th><th>От кого</th><th>Когда</th></tr></thead><tbody>${
      d.reports.map(r => `<tr class="click" data-id="${esc(r.target)}">
        <td><div class="who"><span class="ava">${esc((r.targetName || '?').slice(0, 1).toUpperCase())}</span><div><b>${esc(r.targetName || '—')}</b><small>${r.targetUsername ? '@' + esc(r.targetUsername) : esc(r.target)}</small></div></div></td>
        <td>${REASONS[r.reason] || esc(r.reason)}</td><td class="num">${r.targetReports}</td>
        <td>${r.targetBannedUntil > Date.now() ? '<span class="tag bad">в бане</span>' : '<span class="tag">активен</span>'}</td>
        <td class="muted">${esc(r.reporter)}</td><td class="muted">${date(r.at)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Жалоб нет 🎉</td></tr>'}</tbody>`;
  }

  // ---------- Платежи ----------
  const PLANS = { week: 'Premium 7 дн', month: 'Premium 30 дн', salute5: '🎆 ×5', salute20: '🎆 ×20' };
  async function loadPayments() {
    const d = await api('payments');
    $('pay-kpis').innerHTML = kpi('Всего', `${fmt(d.total.stars)} ⭐`, `${fmt(d.total.n)} платежей`, true)
      + d.byPlan.map(p => kpi(PLANS[p.plan] || p.plan, `${fmt(p.stars)} ⭐`, `${fmt(p.n)} покупок`)).join('');
    $('payments-table').innerHTML = `<thead><tr><th>Покупатель</th><th>Что</th><th class="num">⭐</th><th>Когда</th><th></th></tr></thead><tbody>${
      d.payments.map(p => `<tr>
        <td><div class="who"><span class="ava">${esc((p.name || '?').slice(0, 1).toUpperCase())}</span><div><b>${esc(p.name || '—')}</b><small>${p.username ? '@' + esc(p.username) : esc(p.userId)}</small></div></div></td>
        <td>${esc(PLANS[p.plan] || p.plan)}</td><td class="num">${fmt(p.stars)}</td><td class="muted">${date(p.at)}</td>
        <td>${p.refunded ? '<span class="tag">возвращён</span>' : `<button class="btn ghost sm" data-refund="${esc(p.chargeId)}" data-stars="${p.stars}">Вернуть</button>`}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">Платежей пока нет</td></tr>'}</tbody>`;
  }
  $('payments-table').onclick = async e => {
    const b = e.target.closest('[data-refund]');
    if (!b || !confirm(`Вернуть ${b.dataset.stars} ⭐ покупателю? Premium/салюты из этой покупки будут сняты.`)) return;
    b.disabled = true;
    try { await api(`payments/${encodeURIComponent(b.dataset.refund)}/refund`, { method: 'POST', body: {} }); toast('Звёзды возвращены'); loadPayments(); }
    catch (err) { b.disabled = false; toast('Возврат не прошёл: ' + err.message, true); }
  };

  // ---------- Модерация ----------
  const MOD = { nsfw: '🔞 NSFW', age_block: '🧒 Возраст', report: '⚑ Жалоба', admin_ban: '⛔ Бан админом', admin_unban: '✅ Разбан' };
  async function loadModeration() {
    const d = await api('moderation');
    $('mod-events').innerHTML = `<thead><tr><th>Событие</th><th>Кто</th><th>Детали</th><th>Когда</th></tr></thead><tbody>${
      d.events.map(e => `<tr class="click" data-id="${esc(e.userId)}"><td>${MOD[e.type] || esc(e.type)}</td>
        <td>${esc(e.name || e.userId)}</td><td class="muted">${e.type === 'nsfw' || e.type === 'age_block' ? 'оценка ' + Number(e.value).toFixed(2) : esc(e.tag)}</td><td class="muted">${date(e.at)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">Событий нет</td></tr>'}</tbody>`;
    $('mod-banned').innerHTML = `<thead><tr><th>Кто</th><th>Причина</th><th>Срок</th></tr></thead><tbody>${
      d.banned.map(u => `<tr class="click" data-id="${esc(u.id)}"><td>${esc(u.name || u.id)}${u.username ? ' <small class="muted">@' + esc(u.username) + '</small>' : ''}</td>
        <td>${esc(u.reason || '—')}</td><td class="muted">${until(u.bannedUntil)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Никто не забанен</td></tr>'}</tbody>`;
  }

  // ---------- Комнаты ----------
  async function loadRooms() {
    const rooms = await api('rooms');
    $('rooms-table').innerHTML = `<thead><tr><th>Комната</th><th>Владелец</th><th class="num">Заходов</th><th class="num">Разговоров</th><th>Создана</th></tr></thead><tbody>${
      rooms.map(r => `<tr class="click" data-id="${esc(r.ownerId)}"><td><b>${esc(r.title)}</b> <small class="muted">${esc(r.slug)}</small></td>
        <td>${r.ownerUsername ? '@' + esc(r.ownerUsername) : esc(r.ownerId)}</td><td class="num">${fmt(r.visits)}</td><td class="num">${fmt(r.matches)}</td><td class="muted">${date(r.createdAt)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="empty">Комнат пока нет — их создают командой /room в боте</td></tr>'}</tbody>`;
  }

  // ---------- Система ----------
  async function loadSystem() {
    const [o, c] = await Promise.all([api('overview'), api('config')]);
    const S = o.system;
    const yes = v => v ? '<span class="tag ok">включено</span>' : '<span class="tag bad">выключено</span>';
    const h = Math.floor(S.uptimeSec / 3600), m = Math.floor(S.uptimeSec % 3600 / 60);
    $('sys-status').innerHTML = [
      ['Адрес', `<a href="${esc(S.publicUrl)}" target="_blank" rel="noopener">${esc(S.publicUrl)}</a>`], ['Бот', yes(S.bot)], ['Модерация', yes(S.moderation)], ['TURN', yes(S.turn)],
      ['Работает', `${h} ч ${m} мин`], ['Память', `${S.memMb} МБ`], ['Node.js', esc(S.node)], ['Версия', esc(S.version || '—')],
      ['Aura Hour', o.live.event?.active ? '<span class="tag ok">идёт сейчас</span>' : esc(o.live.event?.time || '—')],
      ['Duo сейчас', `${o.live.duos || 0} (в звонке ${o.live.duoInCall || 0})`],
    ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    const NAMES = { appName: 'Название', publicUrl: 'Адрес', tzOffset: 'Часовой пояс, UTC+', freeFilterPerDay: 'Бесплатный фильтр в день', referralDays: 'Premium за друга, дней',
      streakRewardEvery: 'Награда за серию каждые, дней', rateMinSeconds: 'Оценка после разговора от, с', nsfwThreshold: 'Порог NSFW', minorThreshold: 'Порог возраста',
      ageBlockHours: 'Блок по возрасту, ч', frameIntervalMs: 'Кадр на модерацию, мс', strikesToBan: 'Страйков до бана', strikeBanHours: 'Бан за страйки, ч',
      reportsToBan: 'Жалоб до бана', adminIds: 'Админы в боте', supportContact: 'Поддержка' };
    $('sys-config').innerHTML = Object.entries(c).map(([k, v]) => `<tr><td>${esc(NAMES[k] || k)}</td><td>${esc(Array.isArray(v) ? v.join(', ') : v)}</td></tr>`).join('');
  }

  // ---------- Старт ----------
  let timer;
  async function start() {
    const me = await fetch('/auth/me').then(r => r.json()).catch(() => ({}));
    if (!me.password) return showLogin('Пароль ещё не задан: запустите set_admin_password.py на сервере');
    if (!me.authed) return showLogin();
    $('login').hidden = true;
    $('app').hidden = false;
    const page = location.hash.slice(1);
    go(TITLES[page] ? page : 'overview');
    clearInterval(timer);
    // Обзор обновляется сам каждые 15 с, остальное — по кнопке
    timer = setInterval(() => { if (state.page === 'overview' && !document.hidden && $('drawer').hidden) load(); }, 15_000);
  }
  start();
})();
