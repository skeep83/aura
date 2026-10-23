// «Нити»: то, что остаётся после случайного разговора. Карман (одна нить), карточка поверх видео,
// передача собеседнику, прилёт застрявшей нити в ожидании (точечная карта мира), финал с маршрутом и карточка для Stories.
// Сервер — хранитель состояния: сообщения thread_* (см. docs/architecture.md). Текст ходов приходит на языке читателя.
window.AuraThreads = {
  create({ send, toast, haptic, t, tn, LOCALE, flagOf, countryName, openSheet, closeSheet, openShare, drawQr, shortLink, requestPm,
    isTalking, getMe, appName, el }) {
    const $ = id => document.getElementById(id);
    const world = window.AuraWorld;
    const KIND = {
      story: { emoji: '📖', a: '#ffb547', b: '#f06b7a' },
      question: { emoji: '❓', a: '#36d1f0', b: '#4a86f7' },
      wish: { emoji: '💌', a: '#f36fb1', b: '#a26bff' },
    };
    let kinds = { story: { maxHops: 12, maxLen: 120 }, question: { maxHops: 20, maxLen: 80 }, wish: { maxHops: 10, maxLen: 100 } };
    let pocket = null;      // карточка нити в кармане
    let shown = null;       // карточка, показанная в звонке: { card, role, canTake }
    let seen = 0;           // сколько раз видел карточку (подсказки — первые три раза)
    let offer = null;       // нить, предложенная в ожидании
    let newsCode = null;    // нить из уведомления — открыть по тапу на 🧵
    let pendingOpen = null;

    const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const people = n => `${n} ${tn('people', n)}`;
    const countriesOf = n => `${n} ${tn('countries', n)}`;
    const kindName = k => t(`th_${k}`);
    const fromLine = card => card.from ? t('th_from', { flag: flagOf(card.from), country: countryName(card.from) }) : t('th_from_unknown');
    const setKindVars = (node, kind) => { node.style.setProperty('--th-a', KIND[kind]?.a || '#36d1f0'); node.style.setProperty('--th-b', KIND[kind]?.b || '#5a4ff0'); };

    // ---------- Нить как нить: кривая с узелками-флагами ----------
    function threadSvg(card, { width = 300, height = 46, max = 8 } = {}) {
      const ms = card.moves;
      const show = ms.length <= max ? ms : [ms[0], { skip: ms.length - (max - 1) }, ...ms.slice(-(max - 2))];
      const n = show.length;
      const step = n > 1 ? (width - 40) / (n - 1) : 0;
      const pts = show.map((m, i) => ({ x: 20 + i * step, y: height / 2 + (i % 2 ? 9 : -9), m }));
      // Пустые узлы до конца нити — пунктиром
      const left = Math.max(0, Math.min(card.maxHops - card.hops, 3));
      let d = '';
      pts.forEach((p, i) => {
        if (!i) { d += `M${p.x} ${p.y}`; return; }
        const q = pts[i - 1], cx = (q.x + p.x) / 2;
        d += ` C${cx} ${q.y} ${cx} ${p.y} ${p.x} ${p.y}`;
      });
      const last = pts.at(-1);
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${width + left * 16} ${height}`);
      svg.setAttribute('class', 'th-svg');
      const gid = 'thg' + Math.random().toString(36).slice(2, 7);
      svg.innerHTML = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${KIND[card.kind]?.a}"/><stop offset="1" stop-color="${KIND[card.kind]?.b}"/></linearGradient></defs>`
        + `<path d="${d}" fill="none" stroke="url(#${gid})" stroke-width="3" stroke-linecap="round" class="th-line"/>`
        + (left ? `<path d="M${last.x} ${last.y} L${last.x + left * 16} ${last.y}" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2" stroke-dasharray="3 5" stroke-linecap="round"/>` : '')
        + pts.map(p => p.m.skip
          ? `<circle cx="${p.x}" cy="${p.y}" r="9" fill="rgba(255,255,255,.18)"/><text x="${p.x}" y="${p.y + 3.5}" text-anchor="middle" font-size="9" font-weight="800" fill="#fff">+${p.m.skip}</text>`
          : `<circle cx="${p.x}" cy="${p.y}" r="${p.m.mine ? 11 : 9}" fill="${p.m.mine ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.22)'}" class="th-knot${p.m.mine ? ' me' : ''}"/>`
            + `<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-size="11">${p.m.country ? flagOf(p.m.country) : '·'}</text>`).join('');
      return svg;
    }

    // ---------- Карта мира на canvas: суша точками, маршрут нити светящейся линией ----------
    function worldPainter(canvas) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = canvas.clientWidth || 300, ch = canvas.clientHeight || 160;
      canvas.width = cw * dpr; canvas.height = ch * dpr;
      const x = canvas.getContext('2d');
      x.scale(dpr, dpr);
      const W = world.w, H = world.h, scale = Math.min(cw / W, ch / H), ox = (cw - W * scale) / 2, oy = (ch - H * scale) / 2;
      const bits = Uint8Array.from(atob(world.land), c => c.charCodeAt(0));
      const latBot = world.latTop - H * world.step;
      const proj = code => {
        const c = code && world.centers[code];
        if (!c) return null;
        return [ox + (c[1] + 180) / 360 * W * scale, oy + (world.latTop - c[0]) / (world.latTop - latBot) * H * scale];
      };
      function dots(alpha = .32) {
        x.clearRect(0, 0, cw, ch);
        x.fillStyle = `rgba(255,255,255,${alpha})`;
        const r = Math.max(.9, scale * .34);
        for (let i = 0; i < W * H; i++) {
          if (!((bits[i >> 3] >> (7 - (i & 7))) & 1)) continue;
          const col = i % W, row = (i / W) | 0;
          x.beginPath(); x.arc(ox + (col + .5) * scale, oy + (row + .5) * scale, r, 0, Math.PI * 2); x.fill();
        }
      }
      // Дуга между двумя точками, рисуется за ms миллисекунд; возвращает промис
      function arc(a, b, { ms = 1200, color = '#7cc4ff' } = {}) {
        return new Promise(resolve => {
          const mx = (a[0] + b[0]) / 2, my = Math.min(a[1], b[1]) - Math.max(18, Math.hypot(b[0] - a[0], b[1] - a[1]) * .35);
          const pt = u => [(1 - u) ** 2 * a[0] + 2 * (1 - u) * u * mx + u * u * b[0], (1 - u) ** 2 * a[1] + 2 * (1 - u) * u * my + u * u * b[1]];
          const t0 = performance.now();
          let last = 0;
          // Каждый кадр дорисовывается только новый отрезок: свечение не накапливается в пятно
          const frame = now => {
            const u = Math.min(1, (now - t0) / ms), e = 1 - (1 - u) ** 3;
            x.save(); x.strokeStyle = color; x.lineWidth = 2; x.lineCap = 'round'; x.shadowColor = color; x.shadowBlur = 8;
            x.beginPath(); x.moveTo(...pt(last));
            for (let i = 1; i <= 6; i++) { const [px, py] = pt(last + (e - last) * i / 6); x.lineTo(px, py); }
            x.stroke(); x.restore();
            last = e;
            if (u < 1) requestAnimationFrame(frame);
            else { const [hx, hy] = pt(1); x.save(); x.fillStyle = '#fff'; x.shadowColor = color; x.shadowBlur = 12; x.beginPath(); x.arc(hx, hy, 3, 0, Math.PI * 2); x.fill(); x.restore(); resolve(); }
          };
          requestAnimationFrame(frame);
        });
      }
      function knot(p, color = '#fff') {
        x.save(); x.fillStyle = color; x.shadowColor = color; x.shadowBlur = 16; x.beginPath(); x.arc(p[0], p[1], 4, 0, Math.PI * 2); x.fill(); x.restore();
      }
      const random = () => [ox + (0.2 + Math.random() * .6) * W * scale, oy + (0.25 + Math.random() * .4) * H * scale];
      return { dots, arc, knot, proj, random };
    }

    // ---------- Подсказки первые три раза ----------
    function hint(n) {
      if (seen >= 3) return '';
      const text = t(n === 'take' ? 'th_onboard_1' : 'th_onboard_2');
      return text;
    }
    function bumpSeen() { seen++; send({ t: 'thread_seen' }); }

    // ---------- Карман: значок на кнопке ----------
    function renderBadge() {
      const b = $('th-badge');
      if (pocket) { b.textContent = pocket.from ? flagOf(pocket.from) : '🧵'; b.hidden = false; b.classList.remove('news'); }
      else if (newsCode) { b.textContent = '✨'; b.hidden = false; b.classList.add('news'); }
      else b.hidden = true;
      $('thread-btn').classList.toggle('on', Boolean(pocket));
    }

    // ---------- Карточка в звонке ----------
    const cardEl = () => $('thread-card');
    function hideCard() {
      const c = cardEl();
      c.hidden = true; c.className = 'thread-card lg'; c.replaceChildren();
      el.chat.classList.remove('threading');
      shown = null;
    }
    function movesList(card, n = 3) {
      const list = mk('div', 'th-moves');
      for (const m of card.moves.slice(-n)) {
        const row = mk('div', 'th-move' + (m.mine ? ' mine' : ''));
        row.append(mk('i', null, m.country ? flagOf(m.country) : '·'));
        const txt = mk('span', null, m.hidden ? t('th_hidden') : m.text);
        if (m.hidden) txt.classList.add('hid');
        if (m.orig) {
          txt.classList.add('tr');
          txt.title = m.orig;
          txt.onclick = () => { const back = txt.dataset.o === '1'; txt.textContent = back ? m.text : m.orig; txt.dataset.o = back ? '0' : '1'; haptic('soft'); };
        }
        row.append(txt);
        list.append(row);
      }
      return list;
    }
    function header(card) {
      const h = mk('div', 'th-head');
      const k = mk('span', 'th-kind', `${KIND[card.kind]?.emoji || '🧵'} ${kindName(card.kind)}`);
      const meta = mk('small', null, `${people(card.hops)} · ${countriesOf(card.countries.length)}`);
      h.append(k, meta);
      return h;
    }
    function renderCard(card, role, canTake, reason) {
      const c = cardEl();
      c.replaceChildren();
      c.className = `thread-card lg ${card.kind} role-${role}`;
      setKindVars(c, card.kind);
      c.append(header(card));
      c.append(mk('b', 'th-from', fromLine(card)));
      c.append(threadSvg(card));
      c.append(movesList(card));
      c.append(mk('small', 'th-hop', t('th_hop', { n: card.hops, max: card.maxHops })));
      const h = role === 'peer' && canTake ? hint('take') : '';
      if (h) c.append(mk('p', 'th-hint', h));
      const row = mk('div', 'th-btns');
      if (role === 'peer') {
        if (canTake) {
          const go = mk('button', 'go', t('th_continue'));
          go.onclick = () => { haptic('medium'); renderCompose(card); };
          const no = mk('button', null, t('not_now'));
          no.onclick = () => { send({ t: 'thread_skip' }); hideCard(); };
          row.append(no, go);
        } else {
          c.append(mk('p', 'th-hint', t(reason === 'holding' ? 'th_me_holding' : 'th_me_already')));
          const ok = mk('button', null, t('th_hide'));
          ok.onclick = hideCard;
          row.append(ok);
        }
      } else {
        const hide = mk('button', null, t('th_hide'));
        hide.onclick = hideCard;
        row.append(hide);
      }
      c.append(row);
      c.hidden = false;
      el.chat.classList.add('threading');
      requestAnimationFrame(() => el.stage.style.setProperty('--th-h', `${c.offsetHeight}px`));
      shown = { card, role, canTake };
      if (role === 'peer' && canTake && seen < 3) bumpSeen();
    }
    // Ввод своего хода
    function renderCompose(card) {
      const c = cardEl();
      c.replaceChildren();
      c.append(header(card));
      c.append(movesList(card, 2));
      const label = mk('b', 'th-from', t(`th_write_${card.kind}`));
      c.append(label);
      const input = mk('input', 'th-input');
      input.maxLength = kinds[card.kind]?.maxLen || 120;
      input.placeholder = t(`th_ph_${card.kind}`);
      input.autocomplete = 'off';
      input.enterKeyHint = 'send';
      c.append(input);
      const counter = mk('small', 'th-count', `0 / ${input.maxLength}`);
      input.oninput = () => { counter.textContent = `${input.value.length} / ${input.maxLength}`; };
      c.append(counter);
      const row = mk('div', 'th-btns');
      const back = mk('button', null, t('not_now'));
      back.onclick = () => { send({ t: 'thread_skip' }); hideCard(); };
      const pass = mk('button', 'go', t('th_pass'));
      const submit = () => {
        const text = input.value.trim();
        if (text.length < 2) { input.focus(); return haptic('warning'); }
        pass.disabled = true;
        send({ t: 'thread_take', text });
      };
      pass.onclick = submit;
      input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
      row.append(back, pass);
      c.append(row);
      requestAnimationFrame(() => { el.stage.style.setProperty('--th-h', `${c.offsetHeight}px`); input.focus(); });
    }

    // Анимация передачи: у отдавшего карточка сжимается в нить и улетает к собеседнику, у получившего — прилетает в карман
    function flyAway() {
      const c = cardEl();
      if (c.hidden) return hideCard();
      c.classList.add('fly-away');
      setTimeout(hideCard, 650);
    }
    function flyIn(card) {
      const knot = mk('div', 'th-flyknot', card.from ? flagOf(card.last || card.from) : '🧵');
      setKindVars(knot, card.kind);
      el.stage.append(knot);
      const btn = $('thread-btn').getBoundingClientRect();
      requestAnimationFrame(() => {
        knot.style.transform = `translate(${btn.left + btn.width / 2 - window.innerWidth / 2}px, ${btn.top + btn.height / 2 - window.innerHeight * .4}px) scale(.35)`;
        knot.style.opacity = '0';
      });
      setTimeout(() => { knot.remove(); $('thread-btn').classList.add('pulse'); setTimeout(() => $('thread-btn').classList.remove('pulse'), 900); }, 750);
    }

    // ---------- Ожидание: карта и прилёт застрявшей нити ----------
    let painter = null;
    function paintWaiting() {
      const canvas = $('thread-map');
      if (!canvas || !world) return;
      canvas.hidden = false;
      painter = worldPainter(canvas);
      painter.dots();
    }
    function clearWaiting() {
      const canvas = $('thread-map');
      if (canvas) canvas.hidden = true;
      painter = null;
      $('thread-offer').hidden = true;
      offer = null;
    }
    async function showOffer(card) {
      offer = card;
      const box = $('thread-offer');
      box.hidden = true;
      if (painter) {
        const from = painter.proj(card.last || card.from) || painter.random();
        const to = painter.proj(getMe().country) || painter.random();
        painter.knot(from, KIND[card.kind]?.a);
        await painter.arc(from, to, { color: KIND[card.kind]?.a });
        painter.knot(to);
        if (offer !== card) return;
      }
      setKindVars(box, card.kind);
      $('th-offer-kind').textContent = `${KIND[card.kind]?.emoji || '🧵'} ${kindName(card.kind)}`;
      $('th-offer-title').textContent = card.from
        ? t('th_offer_title', { flag: flagOf(card.last || card.from), country: countryName(card.last || card.from) })
        : t('th_from_unknown');
      $('th-offer-sub').textContent = `${people(card.hops)} · ${countriesOf(card.countries.length)}`;
      $('th-offer-svg').replaceChildren(threadSvg(card, { max: 6 }));
      $('th-offer-hint').textContent = hint('take');
      $('th-offer-hint').hidden = !$('th-offer-hint').textContent;
      box.hidden = false;
      haptic('soft');
    }
    $('th-offer-yes').onclick = () => { if (!offer) return; haptic('medium'); send({ t: 'thread_accept', code: offer.code }); $('thread-offer').hidden = true; if (seen < 3) bumpSeen(); };
    $('th-offer-no').onclick = () => { $('thread-offer').hidden = true; offer = null; };

    // ---------- Начать свою нить ----------
    let startKind = 'story';
    function openStart() {
      if (pocket) { toast(t('th_holding_hint'), 3000); return openPage(pocket, { live: false }); }
      renderStart();
      openSheet('sheet-thread');
    }
    function renderStart() {
      for (const b of document.querySelectorAll('#th-kinds button')) {
        b.classList.toggle('on', b.dataset.k === startKind);
        b.onclick = () => { startKind = b.dataset.k; renderStart(); haptic('soft'); };
      }
      const input = $('th-text');
      input.maxLength = kinds[startKind]?.maxLen || 120;
      input.placeholder = t(`th_ph_${startKind}`);
      $('th-start-hint').textContent = t(`th_${startKind}_sub`);
      $('th-count').textContent = `${input.value.length} / ${input.maxLength}`;
      $('th-start-sub').textContent = t('th_limit_sub', { max: kinds[startKind]?.maxHops || 12 });
    }
    $('th-text').oninput = () => { $('th-count').textContent = `${$('th-text').value.length} / ${$('th-text').maxLength}`; };
    $('th-start').onclick = () => {
      const text = $('th-text').value.trim();
      if (text.length < 2) { $('th-text').focus(); return haptic('warning'); }
      requestPm?.();
      send({ t: 'thread_start', kind: startKind, text });
      $('th-start').disabled = true;
      setTimeout(() => { $('th-start').disabled = false; }, 1500);
    };

    // ---------- Финал и страница нити: маршрут по карте, ходы по одному, сборка, штамп ----------
    let pageRun = 0;
    const wait = (ms, run) => new Promise(r => { const tick = () => r(); const id = setTimeout(tick, ms); tapWaiters.push({ r, id, run }); });
    let tapWaiters = [];
    function skipWait() { const w = tapWaiters.splice(0); for (const x of w) { clearTimeout(x.id); x.r(); } }
    function closePage() { pageRun++; skipWait(); const o = $('thread-final'); o.hidden = true; o.replaceChildren(); }
    async function openPage(card, { live = false, closer = false } = {}) {
      const run = ++pageRun;
      const o = $('thread-final');
      o.replaceChildren();
      setKindVars(o, card.kind);
      o.hidden = false;
      const done = card.status === 'done';
      const canvas = mk('canvas', 'thf-map');
      const cap = mk('div', 'thf-cap');
      const body = mk('div', 'thf-body');
      const tapHint = mk('small', 'thf-tap', t('th_tap'));
      const close = mk('button', 'thf-close', '✕');
      close.onclick = closePage;
      o.append(close, mk('div', 'thf-title', done ? (live ? t('th_final_title') : t('th_final_title_view')) : fromLine(card)), canvas, cap, tapHint, body);
      o.onclick = e => { if (!e.target.closest('button, .thf-body')) skipWait(); };
      const p = worldPainter(canvas);
      p.dots(.28);
      await wait(350, run);
      if (run !== pageRun) return;
      // Маршрут: от страны к стране, на каждом узелке — ход на языке читателя
      let prev = null;
      for (const m of card.moves) {
        if (run !== pageRun) return;
        const pt = p.proj(m.country);
        if (pt && prev && (prev[0] !== pt[0] || prev[1] !== pt[1])) await p.arc(prev, pt, { ms: 900, color: KIND[card.kind]?.a });
        if (pt) { p.knot(pt, m.mine ? '#fff' : KIND[card.kind]?.b); prev = pt; }
        cap.replaceChildren();
        const row = mk('div', 'thf-move' + (m.mine ? ' mine' : ''));
        row.append(mk('i', null, m.country ? flagOf(m.country) : '·'));
        const col = mk('div');
        col.append(mk('small', null, `${m.n}. ${m.country ? countryName(m.country) : ''}${m.mine ? ` · ${t('th_you')}` : ''}`));
        col.append(mk('span', m.hidden ? 'hid' : '', m.hidden ? t('th_hidden') : m.text));
        row.append(col);
        cap.append(row);
        if (card.moves.length <= 6 || m.n <= 2 || m.n > card.moves.length - 3 || m.mine) await wait(1500, run);
        else await wait(650, run);
      }
      if (run !== pageRun) return;
      tapHint.hidden = true;
      cap.classList.add('fade');
      // Сборка по типу
      body.replaceChildren();
      const texts = card.moves.filter(m => !m.hidden).map(m => m.text);
      if (card.kind === 'story') {
        body.append(mk('h3', null, card.title || t('th_story_default', { code: card.code.toUpperCase() })));
        body.append(mk('p', 'thf-story', texts.join(' ')));
      } else if (card.kind === 'question') {
        body.append(mk('h3', null, texts[0] || ''));
        body.append(mk('small', 'thf-sub', t('th_answers', { n: Math.max(0, texts.length - 1) })));
        const cloud = mk('div', 'thf-cloud');
        card.moves.slice(1).filter(m => !m.hidden).forEach((m, i) => { const chip = mk('span', m.mine ? 'mine' : '', `${m.country ? flagOf(m.country) + ' ' : ''}${m.text}`); chip.style.animationDelay = `${i * 70}ms`; cloud.append(chip); });
        body.append(cloud);
      } else {
        body.append(mk('h3', null, t('th_wish_card', { n: texts.length })));
        const post = mk('div', 'thf-post');
        card.moves.filter(m => !m.hidden).forEach((m, i) => { const line = mk('p', m.mine ? 'mine' : '', `${m.country ? flagOf(m.country) + ' ' : ''}${m.text}`); line.style.animationDelay = `${i * 90}ms`; post.append(line); });
        body.append(post);
      }
      // Штамп
      const stamp = mk('div', 'thf-stamp');
      stamp.append(mk('b', null, done
        ? t('th_stamp', { hops: card.hops, people: tn('people', card.hops), countries: card.countries.length, cw: tn('countries', card.countries.length), days: card.days, daysWord: tn('days', card.days) })
        : t('th_progress', { hops: card.hops, max: card.maxHops })));
      if (card.myHop) stamp.append(mk('small', null, `${t('th_you_were', { n: card.myHop })}${closer ? ` · ${t('th_closed_by_you')}` : ''}`));
      stamp.append(mk('span', 'thf-flags', card.countries.map(flagOf).join(' ')));
      body.append(stamp);
      const btns = mk('div', 'thf-btns');
      if (done) {
        const story = mk('button', 'go', t('share_story'));
        story.onclick = () => shareCard(card).catch(() => toast(t('story_fail')));
        btns.append(story);
      }
      const link = mk('button', null, t('th_share_link'));
      link.onclick = () => shareLink(card);
      btns.append(link);
      if (done && !pocket) {
        const own = mk('button', null, t('th_start_own'));
        own.onclick = () => { closePage(); openStart(); };
        btns.append(own);
      }
      const cl = mk('button', null, t('close'));
      cl.onclick = closePage;
      btns.append(cl);
      body.append(btns);
      body.classList.add('in');
      if (live) haptic('success');
    }
    function threadLink(card) {
      const me = getMe();
      const base = (me.refLink || '').replace(/\?startapp=.*$/, '');
      return base ? `${base}?startapp=thread_${card.code}` : `https://t.me/you_aura_bot/app?startapp=thread_${card.code}`;
    }
    function shareLink(card) {
      const url = threadLink(card);
      const text = `🧵 ${t('th_share_text', { hops: card.hops, countries: card.countries.length })}`;
      const tg = window.Telegram?.WebApp;
      if (tg?.openTelegramLink) tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
      else navigator.clipboard?.writeText(url).then(() => toast(t('th_link_copied')), () => toast(url, 5000));
      haptic();
    }

    // ---------- Карточка 1080×1920 для Stories ----------
    async function shareCard(card) {
      const c = document.createElement('canvas');
      c.width = 1080; c.height = 1920;
      const x = c.getContext('2d');
      const k = KIND[card.kind] || KIND.question;
      const g = x.createLinearGradient(0, 0, 1080, 1920);
      g.addColorStop(0, k.a); g.addColorStop(1, k.b);
      x.fillStyle = g; x.fillRect(0, 0, 1080, 1920);
      for (const [cx, cy, r, a] of [[930, 220, 380, .14], [80, 1700, 460, .12]]) { x.fillStyle = `rgba(255,255,255,${a})`; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill(); }
      x.fillStyle = '#fff'; x.textAlign = 'center';
      x.font = '800 60px Montserrat, sans-serif';
      x.fillText(`${appName().toUpperCase()} · ${t('th_card_title')}`, 540, 170);
      x.font = '700 40px Montserrat, sans-serif';
      x.fillText(`${k.emoji} ${kindName(card.kind)}`, 540, 250);
      // Нить через всю карточку с флагами стран
      const flags = card.countries.slice(0, 12);
      const n = flags.length, x0 = 120, x1 = 960, step = n > 1 ? (x1 - x0) / (n - 1) : 0;
      x.save(); x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = 10; x.lineCap = 'round'; x.shadowColor = 'rgba(0,0,0,.25)'; x.shadowBlur = 24;
      x.beginPath();
      flags.forEach((_, i) => { const px = x0 + i * step, py = 560 + (i % 2 ? 70 : -70); if (!i) x.moveTo(px, py); else { const qx = x0 + (i - 1) * step, qy = 560 + ((i - 1) % 2 ? 70 : -70), cx = (qx + px) / 2; x.bezierCurveTo(cx, qy, cx, py, px, py); } });
      x.stroke(); x.restore();
      x.font = '72px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      flags.forEach((f, i) => { const px = x0 + i * step, py = 560 + (i % 2 ? 70 : -70); x.fillStyle = 'rgba(255,255,255,.95)'; x.beginPath(); x.arc(px, py, 58, 0, Math.PI * 2); x.fill(); x.fillText(flagOf(f), px, py + 26); });
      x.fillStyle = '#fff';
      x.font = '800 150px Montserrat, sans-serif';
      x.fillText(String(card.hops), 540, 900);
      x.font = '700 44px Montserrat, sans-serif';
      x.fillText(`${tn('people', card.hops)} · ${countriesOf(card.countries.length)} · ${card.days} ${tn('days', card.days)}`, 540, 965);
      if (card.myHop) { x.font = '600 40px Montserrat, sans-serif'; x.fillText(t('th_you_were', { n: card.myHop }), 540, 1035); }
      // Фрагмент: заголовок истории / вопрос / первое пожелание
      const texts = card.moves.filter(m => !m.hidden).map(m => m.text);
      const quote = card.kind === 'story' ? (card.title || texts[0] || '') : texts[0] || '';
      x.font = 'italic 600 44px Montserrat, sans-serif';
      wrapText(x, `«${quote}»`, 540, 1180, 880, 58, 4);
      // Низ: QR и ссылка
      x.fillStyle = 'rgba(255,255,255,.96)'; x.beginPath(); x.roundRect(60, 1745, 150, 150, 22); x.fill();
      drawQr(x, threadLink(card), 72, 1757, 126);
      x.fillStyle = '#fff'; x.textAlign = 'left';
      x.font = '800 38px Montserrat, sans-serif'; x.fillText(t('story_join'), 240, 1805);
      x.font = '600 30px Montserrat, sans-serif'; x.fillText(shortLink(), 240, 1855);
      x.textAlign = 'right'; x.fillText(new Date().toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }), 1020, 1855);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      openShare(blob, `🧵 ${t('th_share_text', { hops: card.hops, countries: card.countries.length })}`);
    }
    function wrapText(x, text, cx, y, maxW, lh, maxLines) {
      const words = text.split(' '); const lines = []; let line = '';
      for (const w of words) { const test = line ? `${line} ${w}` : w; if (x.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test; }
      if (line) lines.push(line);
      if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '…'); }
      lines.forEach((l, i) => x.fillText(l, cx, y + i * lh));
    }

    // ---------- Кнопка 🧵 ----------
    function tap() {
      haptic();
      if (newsCode && !isTalking()) { pendingOpen = newsCode; newsCode = null; renderBadge(); return send({ t: 'thread_page', code: pendingOpen }); }
      if (isTalking()) {
        if (pocket) return send({ t: 'thread_show' });
        return openStart();
      }
      if (pocket) return openPage(pocket, { live: false });
      openStart();
    }

    // ---------- Сообщения сервера ----------
    function setup(ready) {
      kinds = ready.threadKinds || kinds;
      seen = ready.threadsSeen || 0;
      pocket = ready.thread || null;
      renderBadge();
      if (ready.openThread) { pendingOpen = ready.openThread; send({ t: 'thread_page', code: ready.openThread }); }
    }
    function onMessage(msg) {
      switch (msg.t) {
        case 'thread_pocket':
          pocket = msg.card;
          renderBadge();
          closeSheet();
          if (msg.started) { toast(t('th_started'), 2600); $('th-text').value = ''; }
          else if (msg.card) { toast(t('th_received'), 3000); flyIn(msg.card); }
          break;
        case 'thread_card':
          renderCard(msg.card, msg.role, msg.canTake, msg.reason);
          if (msg.role === 'peer') haptic('medium');
          break;
        case 'thread_received':
          pocket = msg.card;
          hideCard();
          flyIn(msg.card);
          renderBadge();
          toast(t('th_received'), 3200);
          if (seen < 3) toast(t('th_onboard_2'), 4500);
          haptic('success');
          break;
        case 'thread_passed':
          pocket = null;
          flyAway();
          renderBadge();
          toast(t('th_passed', { n: msg.card.myHop }), 3200);
          break;
        case 'thread_declined':
          hideCard();
          toast(t('th_declined'));
          break;
        case 'thread_final':
          pocket = null;
          hideCard();
          renderBadge();
          openPage(msg.card, { live: true, closer: msg.closer });
          break;
        case 'thread_offer':
          if (!pocket) showOffer(msg.card);
          break;
        case 'thread_page':
          if (!msg.card) { toast(t('th_gone')); break; }
          if (msg.card.canAccept && !pocket) { offer = msg.card; showOffer(msg.card); }
          else openPage(msg.card, { live: false });
          break;
        case 'thread_news':
          newsCode = msg.code;
          renderBadge();
          toast(msg.kind === 'done'
            ? t('th_news_done', { n: msg.n, hops: msg.hops, countries: msg.countries })
            : t('th_news_milestone', { flag: flagOf(msg.country), hops: msg.hops, countries: msg.countries }), 5000);
          haptic('success');
          break;
        case 'thread_error':
          toast(t({ empty: 'th_empty', limit: 'th_limit', only_call: 'th_only_call', holding: 'th_holding_hint', already: 'th_already', gone: 'th_gone', text: 'th_text_short' }[msg.code] || 'th_gone'), 3500);
          if (msg.code === 'gone' || msg.code === 'already') hideCard();
          break;
      }
    }
    function onCallEnd() { hideCard(); }
    function onOverlay(mode) {
      if (mode === 'waiting') { if (!painter) paintWaiting(); }
      else clearWaiting();
    }

    return { setup, onMessage, onCallEnd, onOverlay, tap, closePage };
  },
};
