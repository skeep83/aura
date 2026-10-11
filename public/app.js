(() => {
  const tg = window.Telegram?.WebApp;
  // Тема: выбор пользователя (auto | light | dark), в режиме auto — как в Telegram или системе
  const themePref = () => { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } };
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)');
  function resolvedTheme() {
    const pref = themePref();
    if (pref !== 'auto') return pref;
    if (tg?.colorScheme) return tg.colorScheme;
    return systemDark?.matches ? 'dark' : 'light';
  }
  function applyTheme() {
    const theme = resolvedTheme();
    document.documentElement.dataset.theme = theme;
    for (const b of document.querySelectorAll('#theme-seg button')) b.classList.toggle('on', b.dataset.v === themePref());
    for (const t of document.querySelectorAll('.theme-toggle use')) t.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', bg);
    tg?.setHeaderColor?.(bg);
    tg?.setBackgroundColor?.(bg);
    tg?.setBottomBarColor?.(bg);
  }
  if (tg) {
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.();
    tg.onEvent?.('themeChanged', applyTheme);
  }
  systemDark?.addEventListener?.('change', applyTheme);
  function setTheme(pref) {
    try { localStorage.setItem('theme', pref); } catch {}
    document.documentElement.classList.add('theming');
    applyTheme();
    setTimeout(() => document.documentElement.classList.remove('theming'), 400);
  }
  applyTheme();
  document.querySelector('#theme-seg').onclick = e => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (v) { setTheme(v); tg?.HapticFeedback?.selectionChanged?.(); }
  };
  for (const btn of document.querySelectorAll('.theme-toggle')) {
    btn.onclick = () => { setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark'); tg?.HapticFeedback?.impactOccurred?.('light'); };
  }

  const $ = id => document.getElementById(id);
  const { t, tn } = window.AuraI18n;
  const LOCALE = window.AuraI18n.lang;
  window.AuraI18n.apply();
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  const haptic = (kind = 'light') => {
    const h = tg?.HapticFeedback;
    if (!h) return;
    if (['success', 'warning', 'error'].includes(kind)) h.notificationOccurred(kind);
    else h.impactOccurred(kind);
  };

  const el = {
    remote: $('remote'), local: $('local'), selfBg: $('self-bg'), pip: $('pip'), stage: $('stage'),
    searching: $('searching'), searchTitle: $('search-title'), searchSub: $('search-sub'), resume: $('resume'),
    next: $('next-btn'), mic: $('mic-btn'), chatBtn: $('chat-btn'), composer: $('composer'),
    input: $('chat-input'), messages: $('messages'), peerChip: $('peer-chip'), premiumBtn: $('premium-btn'),
  };

  // ---------- Состояние ----------
  let ws = null;
  let ice = [];
  let me = { gender: 'x', want: 'any', premium: false, premiumUntil: 0 };
  let plans = {};
  let paymentsOn = false;
  let moderation = null;
  let localStream = null;
  let pc = null;
  let pendingCandidates = [];
  let state = 'onboard'; // onboard | idle | waiting | connecting | talking | banned
  let connectTimer = null;
  let frameTimer = null;
  let facing = 'user';
  let reconnectDelay = 1000;
  let online = 0;
  let selectedPlan = 'month';
  let appName = 'Aura';
  let eventInfo = null;      // { active, startsAt, endsAt, roundMs, time }
  let matchedAt = 0;         // когда начался текущий разговор (для таймера раунда)
  let peerInfo = null;       // { gender, langs } текущего собеседника
  let emojiStatusId = null;
  let freePerDay = 10;
  let maskOn = store.get('maskDefault') === '1';

  // Языки: флаг и самоназвание
  const LANG_META = {
    ru: ['🇷🇺', 'Русский'], en: ['🇬🇧', 'English'], uk: ['🇺🇦', 'Українська'], kk: ['🇰🇿', 'Қазақша'],
    uz: ['🇺🇿', 'Oʻzbek'], be: ['🇧🇾', 'Беларуская'], es: ['🇪🇸', 'Español'], de: ['🇩🇪', 'Deutsch'],
    fr: ['🇫🇷', 'Français'], it: ['🇮🇹', 'Italiano'], pt: ['🇧🇷', 'Português'], tr: ['🇹🇷', 'Türkçe'],
    pl: ['🇵🇱', 'Polski'], ar: ['🇸🇦', 'العربية'], hi: ['🇮🇳', 'हिन्दी'], zh: ['🇨🇳', '中文'],
    id: ['🇮🇩', 'Indonesia'], fa: ['🇮🇷', 'فارسی'], vi: ['🇻🇳', 'Tiếng Việt'],
  };

  const send = msg => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const showScreen = id => {
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  };

  function toast(text, ms = 2600) {
    const t = document.createElement('div');
    t.className = 'toast lg';
    t.textContent = text;
    $('toasts').append(t);
    setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 400); }, ms);
  }

  const fmtOnline = n => n.toLocaleString(LOCALE);
  function setOnline(n) {
    online = n;
    $('online').textContent = fmtOnline(n);
    $('online-onboard').textContent = fmtOnline(n);
    if (state === 'waiting') el.searchSub.textContent = t('search_sub', { n: fmtOnline(n) });
  }

  // Оверлей поиска: waiting | connecting | idle | null (скрыт, идёт разговор)
  function setOverlay(mode) {
    $('chat').classList.toggle('idle', Boolean(mode));
    el.searching.classList.toggle('gone', !mode);
    el.searching.classList.toggle('paused', mode === 'idle');
    el.searching.classList.toggle('connecting', mode === 'connecting');
    el.resume.hidden = mode !== 'idle';
    if (mode === 'waiting') {
      el.searchTitle.textContent = t(me.want === 'f' ? 'search_f' : me.want === 'm' ? 'search_m' : 'search_any');
      el.searchSub.textContent = t('search_sub', { n: fmtOnline(online) });
    } else if (mode === 'connecting') {
      el.searchTitle.textContent = t('connecting');
      el.searchSub.textContent = t('one_sec');
    } else if (mode === 'idle') {
      el.searchTitle.textContent = t('paused');
      el.searchSub.textContent = t('invisible');
    }
  }

  // ---------- Камера ----------
  async function startCamera() {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 960 }, frameRate: { ideal: 24, max: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    el.local.srcObject = localStream;
    el.selfBg.srcObject = localStream; // своя камера в размытии на фоне поиска
  }

  async function flipCamera() {
    const want = facing === 'user' ? 'environment' : 'user';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: want } });
      const track = s.getVideoTracks()[0];
      const old = localStream.getVideoTracks()[0];
      localStream.removeTrack(old);
      old.stop();
      localStream.addTrack(track);
      el.local.srcObject = localStream;
      el.selfBg.srcObject = localStream;
      el.local.play().catch(() => {});
      el.selfBg.play().catch(() => {});
      facing = want;
      el.pip.classList.toggle('rear', facing === 'environment');
      if (!maskOn) await pc?.getSenders().find(x => x.track?.kind === 'video' || x.track === null)?.replaceTrack(track);
      haptic();
    } catch {
      toast(t('no_second_cam'));
    }
  }

  // ---------- Модерация: раз в N секунд маленький кадр своей камеры на сервер ----------
  const frameCanvas = document.createElement('canvas');
  function sendFrame() {
    const v = el.selfBg; // всегда настоящая камера, даже в режиме маски
    if (state !== 'talking' || !v.videoWidth) return;
    const w = 256, h = Math.round(w * v.videoHeight / v.videoWidth);
    frameCanvas.width = w; frameCanvas.height = h;
    frameCanvas.getContext('2d').drawImage(v, 0, 0, w, h);
    const jpg = frameCanvas.toDataURL('image/jpeg', 0.7).split(',')[1];
    send({ t: 'frame', jpg });
  }
  function startFrames() {
    clearInterval(frameTimer);
    if (!moderation) return;
    setTimeout(sendFrame, 1200);
    frameTimer = setInterval(sendFrame, moderation.intervalMs);
  }

  // ---------- WebRTC ----------
  function closePeer() {
    clearTimeout(connectTimer);
    clearInterval(frameTimer);
    pendingCandidates = [];
    if (pc) {
      pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
      pc.close();
      pc = null;
    }
    el.remote.srcObject = null;
    el.peerChip.hidden = true;
    clearMessages();
    games.reset();
    $('vibe-btn').classList.remove('on');
    peerInfo = null;
    matchedAt = 0;
    stopReveal();
  }

  async function startPeer(initiator, peer, reveal = false) {
    closePeer();
    state = 'connecting';
    setOverlay('connecting');
    el.remote.classList.remove('out');
    el.remote.classList.add('veil');
    peerInfo = peer || null;
    matchedAt = Date.now();
    $('rate').hidden = true;
    pc = new RTCPeerConnection({ iceServers: ice });
    for (const t of localStream.getTracks()) {
      pc.addTrack(t.kind === 'video' && maskOn ? mask.track : t, localStream);
    }

    pc.ontrack = e => {
      if (el.remote.srcObject !== e.streams[0]) el.remote.srcObject = e.streams[0];
      el.remote.play().catch(() => {});
    };
    pc.onicecandidate = e => { if (e.candidate) send({ t: 'signal', data: { candidate: e.candidate } }); };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected' && state !== 'talking') {
        clearTimeout(connectTimer);
        reportConn(true, 'connected');
        state = 'talking';
        setOverlay(null);
        if (reveal) startReveal(peer);
        else setTimeout(() => el.remote.classList.remove('veil'), 1500); // первые секунды размыто — как в Azar
        haptic('medium');
        const who = peer?.gender === 'f' ? t('peer_f') : peer?.gender === 'm' ? t('peer_m') : '';
        const lang = (peer?.langs || []).map(l => LANG_META[l]?.[0]).filter(Boolean).join(' ');
        const where = peer?.country ? `${flagOf(peer.country)} ${countryName(peer.country)}` : '';
        if (who || lang || where) {
          el.peerChip.textContent = [where, who, lang].filter(Boolean).join(' · ');
          el.peerChip.hidden = false;
          setTimeout(() => { el.peerChip.hidden = true; }, 4000);
        }
        if (maskOn) send({ t: 'game', data: { g: 'mask', on: true } });
        startFrames();
      } else if (pc.connectionState === 'failed') {
        reportConn(false, 'failed').finally(next);
      }
    };
    connectTimer = setTimeout(() => { if (state === 'connecting') reportConn(false, 'timeout').finally(next); }, 15_000);

    if (initiator) {
      await pc.setLocalDescription(await pc.createOffer());
      send({ t: 'signal', data: { sdp: pc.localDescription } });
    }
  }

  // Обезличенная диагностика соединения: только итог и типы маршрутов (host/srflx/relay), без IP-адресов
  async function reportConn(ok, why) {
    const p = pc;
    if (!p) return;
    try {
      const stats = await p.getStats();
      const types = { local: new Set(), remote: new Set() };
      let chosen = '';
      const byId = new Map();
      stats.forEach(s => byId.set(s.id, s));
      stats.forEach(s => {
        if (s.type === 'local-candidate') types.local.add(s.candidateType);
        if (s.type === 'remote-candidate') types.remote.add(s.candidateType);
        if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') {
          chosen = `${byId.get(s.localCandidateId)?.candidateType}>${byId.get(s.remoteCandidateId)?.candidateType}`;
        }
      });
      send({ t: 'conn', ok, why, chosen, local: [...types.local].join(','), remote: [...types.remote].join(','), turn: ice.some(s => String(s.urls).includes('turn')) });
    } catch {}
  }

  async function onSignal(data) {
    if (!pc) return;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          send({ t: 'signal', data: { sdp: pc.localDescription } });
        }
        for (const c of pendingCandidates) await pc.addIceCandidate(c);
        pendingCandidates = [];
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else pendingCandidates.push(data.candidate);
      }
    } catch (e) { console.warn('signal', e); }
  }

  // ---------- Сервер ----------
  // Только для локальной отладки без Telegram: своя «личность» у каждой вкладки
  function devId() {
    let id = null;
    try { id = sessionStorage.getItem('devId'); } catch {}
    if (!id) {
      id = 'dev-' + Math.random().toString(36).slice(2, 10);
      try { sessionStorage.setItem('devId', id); } catch {}
    }
    return id;
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => send({
      t: 'auth', initData: tg?.initData || '',
      ...(tg?.initData ? {} : { devId: devId(), startParam: new URLSearchParams(location.search).get('startapp') || '' }),
    });
    ws.onmessage = e => handle(JSON.parse(e.data));
    ws.onclose = ev => {
      closePeer();
      if (ev.code === 4004 || state === 'banned') return;
      if (ev.code === 4003) { toast(t('open_via_bot'), 6000); return; }
      if (ev.code === 4005 && ev.reason === 'replaced') {
        state = 'idle';
        setOverlay('idle');
        el.searchTitle.textContent = t('other_window');
        el.searchSub.textContent = t('tap_continue');
        return;
      }
      if (state === 'talking' || state === 'connecting') { state = 'waiting'; setOverlay('waiting'); }
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
    };
  }

  function handle(msg) {
    switch (msg.t) {
      case 'ready':
        reconnectDelay = 1000;
        ice = msg.ice;
        plans = msg.plans;
        paymentsOn = msg.payments;
        moderation = msg.moderation;
        appName = msg.appName || appName;
        emojiStatusId = msg.emojiStatusId;
        freePerDay = msg.freeFilterPerDay ?? freePerDay;
        window.AuraI18n.setApp(appName);
        setMe(msg.me);
        setOnline(msg.online);
        setEvent(msg.event);
        setRoom(msg.room);
        if (msg.referred) toast(t('referred'), 4000);
        setupExtras();
        if (state === 'waiting' || state === 'connecting' || state === 'talking') send({ t: 'find' });
        break;
      case 'me': setMe(msg.me); break;
      case 'online': setOnline(msg.n); break;
      case 'waiting':
        if (state !== 'idle') { closePeer(); state = 'waiting'; setOverlay('waiting'); }
        break;
      case 'matched': startPeer(msg.initiator, msg.peer, msg.reveal); break;
      case 'stamp':
        me.passport = [...new Set([...(me.passport || []), msg.country])];
        renderPassportPill();
        toast(t('stamp_new', { flag: flagOf(msg.country), name: countryName(msg.country), n: msg.total, countries: tn('countries', msg.total) }), 3500);
        haptic('success');
        break;
      case 'signal': onSignal(msg.data); break;
      case 'chat': addMessage(msg.text, 'them'); haptic('soft'); break;
      case 'peer_left':
        closePeer();
        state = 'waiting';
        setOverlay('waiting');
        if (msg.reason === 'moderation') toast(t('moderated_peer'));
        break;
      case 'stopped':
        closePeer();
        state = 'idle';
        setOverlay('idle');
        break;
      case 'warning':
        closePeer();
        state = 'idle';
        setOverlay('idle');
        $('warning-text').textContent =
          t('warn_text', { n: msg.strikes, max: msg.max });
        openSheet('sheet-warning');
        haptic('warning');
        break;
      case 'reported':
        toast(t('reported'));
        haptic('success');
        break;
      case 'invoice':
        if (msg.dev) { toast('DEV: Premium выдан без оплаты'); closeSheet(); break; }
        tg?.openInvoice?.(msg.url, status => {
          if (status === 'paid') { closeSheet(); toast(t('premium_on')); haptic('success'); }
          else if (status === 'failed') toast(t('pay_failed'));
        });
        break;
      case 'error': toast(msg.code ? t(msg.code) : msg.text); break;
      case 'streak':
        toast(t('streak', { n: msg.streak, days: tn('days', msg.streak) }), 3000);
        if (msg.reward) setTimeout(() => toast(t('streak_reward'), 3500), 1200);
        haptic('success');
        break;
      case 'referral':
        toast(t('referral'), 4000);
        haptic('success');
        break;
      case 'vibe_sent':
        toast(t('vibe_sent'), 2600);
        break;
      case 'vibe_match': onVibeMatch(msg.peer); break;
      case 'rate_prompt':
        if (state !== 'talking') { $('rate').hidden = false; clearTimeout(rateTimer); rateTimer = setTimeout(() => { $('rate').hidden = true; }, 60_000); }
        break;
      case 'rated': break;
      case 'event':
        setEvent(msg.event);
        if (msg.event.active) { toast(t('event_started'), 3500); haptic('medium'); }
        break;
      case 'round_end':
        closePeer();
        state = 'waiting';
        setOverlay('waiting');
        toast(t('round_end'), 2200);
        break;
      case 'room':
        setRoom(msg.room);
        setOnline(msg.online);
        toast(t('in_common'));
        break;
      case 'game':
        if (msg.data?.g === 'mask') { toast(t(msg.data.on ? 'peer_masked' : 'peer_unmasked'), 2200); break; }
        if (msg.data?.g === 'reveal') { onPeerReveal(); break; }
        games.onMessage(msg.data || {});
        break;
      case 'banned': onBanned(msg.until, msg.reason); break;
    }
  }

  function onBanned(until, reason) {
    state = 'banned';
    closePeer();
    localStream?.getTracks().forEach(t => t.stop());
    closeSheet();
    const forever = !until || until > Date.now() + 5 * 365 * 864e5;
    $('banned-text').textContent = reason === 'age' ? t('banned_age') : forever
      ? t('banned_text')
      : t('banned_until', { date: new Date(until).toLocaleString(LOCALE, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) });
    showScreen('banned');
  }

  function setMe(m) {
    me = m;
    el.premiumBtn.classList.toggle('on', me.premium);
    for (const seg of ['gender-seg', 'gender-seg-2']) {
      for (const b of $(seg).children) b.classList.toggle('on', b.dataset.v === me.gender);
    }
    for (const b of $('want-seg').children) b.classList.toggle('on', b.dataset.v === me.want);
    const canFilter = me.premium || me.filterLeft > 0;
    $('want-seg').classList.toggle('locked', !canFilter);
    $('filter-sub').textContent = me.premium ? t('filter_premium')
      : me.filterLeft > 0 ? t('filter_left', { n: me.filterLeft, max: freePerDay })
      : t('filter_out');
    $('aura-val').textContent = me.aura ?? 100;
    $('streak-val').hidden = !me.streak;
    $('streak-val').textContent = me.streak ? `🔥${me.streak}` : '';
    renderPassportPill();
    for (const b of $('mode-seg').children) b.classList.toggle('on', b.dataset.v === (me.reveal ? 'voice' : 'video'));
    for (const b of $('notify-seg').children) b.classList.toggle('on', b.dataset.v === (me.notifyEvents ? '1' : '0'));
    if (me.langs?.length) { myLangs = me.langs; renderLangs(); }
    $('premium-status').textContent = me.premium
      ? t('premium_until', { date: new Date(me.premiumUntil).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' }) })
      : t('premium_sub');
    updateStart();
  }

  // ---------- Языки ----------
  let myLangs = [(tg?.initDataUnsafe?.user?.language_code || navigator.language || 'ru').slice(0, 2)].filter(l => LANG_META[l]);
  if (!myLangs.length) myLangs = ['ru'];
  function renderLangs() {
    for (const id of ['lang-chips', 'lang-chips-2']) {
      const wrap = $(id);
      const order = [...myLangs, ...Object.keys(LANG_META).filter(l => !myLangs.includes(l))];
      wrap.replaceChildren(...order.map(l => {
        const b = document.createElement('button');
        b.className = 'chip' + (myLangs.includes(l) ? ' on' : '');
        b.textContent = `${LANG_META[l][0]} ${LANG_META[l][1]}`;
        b.onclick = () => {
          if (myLangs.includes(l)) {
            if (myLangs.length === 1) return toast(t('need_lang'));
            myLangs = myLangs.filter(x => x !== l);
          } else {
            if (myLangs.length >= 5) return toast(t('max_langs'));
            myLangs = [...myLangs, l];
          }
          send({ t: 'profile', langs: myLangs });
          renderLangs();
          haptic();
        };
        return b;
      }));
    }
  }
  renderLangs();

  // ---------- Aura Hour ----------
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
  };
  const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function setEvent(ev) {
    eventInfo = ev || null;
    const teaser = $('event-teaser');
    if (!eventInfo) { teaser.hidden = true; return; }
    teaser.hidden = false;
    teaser.textContent = eventInfo.active ? t('event_now') : t('event_at', { time: eventInfo.time });
    renderEventBanner();
  }
  function renderEventBanner() {
    const b = $('event-banner');
    if (!eventInfo?.active || Date.now() > eventInfo.endsAt) { b.hidden = true; return; }
    b.hidden = false;
    b.classList.add('hot');
    b.textContent = state === 'talking' && matchedAt
      ? t('banner_round', { t: mmss(eventInfo.roundMs - (Date.now() - matchedAt)) })
      : t('banner_left', { t: mmss(eventInfo.endsAt - Date.now()) });
  }
  setInterval(renderEventBanner, 1000);

  // ---------- Комнаты каналов ----------
  function setRoom(room) {
    const banner = $('room-banner'), chip = $('room-chip');
    if (!room) { banner.hidden = chip.hidden = true; return; }
    banner.hidden = false;
    banner.textContent = t('room_banner', { title: room.title });
    chip.hidden = false;
    chip.replaceChildren(`📢 ${room.title}`);
    const out = document.createElement('button');
    out.textContent = t('to_common');
    out.onclick = () => { send({ t: 'room', slug: null }); haptic(); };
    chip.append(out);
  }

  // ---------- Вайб: взаимное желание продолжить общение ----------
  // Разрешение боту писать в личку (для контакта по вайбу и напоминаний). Вне Telegram и в старых версиях — бросает.
  function requestPm() {
    if (me.allowsPm || !tg?.initData || !tg.isVersionAtLeast?.('6.9')) return;
    try {
      tg.requestWriteAccess(ok => { if (ok) { me.allowsPm = true; send({ t: 'allow_pm' }); } });
    } catch {}
  }
  $('vibe-btn').onclick = () => {
    if (state !== 'talking') return;
    const b = $('vibe-btn');
    if (b.classList.contains('on')) return;
    b.classList.add('on');
    send({ t: 'vibe' });
    haptic('medium');
    requestPm();
  };
  let vibePeer = null;
  function onVibeMatch(peer) {
    vibePeer = peer;
    $('vibe-text').textContent = t('vibe_text', { name: peer.name || t('vibe_someone') });
    $('vibe-write').hidden = !peer.username;
    $('vibe-fine').textContent = t(peer.username ? 'vibe_fine' : 'vibe_hidden');
    openSheet('sheet-vibe');
    haptic('success');
  }
  $('vibe-write').onclick = () => {
    if (!vibePeer?.username) return;
    const url = `https://t.me/${vibePeer.username}`;
    if (tg?.initData) tg.openTelegramLink(url); else window.open(url, '_blank');
  };

  // ---------- Аура: оценка прошлого собеседника ----------
  let rateTimer = null;
  $('rate').onclick = e => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!v) return;
    send({ t: 'rate', v: Number(v) });
    $('rate').hidden = true;
    toast(t(Number(v) > 0 ? 'rated_plus' : 'rated_minus'), 1800);
    haptic(Number(v) > 0 ? 'success' : 'light');
  };
  // ---------- Паспорт Aura ----------
  const regionNames = (() => { try { return new Intl.DisplayNames([LOCALE], { type: 'region' }); } catch { return null; } })();
  const flagOf = code => /^[A-Z]{2}$/.test(code || '') ? String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '🏳️';
  const countryName = code => { try { return regionNames?.of(code) || code; } catch { return code; } };
  function renderPassportPill() { $('passport-val').textContent = `🛂${(me.passport || []).length}`; }
  function openPassport() {
    const list = me.passport || [];
    $('passport-sub').textContent = t('passport_sub', { n: list.length, countries: tn('countries', list.length) });
    $('aura-line').textContent = t('aura_info', { n: me.aura ?? 100 }) + (me.streak ? t('streak_info', { n: me.streak, days: tn('days', me.streak) }) : '');
    const wrap = $('stamps');
    if (!list.length) {
      const e = document.createElement('div'); e.className = 'empty'; e.textContent = t('passport_empty'); wrap.replaceChildren(e);
    } else {
      wrap.replaceChildren(...list.map((c, i) => {
        const d = document.createElement('div'); d.className = 'stamp'; d.style.animationDelay = `${Math.min(i, 20) * 30}ms`;
        d.append(flagOf(c)); const sm = document.createElement('small'); sm.textContent = countryName(c); d.append(sm);
        return d;
      }));
    }
    $('passport-share').hidden = !list.length;
    openSheet('sheet-passport');
  }
  $('me-pill').onclick = openPassport;
  $('passport-share').onclick = () => {
    const list = me.passport || [];
    shareStory({ emoji: list.slice(-12).map(flagOf).join(''), title: `${list.length} ${tn('countries', list.length)}`, subtitle: t('story_passport_sub'), many: true });
  };

  // ---------- Режим «Сначала голос» ----------
  // Лицо собеседника размыто и проявляется за REVEAL_MS; поверх — аура, «дышащая» в такт его голосу.
  // Оба нажали «Показать» — открываемся сразу. Размытие делает клиент: это механика знакомства, а не защита.
  const REVEAL_MS = 45_000;
  let rv = null; // { start, mine, peer, timer, raf, ctx }
  function startReveal(peer) {
    stopReveal();
    rv = { start: Date.now(), mine: false, peer: false };
    el.remote.classList.remove('veil');
    el.remote.classList.add('revealing');
    el.remote.style.filter = 'blur(30px) brightness(.8)';
    $('reveal-flag').textContent = peer?.country ? flagOf(peer.country) : '🎧';
    $('reveal-btn').textContent = t('reveal_btn');
    $('reveal').hidden = false;
    rv.timer = setInterval(() => {
      const p = Math.min(1, (Date.now() - rv.start) / REVEAL_MS);
      el.remote.style.filter = `blur(${(30 * (1 - p)).toFixed(1)}px) brightness(${(.8 + .2 * p).toFixed(2)})`;
      if (p >= 1) finishReveal();
    }, 1000);
    // Уровень голоса собеседника → размер ауры
    try {
      const stream = el.remote.srcObject;
      if (stream?.getAudioTracks().length) {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const an = ctx.createAnalyser(); an.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        const loop = () => {
          if (!rv) return;
          an.getByteFrequencyData(buf);
          const lvl = Math.min(1, buf.reduce((a, b) => a + b, 0) / buf.length / 90);
          $('voice-aura').style.setProperty('--lvl', lvl.toFixed(2));
          rv.raf = requestAnimationFrame(loop);
        };
        rv.ctx = ctx; loop();
      }
    } catch {}
  }
  function finishReveal(showToast = false) {
    if (!rv) return;
    stopReveal();
    if (showToast) { toast(t('revealed'), 1800); haptic('success'); }
  }
  function stopReveal() {
    if (rv) { clearInterval(rv.timer); cancelAnimationFrame(rv.raf); rv.ctx?.close().catch(() => {}); }
    rv = null;
    $('reveal').hidden = true;
    el.remote.style.filter = '';
    el.remote.classList.remove('revealing');
  }
  $('reveal-btn').onclick = () => {
    if (!rv || rv.mine) return;
    rv.mine = true;
    send({ t: 'game', data: { g: 'reveal' } });
    haptic('medium');
    if (rv.peer) finishReveal(true); else $('reveal-btn').textContent = t('reveal_wait');
  };
  function onPeerReveal() {
    if (!rv) return;
    rv.peer = true;
    if (rv.mine) finishReveal(true); else toast(t('reveal_peer'), 2500);
  }
  $('mode-seg').onclick = e => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!v) return;
    send({ t: 'profile', reveal: v === 'voice' });
    if (v === 'voice') toast(t('reveal_hint'), 3000);
    haptic();
  };

  // ---------- Приглашение друга ----------
  function shareInvite() {
    const url = me.refLink;
    if (!url) return;
    const text = t('invite_text');
    const share = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
    if (tg?.initData) tg.openTelegramLink(share);
    else if (navigator.share) navigator.share({ url, text }).catch(() => {});
    else { navigator.clipboard?.writeText(url); toast(t('link_copied')); }
    haptic();
  }
  $('invite-btn').onclick = shareInvite;
  $('invite-btn2').onclick = shareInvite;

  // ---------- Настройки: напоминания, маска по умолчанию ----------
  $('notify-seg').onclick = e => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!v) return;
    if (v === '1') requestPm();
    send({ t: 'profile', notifyEvents: v === '1' });
    haptic();
  };
  function renderMaskDefault() {
    for (const b of $('maskdef-seg').children) b.classList.toggle('on', b.dataset.v === (store.get('maskDefault') === '1' ? '1' : '0'));
  }
  $('maskdef-seg').onclick = e => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!v) return;
    store.set('maskDefault', v);
    renderMaskDefault();
    haptic();
  };
  renderMaskDefault();

  // ---------- Эмодзи-статус и ярлык на главный экран (Mini Apps 2.0) ----------
  let extrasReady = false;
  function setupExtras() {
    if (extrasReady) return;
    extrasReady = true;
    const v8 = Boolean(tg?.initData) && tg.isVersionAtLeast?.('8.0');
    if (v8 && emojiStatusId && tg.initDataUnsafe?.user?.is_premium) {
      $('status-btn').hidden = false;
      $('status-btn').onclick = () => tg.setEmojiStatus(emojiStatusId, { duration: 24 * 3600 }, ok => {
        if (ok) toast(t('status_set'));
      });
    }
    if (v8 && tg.addToHomeScreen) {
      $('home-btn').hidden = false;
      $('home-btn').onclick = () => tg.addToHomeScreen();
      $('promo-ok').onclick = () => { closeSheet(); tg.addToHomeScreen(); };
      const sessions = Number(store.get('sessions') || 0) + 1;
      store.set('sessions', String(sessions));
      tg.checkHomeScreenStatus?.(status => {
        if (status === 'added') { $('home-btn').hidden = true; return; }
        if (sessions >= 3 && !store.get('homePrompted')) {
          store.set('homePrompted', '1');
          setTimeout(() => { if (state !== 'talking' && !openSheetId) openSheet('sheet-promo'); }, 15_000);
        }
      });
    }
  }

  // ---------- Маска ----------
  const mask = window.AuraMask.create({ getRawVideo: () => el.selfBg });
  async function setMask(on) {
    maskOn = on;
    $('mask-btn').classList.toggle('on', on);
    if (on) mask.enable(); else mask.disable();
    el.local.srcObject = on ? new MediaStream([mask.track]) : localStream;
    el.local.play().catch(() => {});
    const sender = pc?.getSenders().find(x => x.track?.kind === 'video');
    if (sender) {
      await sender.replaceTrack(on ? mask.track : localStream.getVideoTracks()[0]).catch(() => {});
      send({ t: 'game', data: { g: 'mask', on } });
    }
  }
  $('mask-btn').onclick = () => { setMask(!maskOn); toast(t(maskOn ? 'mask_on' : 'mask_off'), 1600); haptic(); };

  // ---------- Игры и карточка для Stories ----------
  const games = window.AuraGames.create({
    send: data => send({ t: 'game', data }), toast, haptic, layer: $('game-layer'),
    isTalking: () => state === 'talking', getRawVideo: () => el.selfBg,
    getLang: () => (peerInfo?.langs?.includes('ru') ? 'ru' : peerInfo?.langs?.[0] || myLangs[0]),
    onResult: shareStory,
  });
  $('games-btn').onclick = () => {
    if (state !== 'talking') return toast(t('games_only_call'));
    openSheet('sheet-games');
  };
  $('sheet-games').onclick = e => {
    const g = e.target.closest('[data-game]')?.dataset.game;
    if (!g) return;
    closeSheet();
    games.start(g);
  };

  // Рисуем вертикальную карточку 1080×1920 в стиле приложения
  async function renderStoryCard({ emoji, title, subtitle, many = false }) {
    await document.fonts?.ready;
    const c = document.createElement('canvas');
    c.width = 1080; c.height = 1920;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1080, 1920);
    g.addColorStop(0, '#36d1f0'); g.addColorStop(0.5, '#4a86f7'); g.addColorStop(1, '#5a4ff0');
    x.fillStyle = g; x.fillRect(0, 0, 1080, 1920);
    for (const [cx, cy, r, a] of [[900, 300, 420, .18], [120, 1500, 520, .14], [700, 1650, 300, .12]]) {
      x.fillStyle = `rgba(255,255,255,${a})`; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    }
    // Стеклянная карточка
    x.fillStyle = 'rgba(255,255,255,.16)';
    x.strokeStyle = 'rgba(255,255,255,.55)';
    x.lineWidth = 3;
    x.beginPath(); x.roundRect(90, 520, 900, 880, 72); x.fill(); x.stroke();
    x.fillStyle = '#fff';
    x.textAlign = 'center';
    x.font = '800 64px Montserrat, sans-serif';
    x.fillText(appName.toUpperCase(), 540, 300);
    x.font = '500 38px Montserrat, sans-serif';
    x.fillText(t('story_brand'), 540, 370);
    if (many) {
      // Флаги паспорта — сеткой по 4 в ряд
      const flags = [...new Intl.Segmenter().segment(emoji)].map(g => g.segment);
      x.font = '112px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      flags.forEach((f, i) => x.fillText(f, 250 + (i % 4) * 193, 690 + Math.floor(i / 4) * 135));
    } else {
      x.font = '260px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
      x.fillText(emoji, 540, 880);
    }
    x.font = '800 84px Montserrat, sans-serif';
    x.fillText(title, 540, 1080);
    x.font = '500 44px Montserrat, sans-serif';
    x.fillText(subtitle, 540, 1170);
    x.fillStyle = 'rgba(255,255,255,.95)';
    x.beginPath(); x.roundRect(240, 1560, 600, 120, 60); x.fill();
    x.fillStyle = '#4a74f5';
    x.font = '800 44px Montserrat, sans-serif';
    x.fillText(t('story_cta'), 540, 1636);
    return new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  }

  async function shareStory(result) {
    try {
      const blob = await renderStoryCard(result);
      const res = await fetch('/api/story', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-init-data': tg?.initData || '' }, body: blob });
      if (!res.ok) throw new Error(res.status);
      const { url } = await res.json();
      if (tg?.initData && tg.isVersionAtLeast?.('7.8')) {
        const opts = { text: `${result.emoji} ${result.title} — ${appName} ✨` };
        if (tg.initDataUnsafe?.user?.is_premium && me.refLink) opts.widget_link = { url: me.refLink, name: appName };
        tg.shareToStory(url, opts);
      } else {
        window.open(url, '_blank');
      }
      haptic('success');
    } catch (e) {
      toast(t('story_fail'));
    }
  }

  // ---------- Действия ----------
  function next() {
    if (state === 'banned') return;
    el.next.disabled = true;
    setTimeout(() => { el.next.disabled = false; }, 900);
    closePeer();
    state = 'waiting';
    setOverlay('waiting');
    if (ws?.readyState === WebSocket.OPEN) send({ t: 'next' });
    else if (!ws || ws.readyState === WebSocket.CLOSED) connect(); // после ready поиск начнётся сам
    haptic();
  }

  function swipeNext() {
    if (state !== 'talking') return next();
    el.remote.classList.add('out');
    setTimeout(next, 200);
  }

  // ---------- Чат ----------
  function addMessage(text, who) {
    const m = document.createElement('div');
    m.className = `msg ${who}`;
    m.textContent = text;
    el.messages.append(m);
    while (el.messages.children.length > 5) el.messages.firstChild.remove();
    setTimeout(() => { m.classList.add('fade'); setTimeout(() => m.remove(), 600); }, 12_000);
  }
  function clearMessages() { el.messages.replaceChildren(); }

  el.composer.onsubmit = e => {
    e.preventDefault();
    const text = el.input.value.trim();
    if (!text || state !== 'talking') return;
    send({ t: 'chat', text });
    addMessage(text, 'me');
    el.input.value = '';
  };
  el.chatBtn.onclick = () => {
    el.composer.hidden = !el.composer.hidden;
    el.chatBtn.classList.toggle('on', !el.composer.hidden);
    $('chat').classList.toggle('composing', !el.composer.hidden);
    if (!el.composer.hidden) el.input.focus();
  };

  // ---------- Листы ----------
  let openSheetId = null;
  function openSheet(id) {
    closeSheet();
    openSheetId = id;
    $('scrim').hidden = false;
    $(id).hidden = false;
    tg?.BackButton?.show();
  }
  function closeSheet() {
    if (!openSheetId) return;
    $(openSheetId).hidden = true;
    $('scrim').hidden = true;
    openSheetId = null;
    tg?.BackButton?.hide();
  }
  $('scrim').onclick = closeSheet;
  tg?.BackButton?.onClick(closeSheet);
  $('warning-ok').onclick = closeSheet;

  // Свайп листа вниз — закрыть
  for (const sheet of document.querySelectorAll('.sheet')) {
    let y0 = null;
    sheet.addEventListener('touchstart', e => { if (sheet.scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
    sheet.addEventListener('touchmove', e => {
      if (y0 === null) return;
      const dy = Math.max(0, e.touches[0].clientY - y0);
      sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener('touchend', e => {
      if (y0 === null) return;
      const dy = e.changedTouches[0].clientY - y0;
      sheet.style.transform = '';
      y0 = null;
      if (dy > 90) closeSheet();
    });
  }

  $('report-btn').onclick = () => {
    if (state !== 'talking' && state !== 'connecting') return toast(t('report_only_call'));
    openSheet('sheet-report');
  };
  $('sheet-report').onclick = e => {
    const reason = e.target.closest('[data-reason]')?.dataset.reason;
    if (!reason) return;
    closeSheet();
    closePeer();
    state = 'waiting';
    setOverlay('waiting');
    send({ t: 'report', reason });
  };

  $('filter-btn').onclick = () => openSheet('sheet-filter');
  $('want-seg').onclick = e => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!v) return;
    if (v !== 'any' && !me.premium && !(me.filterLeft > 0)) { openPremium(); return; }
    send({ t: 'profile', want: v });
    haptic();
  };
  $('gender-seg-2').onclick = e => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (v) { send({ t: 'profile', gender: v }); haptic(); }
  };

  function openPremium() {
    const wrap = $('plans');
    wrap.replaceChildren(...Object.entries(plans).map(([id, p]) => {
      const b = document.createElement('button');
      b.className = 'plan' + (id === selectedPlan ? ' on' : '');
      b.dataset.plan = id;
      const perDay = (p.stars / (id === 'week' ? 7 : 30)).toFixed(1).replace('.0', '');
      b.innerHTML = `${id === 'month' ? '<span class="p-badge"></span>' : ''}
        <div class="p-title"></div><div class="p-price"></div><div class="p-title p-day"></div>`;
      if (id === 'month') b.querySelector('.p-badge').textContent = t('best');
      b.querySelector('.p-day').textContent = t('per_day', { n: perDay });
      b.querySelector('.p-title').textContent = t('plan_' + id) || p.title;
      b.querySelector('.p-price').textContent = `${p.stars} ⭐`;
      b.onclick = () => {
        selectedPlan = id;
        for (const x of wrap.children) x.classList.toggle('on', x === b);
        haptic();
      };
      return b;
    }));
    $('buy-btn').disabled = !paymentsOn;
    openSheet('sheet-premium');
  }
  el.premiumBtn.onclick = openPremium;
  $('buy-btn').onclick = () => { send({ t: 'invoice', plan: selectedPlan }); haptic('medium'); };

  $('pause-btn').onclick = () => { send({ t: 'stop' }); closePeer(); state = 'idle'; setOverlay('idle'); haptic(); };
  el.resume.onclick = next;
  el.next.onclick = swipeNext;
  $('flip-btn').onclick = flipCamera;
  el.mic.onclick = () => {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    el.mic.classList.toggle('off', !track.enabled);
    el.mic.querySelector('use').setAttribute('href', track.enabled ? '#i-mic' : '#i-mic-off');
    toast(t(track.enabled ? 'mic_on' : 'mic_off'), 1200);
    haptic();
  };

  // ---------- Свайп влево по видео — следующий ----------
  (() => {
    let x0 = null, y0 = 0, dx = 0;
    const hint = $('swipe-hint');
    el.stage.addEventListener('pointerdown', e => { x0 = e.clientX; y0 = e.clientY; dx = 0; });
    el.stage.addEventListener('pointermove', e => {
      if (x0 === null) return;
      dx = Math.min(0, e.clientX - x0);
      if (Math.abs(e.clientY - y0) > Math.abs(dx) + 20) { x0 = null; return; }
      el.remote.classList.add('dragging');
      el.remote.style.transform = `translateX(${dx}px) rotate(${dx / 60}deg)`;
      const p = Math.min(1, -dx / 120);
      hint.style.opacity = p;
      hint.style.transform = `scale(${0.6 + p * 0.4})`;
    });
    const end = () => {
      if (x0 === null) return;
      x0 = null;
      el.remote.classList.remove('dragging');
      el.remote.style.transform = '';
      hint.style.opacity = 0;
      hint.style.transform = '';
      if (dx < -110) swipeNext();
    };
    el.stage.addEventListener('pointerup', end);
    el.stage.addEventListener('pointercancel', end);
  })();

  // ---------- Перетаскиваемое окно своей камеры, прилипает к углам рамки ----------
  (() => {
    const pip = el.pip;
    const M = 12;
    let start = null;
    pip.addEventListener('pointerdown', e => {
      e.stopPropagation(); // не запускать свайп «Далее»
      const r = pip.getBoundingClientRect();
      start = { x: e.clientX - r.left, y: e.clientY - r.top };
      pip.setPointerCapture(e.pointerId);
      pip.classList.add('dragging');
    });
    pip.addEventListener('pointermove', e => {
      if (!start) return;
      const s = el.stage.getBoundingClientRect();
      pip.style.right = 'auto';
      pip.style.left = `${e.clientX - s.left - start.x}px`;
      pip.style.top = `${e.clientY - s.top - start.y}px`;
    });
    pip.addEventListener('pointerup', () => {
      if (!start) return;
      start = null;
      pip.classList.remove('dragging');
      const s = el.stage.getBoundingClientRect();
      const r = pip.getBoundingClientRect();
      const minTop = document.querySelector('.topbar').getBoundingClientRect().bottom - s.top + M;
      const maxTop = $('bottom').getBoundingClientRect().top - s.top - r.height - M;
      const left = r.left + r.width / 2 < s.left + s.width / 2;
      const top = r.top + r.height / 2 < s.top + s.height / 2;
      pip.style.left = left ? `${M}px` : `${s.width - r.width - M}px`;
      pip.style.top = `${top ? minTop : maxTop}px`;
      haptic('soft');
    });
  })();

  // ---------- Онбординг ----------
  function updateStart() {
    $('start').disabled = !($('consent').checked && (me.gender === 'm' || me.gender === 'f'));
  }
  $('gender-seg').onclick = e => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!v) return;
    me.gender = v;
    for (const b of $('gender-seg').children) b.classList.toggle('on', b.dataset.v === v);
    haptic();
    updateStart();
  };
  $('consent').checked = store.get('consent') === '1';
  $('consent').onchange = updateStart;

  $('start').onclick = async () => {
    $('start').disabled = true;
    try {
      await startCamera();
    } catch {
      $('cam-error').hidden = false;
      $('cam-error').textContent = t('cam_error');
      updateStart();
      haptic('error');
      return;
    }
    store.set('consent', '1');
    send({ t: 'profile', gender: me.gender, langs: myLangs });
    showScreen('chat');
    if (maskOn) setMask(true);
    el.local.play().catch(() => {}); // srcObject назначен, пока экран был скрыт — автоплей не стартует сам
    el.selfBg.play().catch(() => {});
    haptic('medium');
    next();
  };

  connect();
})();
