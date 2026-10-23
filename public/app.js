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
    // Полный экран (Bot API 8.0+) на телефонах: кнопка меню и inline-кнопки открывают Mini App не во весь экран
    if (['ios', 'android'].includes(tg.platform) && tg.isVersionAtLeast?.('8.0') && !tg.isFullscreen) {
      try { tg.requestFullscreen(); } catch {}
    }
    tg.lockOrientation?.();
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
  let invoiceKind = 'premium';
  let afterStart = null; // что сделать после включения камеры (принять звонок, встать в очередь эфира)
  let aiFeatures = {};
  let wrappedShown = false;
  let threads = null;        // «Нити» — модуль подключается после игр (public/threads.js)

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
  // «Позовите, когда соберутся»: кнопка появляется, если поиск затянулся
  let crowdTimer = null;
  function renderCrowd() {
    $('crowd-text').textContent = me.crowd ? t('crowd_on', { n: me.crowdMin || 8 }) : t('crowd_btn', { n: me.crowdMin || 8 });
    $('crowd-btn').classList.toggle('on', Boolean(me.crowd));
  }
  function showCrowdLater(mode) {
    clearTimeout(crowdTimer);
    $('crowd-btn').hidden = true;
    if (mode !== 'waiting' && mode !== 'idle') return;
    crowdTimer = setTimeout(() => { renderCrowd(); $('crowd-btn').hidden = false; }, mode === 'idle' ? 0 : 8000);
  }
  function setOverlay(mode) {
    showCrowdLater(mode);
    threads?.onOverlay(mode);
    $('chat').classList.toggle('idle', Boolean(mode));
    el.searching.classList.toggle('gone', !mode);
    el.searching.classList.toggle('paused', mode === 'idle');
    el.searching.classList.toggle('connecting', mode === 'connecting');
    el.resume.hidden = mode !== 'idle';
    if (mode === 'waiting') {
      el.searchTitle.textContent = t(me.pair ? 'search_pair' : me.want === 'f' ? 'search_f' : me.want === 'm' ? 'search_m' : 'search_any');
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
  // WebView в Telegram для компьютера капризнее браузера: если полный запрос не прошёл (не запрет), пробуем проще
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('getUserMedia unavailable'), { name: 'NoMediaDevices' });
    const tries = [
      { video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
      { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
      { video: true, audio: true },
      { video: true },
    ];
    let err = null;
    for (const c of tries) {
      try { localStream = await navigator.mediaDevices.getUserMedia(c); err = null; break; }
      catch (e) { err = e; if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') break; }
    }
    if (err) throw err;
    el.local.srcObject = localStream;
    el.selfBg.srcObject = localStream; // своя камера в размытии на фоне поиска
  }

  async function flipCamera() {
    const want = facing === 'user' ? 'environment' : 'user';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: want, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } });
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
      if (!maskOn && duo.active) duo.replaceVideo(track);
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
  // Видео собеседника идёт со звуком, а встроенный браузер Telegram на компьютере не пускает звук без
  // нажатия — видео тогда стоит на первом (ещё мутном) кадре. Запускаем без звука, звук — по любому касанию.
  let soundBlocked = false;
  // Telegram для компьютера (macOS/Windows) плохо справляется с H.264 от телефонов: входящие кадры
  // отбрасываются (собеседник замер), исходящее — 320×180 при 4 к/с. VP8 обрабатывается программно
  // везде, поэтому в этих клиентах ставим его первым — и в предложении, и в ответе.
  function preferCodecs(p) {
    if (!['tdesktop', 'macos', 'unigram'].includes(tg?.platform)) return;
    const caps = window.RTCRtpReceiver?.getCapabilities?.('video')?.codecs;
    if (!caps?.some(c => /vp8/i.test(c.mimeType))) return;
    const rank = c => /vp8/i.test(c.mimeType) ? 0 : /h264/i.test(c.mimeType) ? 2 : 1;
    const sorted = [...caps].sort((a, b) => rank(a) - rank(b));
    for (const t of p.getTransceivers()) {
      if (t.receiver?.track?.kind === 'video') try { t.setCodecPreferences?.(sorted); } catch {}
    }
  }
  window.auraPreferCodecs = preferCodecs;
  async function playRemote() {
    if (!el.remote.srcObject || !el.remote.paused) return;
    try { await el.remote.play(); return; }
    catch (e) { if (e?.name !== 'NotAllowedError') return; }
    soundBlocked = true;
    el.remote.muted = true;
    $('sound-on').hidden = false;
    el.remote.play().catch(() => {});
  }
  setInterval(() => { if (state === 'talking') playRemote(); }, 1500);
  // Обезличенная статистика видео через 10 с после соединения: двигается ли картинка и в каком качестве
  async function reportVideo() {
    try {
      const st = await pc.getStats();
      let inb = {}, out = {};
      const codecs = new Map();
      st.forEach(x => {
        if (x.type === 'inbound-rtp' && x.kind === 'video') inb = x;
        else if (x.type === 'outbound-rtp' && x.kind === 'video') out = x;
        else if (x.type === 'codec') codecs.set(x.id, x.mimeType);
      });
      const cam = localStream?.getVideoTracks()[0]?.getSettings?.() || {};
      send({ t: 'diag', kind: 'video', platform: tg?.platform || 'web', os: desktopOs(),
        paused: el.remote.paused, muted: el.remote.muted, vw: el.remote.videoWidth, vh: el.remote.videoHeight,
        inW: inb.frameWidth, inH: inb.frameHeight, inFps: inb.framesPerSecond, dec: inb.framesDecoded, drop: inb.framesDropped,
        codec: codecs.get(inb.codecId), ocodec: codecs.get(out.codecId), outW: out.frameWidth, outH: out.frameHeight, outFps: out.framesPerSecond,
        ql: out.qualityLimitationReason, camW: cam.width, camH: cam.height });
    } catch {}
  }
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
    threads?.onCallEnd();
    if (typeof railMore === 'function') railMore(false);
    $('vibe-btn').classList.remove('on');
    peerInfo = null;
    matchedAt = 0;
    setSwap(false);
    stopExchange();
    stopReveal();
    stopGuess();
    $('moment-ask').hidden = true;
    $('countdown').hidden = true;
    momentPending = false;
    if (!duo.active) { $('react-bar').hidden = true; $('react-btn').classList.remove('on'); }
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
    tuneSenders(pc);

    pc.ontrack = e => {
      if (el.remote.srcObject !== e.streams[0]) el.remote.srcObject = e.streams[0];
      playRemote();
    };
    pc.onicecandidate = e => { if (e.candidate) send({ t: 'signal', data: { candidate: e.candidate } }); };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected' && state !== 'talking') {
        clearTimeout(connectTimer);
        reportConn(true, 'connected');
        const vp = pc;
        setTimeout(() => { if (pc === vp) reportVideo(); }, 10_000);
        state = 'talking';
        setOverlay(null);
        if (reveal) startReveal(peer);
        else setTimeout(() => el.remote.classList.remove('veil'), 1500); // первые секунды размыто — как в Azar
        if (peer?.guess) startGuess(peer.guess);
        if (peer?.exchange) startExchange(peer.exchange);
        haptic('medium');
        const who = peer?.pair ? `👫 ${t('peer_pair')}` : peer?.gender === 'f' ? t('peer_f') : peer?.gender === 'm' ? t('peer_m') : '';
        const lang = (peer?.langs || []).map(l => LANG_META[l]?.[0]).filter(Boolean).join(' ');
        const where = peer?.country ? `${flagOf(peer.country)} ${countryName(peer.country)}` : '';
        const direct = peer?.direct === 'friend' ? `👥 ${peer.name || ''}` : peer?.direct === 'live' ? `🔴 ${peer.name || 'LIVE'}` : '';
        if (direct || who || lang || where) {
          el.peerChip.textContent = [direct, where, direct ? '' : who, lang].filter(Boolean).join(' · ');
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
      preferCodecs(pc);
      await pc.setLocalDescription(tuneSdp(await pc.createOffer()));
      send({ t: 'signal', data: { sdp: pc.localDescription } });
    }
  }

  // Качество: до 2,5 Мбит/с и 30 к/с для видео, приоритет медиа в сети, голос 64 кбит/с
  async function tuneSenders(p) {
    for (const sender of p.getSenders()) {
      const kind = sender.track?.kind;
      if (!kind) continue;
      try {
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        const e = params.encodings[0];
        if (kind === 'video') {
          e.maxBitrate = 2_500_000;
          e.maxFramerate = 30;
          e.scaleResolutionDownBy = 1;
          params.degradationPreference = 'balanced';
        } else {
          e.maxBitrate = 64_000;
        }
        e.priority = 'high';
        e.networkPriority = 'high';
        await sender.setParameters(params);
      } catch {}
    }
  }
  // Opus: устойчивость к потерям (FEC), моно, 48 кбит/с — разборчивее на мобильной сети
  function tuneSdp(desc) {
    const sdp = desc.sdp.replace(/a=fmtp:(\d+) (.*minptime=\d+.*)/g, (line, pt, rest) =>
      /useinbandfec/.test(rest) ? line : `a=fmtp:${pt} ${rest};useinbandfec=1;stereo=0;maxaveragebitrate=48000`);
    return { type: desc.type, sdp };
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
          preferCodecs(pc);
          await pc.setLocalDescription(tuneSdp(await pc.createAnswer()));
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
    const q = new URLSearchParams(location.search);
    ws.onopen = () => send({
      t: 'auth', initData: tg?.initData || '', tz: -new Date().getTimezoneOffset(), lang: LOCALE,
      // Браузер на компьютере: одноразовый код из Mini App или сохранённая сессия
      ...(tg?.initData ? {} : { login: q.get('login') || '', session: store.get('auraSession') || '' }),
      ...(tg?.initData ? {} : { devId: devId(), startParam: new URLSearchParams(location.search).get('startapp') || '', devCountry: new URLSearchParams(location.search).get('country') || '' }),
    });
    ws.onmessage = e => handle(JSON.parse(e.data));
    ws.onclose = ev => {
      closePeer();
      duo.stop();
      duoInfo = null;
      renderDuo();
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
        aiFeatures = msg.ai || {};
        window.AuraI18n.setApp(appName);
        setMe(msg.me);
        setOnline(msg.online);
        setEvent(msg.event);
        setRoom(msg.room);
        if (msg.referred) toast(t('referred'), 4000);
        setupExtras();
        threads.setup(msg);
        if (msg.openWrapped && !wrappedShown) { wrappedShown = true; setTimeout(openWrapped, 600); }
        if (msg.liveInvite && !pendingLive) {
          pendingLive = msg.liveInvite.code;
          if (localStream) joinLive(pendingLive); else afterStart = () => joinLive(pendingLive);
          if (!localStream) toast(t(msg.liveInvite.online ? 'live_invite_on' : 'live_invite_off', { title: msg.liveInvite.title }), 5000);
        }
        send({ t: 'friends' });
        if (state === 'waiting' || state === 'connecting' || state === 'talking') send({ t: 'find' });
        break;
      case 'me': setMe(msg.me); break;
      case 'online': setOnline(msg.n); break;
      case 'waiting':
        if (state !== 'idle') { closePeer(); state = 'waiting'; setOverlay('waiting'); }
        break;
      case 'matched':
        hideCallCard();
        $('live-leave').hidden = true;
        startPeer(msg.initiator, msg.peer, msg.reveal);
        break;
      case 'stamp':
        me.passport = [...new Set([...(me.passport || []), msg.country])];
        renderPassportPill();
        toast(t('stamp_new', { flag: flagOf(msg.country), name: countryName(msg.country), n: msg.total, countries: tn('countries', msg.total) }), 3500);
        haptic('success');
        break;
      case 'signal': onSignal(msg.data); break;
      case 'chat': addMessage(msg.text, 'them'); haptic('soft'); break;
      case 'chat_masked': if (msg.reason === 'contact') toast(t('chat_masked'), 3500); break;
      case 'chat_blocked':
        toast(t(msg.reason === 'spam' ? 'chat_spam' : 'chat_blocked', { n: msg.strikes, max: msg.max }), 4500);
        haptic('warning');
        el.messages.lastElementChild?.classList.contains('me') && el.messages.lastElementChild.classList.add('blocked');
        break;
      case 'translated': onTranslated(msg); break;
      case 'ai_topic_fail': games.aiTopicFailed(); break;
      case 'wrapped_line': if (msg.text) { $('arch-desc').textContent = msg.text; } break;
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
        if (msg.dev) { toast('DEV: покупка без оплаты'); closeSheet(); break; }
        tg?.openInvoice?.(msg.url, status => {
          if (status === 'paid') { closeSheet(); toast(t(invoiceKind === 'salute' ? 'salutes_added' : 'premium_on')); haptic('success'); }
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
        if (msg.data?.g === 'moment') { onMoment(msg.data); break; }
        games.onMessage(msg.data || {});
        break;
      case 'banned': onBanned(msg.until, msg.reason); break;
      case 'react': onReact(msg.kind); break;
      case 'session':
        store.set('auraSession', msg.token);
        history.replaceState(null, '', location.pathname);
        break;
      case 'handoff':
        if (tg?.initData && tg.openLink) tg.openLink(msg.url); else window.open(msg.url, '_blank');
        toast(t('desk_opened'), 5000);
        break;
      case 'friend_added': case 'friends': case 'calling': case 'call_incoming': case 'call_declined':
      case 'call_timeout': case 'call_cancelled': case 'call_error': case 'call_ended':
        onCallMessage(msg);
        break;
      case 'live': onLiveMessage(msg); break;
      case 'need_salutes': openSalutes(); break;
      case 'guess_result': onGuessResult(msg); break;
      case 'complimented': toast(t(msg.dup ? 'compl_dup' : 'complimented'), 2200); break;
      case 'compliment':
        toast(t('compl_got', { what: `${COMPL_EMOJI[msg.kind] || '✨'} ${t('c_' + msg.kind)}` }), 3500);
        haptic('success');
        break;
      case 'wrapped': renderWrapped(msg.data); break;
      case 'thread_pocket': case 'thread_card': case 'thread_received': case 'thread_passed': case 'thread_declined':
      case 'thread_final': case 'thread_offer': case 'thread_page': case 'thread_news': case 'thread_error':
        threads.onMessage(msg);
        break;
      case 'duo': case 'duo_waiting': case 'duo_matched': case 'duo_signal': case 'duo_ended': case 'duo_error':
        onDuoMessage(msg);
        break;
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
    $('salute-n').textContent = me.salutes || 0;
    renderComplBoard();
    for (const b of $('mode-seg').children) b.classList.toggle('on', b.dataset.v === (me.reveal ? 'voice' : 'video'));
    for (const b of $('pair-seg').children) b.classList.toggle('on', b.dataset.v === (me.pair ? '1' : '0'));
    $('pair-chip').hidden = !me.pair;
    for (const b of $('notify-seg').children) b.classList.toggle('on', b.dataset.v === (me.notifyEvents ? '1' : '0'));
    if (me.langs?.length) { myLangs = me.langs; renderLangs(); }
    renderExchange();
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
    if (duo.active) return toast(t('duo_only_1v1'));
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
    $('aura-line').textContent = t('aura_info', { n: me.aura ?? 100 }) + (me.streak ? t('streak_info', { n: me.streak, days: tn('days', me.streak) }) : '')
      + (me.salutesReceived ? ` · 🎆 ${me.salutesReceived}` : '');
    renderComplBoard();
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
    if (duo.active) duo.replaceVideo(on ? mask.track : localStream.getVideoTracks()[0]);
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
    requestAiTopic: () => { if (!aiFeatures.icebreakers) return false; send({ t: 'ai_topic' }); return true; },
  });
  // «Нити»: карман, карточка в звонке, прилёт в ожидании, финал. Общие функции передаём лениво — часть объявлена ниже
  threads = window.AuraThreads.create({
    send, toast, haptic, t, tn, LOCALE, flagOf, countryName, openSheet, closeSheet,
    openShare: (...a) => openShare(...a), drawQr: (...a) => drawQr(...a), shortLink: () => shortLink(), requestPm: () => requestPm(),
    isTalking: () => state === 'talking', getMe: () => me, appName: () => appName,
    el: { stage: el.stage, chat: $('chat') },
  });
  $('thread-btn').onclick = () => threads.tap();
  // Рейл: второстепенные кнопки раскрываются по «ещё», после разговора сворачиваются
  function railMore(open) {
    $('rail-sub').hidden = !open;
    $('rail-more').classList.toggle('on', open);
  }
  $('rail-more').onclick = () => { railMore($('rail-sub').hidden); haptic(); };

  $('games-btn').onclick = () => {
    if (duo.active) return toast(t('duo_only_1v1'));
    if (state !== 'talking') return toast(t('games_only_call'));
    openSheet('sheet-games');
  };
  $('sheet-games').onclick = e => {
    const g = e.target.closest('[data-game]')?.dataset.game;
    if (!g) return;
    closeSheet();
    games.start(g);
  };

  // QR-код со ссылкой на Aura: рисуем модули прямо на canvas (библиотека qrcode-generator, MIT)
  function drawQr(x, text, left, top, size) {
    if (!window.qrcode || !text) return;
    const q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), cell = size / n;
    x.fillStyle = '#1b2440';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (q.isDark(r, c)) x.fillRect(left + c * cell, top + r * cell, Math.ceil(cell), Math.ceil(cell));
    }
  }
  const shortLink = () => (me.shareLink || 'https://aura-life.online').replace(/^https?:\/\//, '');

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
    // Низ карточки: QR-код и короткая ссылка — работают в любой соцсети, даже без кликабельных ссылок
    x.fillStyle = 'rgba(255,255,255,.96)';
    x.beginPath(); x.roundRect(110, 1470, 860, 310, 56); x.fill();
    drawQr(x, me.shareLink || 'https://aura-life.online', 150, 1510, 230);
    x.textAlign = 'left';
    x.fillStyle = '#4a74f5';
    x.font = '800 46px Montserrat, sans-serif';
    x.fillText(t('story_join'), 420, 1590);
    x.fillStyle = '#5a6080';
    x.font = '600 34px Montserrat, sans-serif';
    x.fillText(t('story_scan'), 420, 1650);
    x.fillStyle = '#1b2440';
    x.font = '700 32px Montserrat, sans-serif';
    x.fillText(shortLink(), 420, 1715);
    x.textAlign = 'center';
    return new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  }

  async function shareStory(result) {
    try {
      const blob = await renderStoryCard(result);
      openShare(blob, `${result.emoji} ${result.title} — ${appName} ✨`);
    } catch (e) {
      toast(t('story_fail'));
    }
  }

  // ---------- Поделиться: Telegram Stories, чат Telegram, Instagram/WhatsApp и др., сохранить, ссылка ----------
  const share = { blob: null, url: null, text: '', preview: null };
  const tgv = v => Boolean(tg?.initData) && tg.isVersionAtLeast?.(v);
  function openShare(blob, text) {
    share.blob = blob; share.url = null; share.text = text;
    if (share.preview) URL.revokeObjectURL(share.preview);
    share.preview = URL.createObjectURL(blob);
    $('share-img').src = share.preview;
    $('share-story').hidden = !tgv('7.8');
    $('share-chat').hidden = !tg?.initData;
    openSheet('sheet-share');
    haptic('success');
  }
  async function shareUploaded() {
    if (!share.url) share.url = await uploadCard(share.blob);
    return share.url;
  }
  const caption = () => `${share.text}\n${me.shareLink || ''}`.trim();
  $('share-story').onclick = async () => {
    try {
      const url = await shareUploaded();
      const opts = { text: caption().slice(0, 200) };
      // Кликабельный виджет-ссылка в Stories доступен авторам с Telegram Premium
      if (tg.initDataUnsafe?.user?.is_premium && me.refLink) opts.widget_link = { url: me.refLink, name: appName };
      tg.shareToStory(url, opts);
    } catch { toast(t('story_fail')); }
  };
  $('share-chat').onclick = async () => {
    try {
      if (tgv('8.0') && tg.shareMessage) {
        // Карточка с кнопкой «Открыть Aura» — готовит бот
        const url = await shareUploaded();
        const res = await fetch('/api/share/prepare', { method: 'POST', headers: { 'content-type': 'application/json', 'x-init-data': tg.initData }, body: JSON.stringify({ photoUrl: url }) });
        if (!res.ok) throw new Error(res.status);
        const { id } = await res.json();
        tg.shareMessage(id, ok => { if (ok) toast(t('share_sent')); });
        return;
      }
    } catch {}
    const link = me.shareLink || me.refLink || '';
    tg?.openTelegramLink?.(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(share.text)}`);
  };
  $('share-other').onclick = async () => {
    const file = new File([share.blob], 'aura.jpg', { type: 'image/jpeg' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], text: caption() }); return; } catch (e) { if (e?.name === 'AbortError') return; }
    }
    // Системное «Поделиться» недоступно (часто внутри Telegram): сохраняем картинку и копируем ссылку
    await saveShareImage();
    copyShareLink(false);
    toast(t('share_hint'), 6000);
  };
  async function saveShareImage() {
    try {
      if (tgv('8.0') && tg.downloadFile) { tg.downloadFile({ url: await shareUploaded(), file_name: `aura-${Date.now()}.jpg` }); return; }
    } catch {}
    const a = document.createElement('a');
    a.href = share.preview; a.download = `aura-${Date.now()}.jpg`; a.click();
  }
  function copyShareLink(notify = true) {
    const link = me.shareLink || me.refLink || 'https://aura-life.online';
    navigator.clipboard?.writeText(link).then(() => notify && toast(t('link_copied')), () => notify && toast(link, 5000));
  }
  $('share-save').onclick = () => { saveShareImage(); haptic(); };
  // Отладка карточек на localhost (вне Telegram)
  if (!tg?.initData && ['localhost', '127.0.0.1'].includes(location.hostname)) window.__aura = { shareStory, get threads() { return threads; } };
  $('share-copy').onclick = () => { copyShareLink(); haptic(); };

  $('crowd-btn').onclick = () => {
    const on = !me.crowd;
    if (on) requestPm();
    send({ t: 'crowd', on });
    me.crowd = on;
    renderCrowd();
    toast(t(on ? 'crowd_toast' : 'crowd_off', { n: me.crowdMin || 8 }), 3500);
    haptic(on ? 'success' : 'light');
  };

  // ---------- Реакции поверх видео ----------
  const REACT_EMOJI = { heart: '❤️', laugh: '😂', fire: '🔥', clap: '👏', salute: '🎆' };
  function flyEmoji(kind, mine = false) {
    const fx = $('fx');
    const n = kind === 'salute' ? 1 : 3;
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span');
      s.className = 'fly' + (mine ? ' mine' : '');
      s.textContent = REACT_EMOJI[kind] || '✨';
      s.style.setProperty('--x', `${(mine ? 62 : 18) + Math.random() * 20}%`);
      s.style.setProperty('--drift', `${(Math.random() - .5) * 80}px`);
      s.style.animationDelay = `${i * 140}ms`;
      fx.append(s);
      setTimeout(() => s.remove(), 2600 + i * 140);
    }
    if (kind === 'salute') fireworks();
  }
  // Салют: три вспышки из частиц в разных точках экрана
  function fireworks() {
    const fx = $('fx');
    const colors = ['#ffd166', '#ff6b9a', '#6ee7ff', '#a78bfa', '#7cf29c'];
    for (let b = 0; b < 3; b++) {
      const burst = document.createElement('div');
      burst.className = 'burst';
      burst.style.left = `${20 + Math.random() * 60}%`;
      burst.style.top = `${18 + Math.random() * 40}%`;
      burst.style.animationDelay = `${b * 280}ms`;
      for (let i = 0; i < 22; i++) {
        const p = document.createElement('i');
        const a = (i / 22) * Math.PI * 2, r = 90 + Math.random() * 90;
        p.style.setProperty('--dx', `${Math.cos(a) * r}px`);
        p.style.setProperty('--dy', `${Math.sin(a) * r}px`);
        p.style.background = colors[(i + b) % colors.length];
        p.style.animationDelay = `${b * 280}ms`;
        burst.append(p);
      }
      fx.append(burst);
      setTimeout(() => burst.remove(), 2200 + b * 280);
    }
  }
  function canReact() { return state === 'talking' || duo.active; }
  $('react-btn').onclick = () => {
    if (!canReact()) return toast(t('react_only_call'));
    const bar = $('react-bar');
    bar.hidden = !bar.hidden;
    $('react-btn').classList.toggle('on', !bar.hidden);
    haptic();
  };
  let lastReactAt = 0;
  function react(kind) {
    if (!canReact()) return;
    const now = Date.now();
    if (now - lastReactAt < 320) return;
    lastReactAt = now;
    if (kind === 'salute' && !(me.salutes > 0)) return openSalutes();
    send({ t: 'react', kind });
    flyEmoji(kind, true);
    haptic(kind === 'salute' ? 'heavy' : 'light');
    if (kind === 'salute') toast(t('salute_sent'), 1600);
  }
  $('react-bar').onclick = e => { const k = e.target.closest('[data-k]')?.dataset.k; if (k) react(k); };
  // Двойной тап по видео собеседника — ❤️
  el.stage.addEventListener('dblclick', e => { if (!e.target.closest('#pip, .guess, .moment-ask, .rate')) react('heart'); });
  function onReact(kind) {
    flyEmoji(kind);
    if (kind === 'salute') { toast(t('salute_got'), 2600); haptic('success'); } else haptic('soft');
  }

  function openSalutes() {
    $('salutes-left').textContent = t('salutes_left', { n: me.salutes || 0 });
    const wrap = $('salute-plans');
    const list = Object.entries(plans).filter(([, p]) => p.kind === 'salute');
    let pick = list[0]?.[0];
    wrap.replaceChildren(...list.map(([id, p]) => {
      const b = document.createElement('button');
      b.className = 'plan' + (id === pick ? ' on' : '');
      b.innerHTML = '<div class="p-title"></div><div class="p-price"></div>';
      b.querySelector('.p-title').textContent = `🎆 × ${p.count}`;
      b.querySelector('.p-price').textContent = `${p.stars} ⭐`;
      b.onclick = () => { pick = id; for (const x of wrap.children) x.classList.toggle('on', x === b); haptic(); };
      return b;
    }));
    $('salute-buy').disabled = !paymentsOn || !list.length;
    $('salute-buy').onclick = () => { invoiceKind = 'salute'; send({ t: 'invoice', plan: pick }); haptic('medium'); };
    openSheet('sheet-salutes');
  }

  // ---------- «Угадай, откуда он» ----------
  let guess = null; // { options, until, timer }
  function startGuess(g) {
    stopGuess();
    if (!g) return;
    guess = { until: matchedAt + g.seconds * 1000 };
    const opts = $('guess-opts');
    opts.replaceChildren(...g.options.map(c => {
      const b = document.createElement('button');
      b.dataset.c = c;
      b.innerHTML = '<i></i><small></small>';
      b.querySelector('i').textContent = flagOf(c);
      b.querySelector('small').textContent = countryName(c);
      return b;
    }));
    $('guess-sub').textContent = t('guess_sub');
    $('guess').hidden = false;
    const tick = () => {
      const left = Math.max(0, Math.ceil((guess.until - Date.now()) / 1000));
      $('guess-timer').textContent = left;
      if (!left) stopGuess();
    };
    tick();
    guess.timer = setInterval(tick, 250);
  }
  function stopGuess() {
    if (guess) clearInterval(guess.timer);
    guess = null;
    $('guess').hidden = true;
  }
  $('guess-opts').onclick = e => {
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (!c || !guess || guess.picked) return;
    guess.picked = c;
    e.target.closest('button').classList.add('picked');
    send({ t: 'guess', country: c });
    haptic();
  };
  function onGuessResult(msg) {
    const btns = [...$('guess-opts').children];
    for (const b of btns) b.classList.toggle('right', b.dataset.c === msg.country);
    const vars = { flag: flagOf(msg.country), name: countryName(msg.country) };
    toast(t(msg.ok ? 'guess_ok' : msg.ok === false ? 'guess_no' : 'guess_timeout', vars), 3000);
    haptic(msg.ok ? 'success' : 'light');
    if (peerInfo) peerInfo.country = msg.country;
    setTimeout(stopGuess, msg.ok === null ? 0 : 1200);
    if (msg.stamp) setTimeout(() => handle({ t: 'stamp', ...msg.stamp }), 1500);
  }

  // ---------- Комплименты ----------
  const COMPL_EMOJI = { smile: '😊', funny: '😂', smart: '🧠', kind: '💛', voice: '🎙️', world: '🌍' };
  function renderComplChips() {
    $('compl-chips').replaceChildren(...Object.keys(COMPL_EMOJI).map(k => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.k = k;
      b.textContent = `${COMPL_EMOJI[k]} ${t('c_' + k)}`;
      return b;
    }));
  }
  renderComplChips();
  $('compl-chips').onclick = e => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (!k) return;
    send({ t: 'compliment', kind: k });
    $('rate').hidden = true;
    haptic('success');
  };
  function renderComplBoard() {
    const c = me.compliments || {};
    const list = Object.entries(c).sort((a, b) => b[1] - a[1]);
    const wrap = $('compl-list');
    if (!list.length) {
      const e = document.createElement('div'); e.className = 'empty'; e.textContent = t('compl_empty'); wrap.replaceChildren(e);
      return;
    }
    wrap.replaceChildren(...list.map(([k, n]) => {
      const d = document.createElement('div');
      d.className = 'chip on';
      d.textContent = `${COMPL_EMOJI[k] || '✨'} ${t('c_' + k)} · ${n}`;
      return d;
    }));
  }

  // ---------- Aura Moment: общее фото по согласию обоих ----------
  let momentPending = false;
  $('moment-btn').onclick = () => {
    if (duo.active) return toast(t('duo_only_1v1'));
    if (state !== 'talking') return toast(t('moment_only_call'));
    if (momentPending) return;
    momentPending = true;
    send({ t: 'game', data: { g: 'moment', a: 'req' } });
    toast(t('moment_wait'), 2500);
    setTimeout(() => { momentPending = false; }, 15_000);
    haptic();
  };
  function onMoment(data) {
    if (data.a === 'req') {
      $('moment-ask').hidden = false;
      haptic('medium');
      clearTimeout(onMoment.timer);
      onMoment.timer = setTimeout(() => { $('moment-ask').hidden = true; }, 12_000);
    } else if (data.a === 'yes' && momentPending) {
      momentPending = false;
      momentCountdown();
    } else if (data.a === 'no') {
      momentPending = false;
      toast(t('moment_no'));
    }
  }
  $('moment-yes').onclick = () => {
    $('moment-ask').hidden = true;
    send({ t: 'game', data: { g: 'moment', a: 'yes' } });
    momentCountdown();
  };
  $('moment-no').onclick = () => {
    $('moment-ask').hidden = true;
    send({ t: 'game', data: { g: 'moment', a: 'no' } });
  };
  function momentCountdown() {
    const cd = $('countdown');
    let n = 3;
    cd.hidden = false;
    const step = () => {
      if (state !== 'talking') { cd.hidden = true; return; }
      if (n === 0) {
        cd.hidden = true;
        const flash = $('flash');
        flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
        haptic('heavy');
        captureMoment();
        return;
      }
      cd.textContent = n;
      cd.classList.remove('pop'); void cd.offsetWidth; cd.classList.add('pop');
      haptic('light');
      n--;
      setTimeout(step, 800);
    };
    step();
  }
  // Кадр из видео с обрезкой «cover» под заданные размеры
  function grab(video, w, h, mirror = false) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) { x.fillStyle = '#1b2440'; x.fillRect(0, 0, w, h); return c; }
    const k = Math.max(w / vw, h / vh), dw = vw * k, dh = vh * k;
    if (mirror) { x.translate(w, 0); x.scale(-1, 1); }
    x.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return c;
  }
  let momentBlob = null, momentUrl = null;
  async function captureMoment() {
    const them = grab(el.remote, 860, 640);
    const mine = grab(el.local, 860, 640, facing === 'user');
    const c = document.createElement('canvas');
    c.width = 1080; c.height = 1920;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1080, 1920);
    g.addColorStop(0, '#36d1f0'); g.addColorStop(0.5, '#4a86f7'); g.addColorStop(1, '#5a4ff0');
    x.fillStyle = g; x.fillRect(0, 0, 1080, 1920);
    for (const [cx, cy, r, a] of [[930, 220, 380, .16], [80, 1700, 460, .14]]) {
      x.fillStyle = `rgba(255,255,255,${a})`; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
    }
    x.fillStyle = '#fff'; x.textAlign = 'center';
    x.font = '800 60px Montserrat, sans-serif';
    x.fillText(`${appName.toUpperCase()} MOMENT`, 540, 170);
    // Два «полароида» с лёгким поворотом
    const photo = (img, cx, cy, rot, flag) => {
      x.save(); x.translate(cx, cy); x.rotate(rot);
      x.shadowColor = 'rgba(10,20,60,.35)'; x.shadowBlur = 40; x.shadowOffsetY = 18;
      x.fillStyle = '#fff'; x.beginPath(); x.roundRect(-460, -350, 920, 730, 36); x.fill();
      x.shadowColor = 'transparent';
      x.save(); x.beginPath(); x.roundRect(-430, -320, 860, 640, 24); x.clip(); x.drawImage(img, -430, -320); x.restore();
      if (flag) { x.font = '56px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; x.fillText(flag, 390, 368); }
      x.restore();
    };
    photo(them, 540, 620, -0.035, peerInfo?.country ? flagOf(peerInfo.country) : '');
    photo(mine, 540, 1360, 0.03, me.country ? flagOf(me.country) : '');
    // Низ: QR и короткая ссылка на Aura, справа дата
    x.fillStyle = 'rgba(255,255,255,.96)';
    x.beginPath(); x.roundRect(60, 1745, 150, 150, 22); x.fill();
    drawQr(x, me.shareLink || 'https://aura-life.online', 72, 1757, 126);
    x.fillStyle = '#fff';
    x.textAlign = 'left';
    x.font = '800 38px Montserrat, sans-serif';
    x.fillText(t('story_join'), 240, 1805);
    x.font = '600 30px Montserrat, sans-serif';
    x.fillText(shortLink(), 240, 1855);
    x.textAlign = 'right';
    x.font = '600 30px Montserrat, sans-serif';
    x.fillText(new Date().toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }), 1020, 1855);
    x.textAlign = 'center';
    momentBlob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
    if (momentUrl) URL.revokeObjectURL(momentUrl);
    momentUrl = URL.createObjectURL(momentBlob);
    $('moment-img').src = momentUrl;
    openSheet('sheet-moment');
    haptic('success');
  }
  async function uploadCard(blob) {
    const res = await fetch('/api/story', { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-init-data': tg?.initData || '', 'x-session': store.get('auraSession') || '' }, body: blob });
    if (!res.ok) throw new Error(res.status);
    return (await res.json()).url;
  }
  $('moment-share').onclick = () => { if (momentBlob) openShare(momentBlob, `📸 ${appName} Moment ✨`); };
  $('moment-save').onclick = async () => {
    if (!momentBlob) return;
    if (tg?.initData && tg.isVersionAtLeast?.('8.0') && tg.downloadFile) {
      try { tg.downloadFile({ url: await uploadCard(momentBlob), file_name: `aura-moment-${Date.now()}.jpg` }); return; }
      catch { toast(t('story_fail')); return; }
    }
    const a = document.createElement('a');
    a.href = momentUrl; a.download = `aura-moment-${Date.now()}.jpg`; a.click();
  };

  // ---------- Aura Wrapped: итоги недели ----------
  const ARCH = { traveler: '🧭', magnet: '🧲', soul: '🎉', voice: '🎙️', thinker: '🧠', warm: '💛', sunny: '☀️', tireless: '⚡', newbie: '🌱' };
  let wrappedData = null;
  function openWrapped() { send({ t: 'wrapped', lang: LOCALE }); }
  function renderWrapped(w) {
    wrappedData = w;
    $('arch-emoji').textContent = ARCH[w.archetype] || '✨';
    $('arch-title').textContent = t('a_' + w.archetype);
    $('arch-desc').textContent = t('a_' + w.archetype + '_d');
    const stats = [[w.chats, 'wrapped_chats'], [w.minutes, 'wrapped_min'], [w.countries.length, 'wrapped_countries'], [w.vibes, 'wrapped_vibes']];
    $('wstats').replaceChildren(...stats.map(([n, k]) => {
      const d = document.createElement('div');
      d.innerHTML = '<b></b><small></small>';
      d.querySelector('b').textContent = n.toLocaleString(LOCALE);
      d.querySelector('small').textContent = t(k);
      return d;
    }));
    $('wrapped-top').textContent = !w.chats ? t('wrapped_empty')
      : w.topCompl ? t('wrapped_top', { what: `${COMPL_EMOJI[w.topCompl]} ${t('c_' + w.topCompl)}` })
      : w.countries.length ? w.countries.map(flagOf).join(' ') : '';
    $('wrapped-share').hidden = !w.chats;
    openSheet('sheet-wrapped');
    haptic('success');
  }
  $('wrapped-open').onclick = openWrapped;
  $('wrapped-share').onclick = () => {
    if (!wrappedData) return;
    shareStory({ emoji: ARCH[wrappedData.archetype] || '✨', title: t('a_' + wrappedData.archetype), subtitle: t('story_wrapped_sub') });
  };

  // ---------- Duo «двое на двое» ----------
  let duoInfo = null; // { code, size, searching, inCall, partner }
  const duo = window.AuraDuo.create({
    send,
    getIce: () => ice,
    getTracks: () => localStream ? localStream.getTracks().map(tr => ({ track: tr.kind === 'video' && maskOn ? mask.track : tr, stream: localStream })) : [],
    grid: $('duo-grid'),
    flagOf,
    onConnected: () => { if (state !== 'talking') { state = 'talking'; setOverlay(null); haptic('medium'); startFrames(); } },
  });
  const duoLink = code => (me.refLink || '').replace(/ref_[\w-]+$/, `duo_${code}`);
  function renderDuo() {
    const d = duoInfo;
    $('duo-none').hidden = Boolean(d);
    $('duo-have').hidden = !d;
    const chip = $('duo-chip');
    chip.hidden = !d;
    $('chat').classList.toggle('duo-mode', Boolean(d));
    if (!d) return;
    const full = d.size >= 2;
    $('duo-friend').classList.toggle('on', full);
    $('duo-friend').firstChild.textContent = full ? (d.partner?.country ? flagOf(d.partner.country) : '🙂') : '⏳';
    $('duo-code-view').textContent = t('duo_code', { code: d.code });
    $('duo-invite').hidden = full;
    $('duo-search').hidden = !full;
    $('duo-status').textContent = full ? t('duo_ready') : t('duo_waiting_friend');
    chip.replaceChildren(`👫 Duo${full ? '' : ' · ⏳'}`);
    const out = document.createElement('button');
    out.textContent = t('duo_leave');
    out.onclick = () => { send({ t: 'duo_leave' }); haptic(); };
    chip.append(out);
  }
  function duoWaiting() {
    closePeer();
    state = 'waiting';
    setOverlay('waiting');
    el.searchTitle.textContent = t('duo_searching');
  }
  $('duo-open').onclick = () => { renderDuo(); openSheet('sheet-duo'); };
  $('pair-chip').onclick = () => { renderDuo(); openSheet('sheet-duo'); };
  // «Вдвоём с одного телефона»: подбираем таких же двоих, собеседник узнаёт, что вас двое
  $('pair-seg').onclick = e => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v) return;
    const on = v === '1';
    if (on === Boolean(me.pair)) return;
    send({ t: 'profile', pair: on });
    toast(t(on ? 'pair_on' : 'pair_off'), 3000);
    haptic(on ? 'success' : 'light');
    if (state === 'waiting') send({ t: 'find' });
  };
  $('duo-create').onclick = () => { closePeer(); send({ t: 'duo_create' }); haptic('medium'); };
  $('duo-join').onsubmit = e => {
    e.preventDefault();
    const code = $('duo-code').value.trim().toLowerCase();
    if (code) { closePeer(); send({ t: 'duo_join', code }); haptic(); }
  };
  $('duo-invite').onclick = () => {
    const url = duoLink(duoInfo?.code);
    if (!url) return;
    const text = t('duo_invite_text');
    if (tg?.initData) tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
    else if (navigator.share) navigator.share({ url, text }).catch(() => {});
    else { navigator.clipboard?.writeText(url); toast(t('link_copied')); }
    haptic();
  };
  $('duo-search').onclick = () => { closeSheet(); send({ t: 'duo_search' }); duoWaiting(); haptic('medium'); };
  $('duo-leave').onclick = () => { send({ t: 'duo_leave' }); closeSheet(); haptic(); };
  function onDuoMessage(msg) {
    switch (msg.t) {
      case 'duo': {
        const was = duoInfo;
        duoInfo = msg.duo;
        renderDuo();
        if (!duoInfo) {
          duo.stop();
          if (was) { state = 'idle'; setOverlay('idle'); }
        } else if (was && was.size === 2 && duoInfo.size === 1) {
          toast(t('duo_partner_left'));
          duo.stop();
          state = 'idle'; setOverlay('idle');
        } else if (was && was.size === 1 && duoInfo.size === 2) {
          toast(t('duo_ready'), 2500); haptic('success');
        } else if (!was) {
          if (state !== 'onboard') { closePeer(); send({ t: 'stop' }); state = 'idle'; setOverlay('idle'); }
          if (!openSheetId) openSheet('sheet-duo');
        }
        break;
      }
      case 'duo_waiting': duoWaiting(); break;
      case 'duo_matched':
        closePeer();
        state = 'connecting';
        setOverlay('connecting');
        duo.start(msg);
        haptic('success');
        break;
      case 'duo_signal': duo.onSignal(msg.from, msg.data); break;
      case 'duo_ended':
        duo.stop();
        clearInterval(frameTimer);
        if (msg.reason === 'conn') { duoWaiting(); toast(t('duo_conn_fail'), 3200); haptic('warning'); }
        else if (msg.reason === 'next' || msg.reason === 'partner_left' && duoInfo?.size === 2) { duoWaiting(); toast(t('duo_ended'), 2200); }
        else if (msg.reason === 'moderation') { duoWaiting(); toast(t('moderated_peer')); }
        else { state = 'idle'; setOverlay('idle'); }
        break;
      case 'duo_error':
        toast(t('duo_' + msg.code));
        if (msg.code === 'need_partner') openSheet('sheet-duo');
        break;
    }
  }

  // ---------- Языковой обмен ----------
  const langLabel = l => `${LANG_META[l]?.[0] || ''} ${LANG_META[l]?.[1] || l}`;
  function renderExchange() {
    const ex = me.exchange;
    for (const b of $('ex-seg').children) b.classList.toggle('on', b.dataset.v === (ex ? '1' : '0'));
    $('ex-pickers').hidden = !ex;
    for (const [id, val] of [['ex-native', ex?.native || myLangs[0]], ['ex-learn', ex?.learn || (myLangs[0] === 'en' ? 'es' : 'en')]]) {
      const sel = $(id);
      if (!sel.options.length) sel.innerHTML = Object.keys(LANG_META).map(l => `<option value="${l}">${langLabel(l)}</option>`).join('');
      sel.value = val;
    }
  }
  function sendExchange(on) {
    const native = $('ex-native').value, learn = $('ex-learn').value;
    if (on && native === learn) return toast(t('ex_same'));
    send({ t: 'profile', exchange: on ? { native, learn } : null });
    haptic();
  }
  $('ex-seg').onclick = e => {
    const v = e.target.closest('[data-v]')?.dataset.v;
    if (!v) return;
    if (v === '1') { $('ex-pickers').hidden = false; sendExchange(true); toast(t('ex_saved'), 3500); }
    else sendExchange(false);
  };
  $('ex-native').onchange = $('ex-learn').onchange = () => { if (!$('ex-pickers').hidden) sendExchange(true); };

  // В разговоре: какой язык сейчас, обратный отсчёт до смены, подсказка темы на текущем языке
  let exTimer = null, exPlan = null;
  function startExchange(plan) {
    stopExchange();
    if (!plan) return;
    exPlan = { ...plan, at: Date.now(), switched: false };
    const tick = () => {
      if (!exPlan) return;
      const el2 = $('ex-chip');
      const elapsed = (Date.now() - exPlan.at) / 1000, half = exPlan.halfSec;
      let text;
      if (!exPlan.second) text = t('ex_practice', { lang: langLabel(exPlan.first) });
      else if (elapsed < half) text = t('ex_now', { lang: langLabel(exPlan.first), t: mmss(Math.max(0, (half - elapsed) * 1000)) });
      else if (elapsed < 2 * half) {
        if (!exPlan.switched) { exPlan.switched = true; toast(t('ex_switch', { lang: langLabel(exPlan.second) }), 4000); haptic('success'); }
        text = t('ex_now', { lang: langLabel(exPlan.second), t: mmss((2 * half - elapsed) * 1000) });
      } else text = t('ex_free');
      el2.replaceChildren(`🗣 ${text}`);
      if (aiFeatures.icebreakers) {
        const tip = document.createElement('button');
        tip.textContent = '💡';
        tip.onclick = () => {
          const cur = !exPlan.second || elapsed < half ? exPlan.first : exPlan.second;
          send({ t: 'ai_topic', lang: cur });
          haptic();
        };
        el2.append(tip);
      }
      el2.hidden = false;
    };
    tick();
    exTimer = setInterval(tick, 1000);
  }
  function stopExchange() { clearInterval(exTimer); exPlan = null; $('ex-chip').hidden = true; }

  // ---------- Друзья в Aura: список и звонки ----------
  let friends = [];
  const agoText = ms => {
    const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
    return m < 60 ? t('ago_m', { n: m }) : m < 1440 ? t('ago_h', { n: Math.round(m / 60) }) : t('ago_d', { n: Math.round(m / 1440) });
  };
  function renderFriends(list) {
    friends = list || [];
    $('friends-dot').hidden = !friends.some(f => f.online && !f.busy);
    const wrap = $('friends-list');
    if (!friends.length) { wrap.innerHTML = `<div class="friends-empty">${t('friends_empty')}</div>`; return; }
    wrap.replaceChildren(...friends.map(f => {
      const row = document.createElement('div');
      row.className = 'friend';
      const status = f.online ? (f.busy ? t('fr_busy') : t('fr_online')) : t('fr_seen', { ago: agoText(f.lastSeen) });
      row.innerHTML = `<span class="ava${f.online ? ' on' : ''}"></span><span class="meta"><b></b><small></small></span>
        <button class="call" aria-label="call">📞</button><button class="rm" aria-label="remove">✕</button>`;
      row.querySelector('.ava').textContent = (f.name || '?').slice(0, 1).toUpperCase();
      row.querySelector('b').textContent = `${f.name || '—'} ${f.country ? flagOf(f.country) : ''}`;
      row.querySelector('small').textContent = status;
      const call = row.querySelector('.call');
      call.disabled = f.busy;
      call.onclick = () => { closeSheet(); send({ t: 'call', code: f.code }); haptic('medium'); };
      row.querySelector('.rm').onclick = () => {
        const ok = () => send({ t: 'friend_remove', code: f.code });
        const q = t('fr_remove_q', { name: f.name || '' });
        if (tg?.showConfirm) tg.showConfirm(q, yes => yes && ok()); else if (confirm(q)) ok();
      };
      return row;
    }));
  }
  $('friends-btn').onclick = () => { send({ t: 'friends' }); renderFriends(friends); openSheet('sheet-friends'); haptic(); };
  setInterval(() => { if (state !== 'banned' && ws?.readyState === WebSocket.OPEN) send({ t: 'friends' }); }, 120_000);

  let callKind = null, ringTimer = null;
  function showCallCard(kind, p) {
    callKind = kind;
    $('call-ava').textContent = (p.name || '?').slice(0, 1).toUpperCase();
    $('call-title').textContent = kind === 'in' ? t('call_in', { name: p.name || '' }) : t('call_out', { name: p.name || '' });
    $('call-sub').textContent = kind === 'in' ? (p.country ? `${flagOf(p.country)} ${countryName(p.country)}` : '') : t(p.online ? 'call_ringing' : 'call_waiting_tg');
    $('call-accept').hidden = kind !== 'in';
    $('call-card').hidden = false;
    clearInterval(ringTimer);
    if (kind === 'in') ringTimer = setInterval(() => haptic('medium'), 1500);
    haptic(kind === 'in' ? 'heavy' : 'light');
  }
  function hideCallCard() { $('call-card').hidden = true; callKind = null; clearInterval(ringTimer); }
  $('call-accept').onclick = () => {
    hideCallCard();
    if (!localStream) { afterStart = () => send({ t: 'call_accept' }); toast(t('call_need_start'), 5000); return; }
    send({ t: 'call_accept' });
  };
  $('call-decline').onclick = () => { send({ t: callKind === 'in' ? 'call_decline' : 'call_cancel' }); hideCallCard(); haptic(); };
  function onCallMessage(msg) {
    switch (msg.t) {
      case 'friend_added': toast(t('friend_added', { name: msg.name || '' }), 3500); send({ t: 'friends' }); break;
      case 'friends': renderFriends(msg.list); break;
      case 'calling': closePeer(); state = 'idle'; setOverlay('idle'); showCallCard('out', msg.to); break;
      case 'call_incoming': showCallCard('in', msg.from); break;
      case 'call_declined': hideCallCard(); toast(t('call_declined')); break;
      case 'call_timeout': hideCallCard(); toast(t('call_timeout')); break;
      case 'call_cancelled': hideCallCard(); if (msg.reason !== 'gone' || callKind) toast(t('call_cancelled')); break;
      case 'call_error': hideCallCard(); toast(t(msg.code === 'busy' ? 'call_busy' : 'call_not_friend')); break;
      case 'call_ended':
        closePeer(); state = 'idle'; setOverlay('idle');
        if (!liveState) toast(t('call_ended'), 2200);
        break;
    }
  }

  // ---------- Комната стримера ----------
  let liveState = null, liveViewer = null, pendingLive = null, liveTick = null;
  const mmss2 = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  function renderLiveChip() {
    const chip = $('live-chip');
    if (!liveState) { chip.hidden = true; $('live-qr').hidden = true; clearInterval(liveTick); return; }
    chip.hidden = false;
    const left = liveState.turnEndsAt ? ` · ⏱ ${mmss2(liveState.turnEndsAt - Date.now())}` : '';
    chip.replaceChildren(`🔴 LIVE · ${t('live_chip', { n: liveState.queue })}${left}`);
    const qr = document.createElement('button');
    qr.textContent = 'QR';
    qr.onclick = () => { $('live-qr').hidden = !$('live-qr').hidden; haptic(); };
    const stop = document.createElement('button');
    stop.textContent = '⏹';
    stop.onclick = () => { send({ t: 'live_stop' }); haptic(); };
    chip.append(qr, stop);
  }
  function drawLiveQr(link) {
    const c = $('live-qr-canvas'), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 300, 300);
    drawQr(x, link, 10, 10, 280);
    $('live-qr-link').textContent = link.replace(/^https?:\/\//, '');
  }
  function renderLiveSheet() {
    $('live-setup').hidden = Boolean(liveState);
    $('live-on').hidden = !liveState;
    if (liveState) { $('live-queue').textContent = liveState.queue; $('live-link').textContent = liveState.link; }
    else if (!$('live-name').value) $('live-name').value = tg?.initDataUnsafe?.user?.first_name || '';
    for (const b of $('live-round').children) b.textContent = t('live_min', { n: Number(b.dataset.v) / 60 });
  }
  $('live-open').onclick = () => { closeSheet(); renderLiveSheet(); openSheet('sheet-live'); };
  $('live-round').onclick = e => { const b = e.target.closest('[data-v]'); if (!b) return; for (const x of $('live-round').children) x.classList.toggle('on', x === b); haptic(); };
  $('live-start').onclick = () => {
    const round = Number($('live-round').querySelector('.on')?.dataset.v || 120);
    send({ t: 'live_start', title: $('live-name').value.trim(), roundSec: round });
    closeSheet();
    haptic('success');
  };
  $('live-copy').onclick = () => { navigator.clipboard?.writeText(liveState?.link || '').then(() => toast(t('link_copied'))); haptic(); };
  $('live-stop').onclick = () => { send({ t: 'live_stop' }); closeSheet(); };
  function joinLive(code) { pendingLive = code; send({ t: 'live_join', code }); }
  $('live-leave').onclick = () => { send({ t: 'live_leave' }); $('live-leave').hidden = true; liveViewer = null; state = 'idle'; setOverlay('idle'); haptic(); };
  function liveInfo({ icon, title, sub, main, onMain }) {
    $('live-info-icon').textContent = icon;
    $('live-info-title').textContent = title;
    $('live-info-sub').textContent = sub;
    $('live-info-main-text').textContent = main;
    $('live-info-main').onclick = () => { closeSheet(); onMain(); };
    openSheet('sheet-live-info');
  }
  $('live-info-roulette').onclick = () => { closeSheet(); pendingLive = null; next(); };
  function onLiveMessage(msg) {
    if (msg.role === 'host') {
      if (msg.state === 'on') {
        const first = !liveState;
        liveState = msg;
        renderLiveChip();
        renderLiveSheet();
        if (first) { drawLiveQr(msg.link); $('live-qr').hidden = false; toast(t('live_started'), 3500); clearInterval(liveTick); liveTick = setInterval(renderLiveChip, 1000); }
        if (!pc && state !== 'talking') {
          state = 'waiting'; setOverlay('waiting');
          el.searchTitle.textContent = t('live_waiting');
          el.searchSub.textContent = t('live_waiting_sub', { n: msg.queue });
        }
      } else if (msg.state === 'stopped') {
        liveState = null; renderLiveChip(); renderLiveSheet();
        closePeer(); state = 'idle'; setOverlay('idle');
        toast(t('live_stopped'));
      }
      return;
    }
    switch (msg.state) {
      case 'queue':
        liveViewer = msg;
        if (!pc) {
          state = 'waiting'; setOverlay('waiting');
          el.searchTitle.textContent = t('live_queue_title', { title: msg.title });
          el.searchSub.textContent = t('live_queue_sub', { pos: msg.position, size: msg.size });
          $('live-leave').hidden = false;
        }
        break;
      case 'offline':
        liveViewer = null; $('live-leave').hidden = true;
        state = 'idle'; setOverlay('idle');
        liveInfo({
          icon: '🔴', title: t('live_off_title', { title: msg.title || '' }), sub: t('live_off_sub'),
          main: t(msg.subscribed ? 'live_unsub_btn' : 'live_sub_btn'),
          onMain: () => { if (!msg.subscribed) requestPm(); send({ t: 'live_sub', code: msg.code, on: !msg.subscribed }); if (!msg.subscribed) toast(t('live_subbed'), 3500); },
        });
        break;
      case 'done':
        liveViewer = null; $('live-leave').hidden = true;
        liveInfo({ icon: '🎉', title: t('live_done_title', { title: msg.title }), sub: t('live_done_sub'), main: t('live_again'), onMain: () => joinLive(msg.code) });
        break;
      case 'ended':
        liveViewer = null; $('live-leave').hidden = true;
        toast(t('live_ended', { title: msg.title || '' }), 3500);
        break;
      case 'left':
        liveViewer = null; $('live-leave').hidden = true;
        break;
    }
  }

  // ---------- Действия ----------
  function next() {
    if (state === 'banned') return;
    el.next.disabled = true;
    setTimeout(() => { el.next.disabled = false; }, 900);
    if (duoInfo) {
      if (duoInfo.size < 2) { openSheet('sheet-duo'); return; }
      duo.stop();
      duoWaiting();
      send({ t: duo.active || duoInfo.inCall ? 'duo_next' : 'duo_search' });
      haptic();
      return;
    }
    closePeer();
    $('live-leave').hidden = true;
    state = 'waiting';
    setOverlay('waiting');
    if (liveState) { el.searchTitle.textContent = t('live_waiting'); el.searchSub.textContent = t('live_waiting_sub', { n: liveState.queue }); }
    if (ws?.readyState === WebSocket.OPEN) send({ t: 'next' });
    else if (!ws || ws.readyState === WebSocket.CLOSED) connect(); // после ready поиск начнётся сам
    haptic();
  }

  function swipeNext() {
    if (state !== 'talking') return next();
    mainVideo().classList.add('out');
    setTimeout(next, 200);
  }

  // ---------- Чат ----------
  let msgSeq = 0;
  const fadeLater = (m, ms) => { clearTimeout(m._fade); m._fade = setTimeout(() => { m.classList.add('fade'); setTimeout(() => m.remove(), 600); }, ms); };
  function addMessage(text, who) {
    const m = document.createElement('div');
    m.className = `msg ${who}`;
    m.textContent = text;
    // Сообщение собеседника можно перевести нажатием (ИИ)
    if (who === 'them' && aiFeatures.translate) {
      m.classList.add('tr');
      m.dataset.id = String(++msgSeq);
      m.dataset.orig = text;
      m.onclick = () => translateMessage(m);
    }
    el.messages.append(m);
    while (el.messages.children.length > 5) el.messages.firstChild.remove();
    fadeLater(m, 12_000);
  }
  function translateMessage(m) {
    if (m.dataset.state === 'done') { // повторное нажатие — оригинал/перевод
      const showOrig = m.dataset.view !== 'orig';
      m.textContent = showOrig ? m.dataset.orig : m.dataset.tr;
      m.dataset.view = showOrig ? 'orig' : 'tr';
      fadeLater(m, 20_000);
      return;
    }
    if (m.dataset.state === 'busy') return;
    m.dataset.state = 'busy';
    m.classList.add('busy');
    fadeLater(m, 20_000);
    send({ t: 'translate', id: m.dataset.id, text: m.dataset.orig, lang: LOCALE });
    haptic();
  }
  function onTranslated(msg) {
    const m = el.messages.querySelector(`.msg[data-id="${CSS.escape(String(msg.id))}"]`);
    if (!m) return;
    m.classList.remove('busy');
    if (!msg.text) {
      m.dataset.state = '';
      return toast(t(msg.error === 'limit' ? 'translate_limit' : 'translate_fail'));
    }
    m.dataset.state = 'done';
    m.dataset.tr = msg.text;
    m.dataset.view = 'tr';
    m.textContent = msg.text;
    m.classList.add('translated');
    fadeLater(m, 20_000);
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
    // В Duo жалоба = немедленный выход из группы; модерация кадров при этом работает как обычно
    if (duo.active) { next(); return toast(t('duo_reported')); }
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
    wrap.replaceChildren(...Object.entries(plans).filter(([, p]) => p.kind !== 'salute').map(([id, p]) => {
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
  $('buy-btn').onclick = () => { invoiceKind = 'premium'; send({ t: 'invoice', plan: selectedPlan }); haptic('medium'); };

  $('pause-btn').onclick = () => {
    if (duoInfo) { send({ t: 'duo_stop' }); duo.stop(); } else send({ t: 'stop' });
    closePeer(); state = 'idle'; setOverlay('idle'); haptic();
  };
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
      mainVideo().classList.add('dragging');
      mainVideo().style.transform = `translateX(${dx}px) rotate(${dx / 60}deg)${swapped ? " scaleX(-1)" : ""}`;
      const p = Math.min(1, -dx / 120);
      hint.style.opacity = p;
      hint.style.transform = `scale(${0.6 + p * 0.4})`;
    });
    const end = () => {
      if (x0 === null) return;
      x0 = null;
      for (const v of [el.remote, el.local]) { v.classList.remove('dragging'); v.style.transform = ''; }
      hint.style.opacity = 0;
      hint.style.transform = '';
      if (dx < -110) swipeNext();
    };
    el.stage.addEventListener('pointerup', end);
    el.stage.addEventListener('pointercancel', end);
  })();

  // ---------- Смена видео местами: тап по маленькому окну ----------
  // Видео-элементы физически переставляются: #remote всегда показывает собеседника, #local — свою камеру,
  // поэтому модерация, Moment, «Сначала голос» и маска работают одинаково в обоих положениях.
  let swapped = false;
  const mainVideo = () => (swapped ? el.local : el.remote);
  function setSwap(on) {
    if (swapped === on) return;
    swapped = on;
    if (on) { el.stage.insertBefore(el.local, el.remote); el.pip.appendChild(el.remote); }
    else { el.stage.insertBefore(el.remote, el.local); el.pip.appendChild(el.local); }
    $('chat').classList.toggle('swapped', on);
    el.local.classList.remove('out', 'dragging');
    el.local.style.transform = '';
    el.remote.play().catch(() => {});
    el.local.play().catch(() => {});
  }
  function toggleSwap() {
    if (state !== 'talking' || duo.active) return;
    setSwap(!swapped);
    haptic('soft');
  }

  // ---------- Перетаскиваемое окно своей камеры, прилипает к углам рамки ----------
  (() => {
    const pip = el.pip;
    const M = 12;
    let start = null;
    pip.addEventListener('pointerdown', e => {
      e.stopPropagation(); // не запускать свайп «Далее»
      const r = pip.getBoundingClientRect();
      start = { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY, at: performance.now() };
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
    pip.addEventListener('pointerup', e => {
      if (!start) return;
      // Короткий тап без сдвига — поменять видео местами (окно остаётся на месте)
      const tap = Math.hypot(e.clientX - start.cx, e.clientY - start.cy) < 8 && performance.now() - start.at < 350;
      start = null;
      pip.classList.remove('dragging');
      if (tap) return toggleSwap();
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

  // Перед системным запросом камеры — короткое объяснение: так больше людей нажимают «Разрешить»
  // Telegram Desktop на macOS запускает видео только после действия пользователя: play() на каждом
  // <video> внутри нажатия снимает запрет для этого элемента навсегда, дальше play() работает и без нажатия
  function unlockMedia() {
    if (soundBlocked) { soundBlocked = false; el.remote.muted = false; $('sound-on').hidden = true; }
    for (const v of [el.local, el.selfBg, el.remote]) if (v.paused || v === el.remote) v.play()?.catch?.(() => {});
  }
  document.addEventListener('pointerdown', unlockMedia, true);
  document.addEventListener('keydown', unlockMedia, true);
  $('sound-on').onclick = e => { e.stopPropagation(); unlockMedia(); };
  async function cameraGranted() {
    try { return (await navigator.permissions?.query({ name: 'camera' }))?.state === 'granted'; } catch { return false; }
  }
  $('start').onclick = async () => {
    unlockMedia();
    if (!store.get('camPrimed') && !(await cameraGranted())) {
      $('cam-mask').checked = maskOn;
      openSheet('sheet-cam');
      return;
    }
    begin();
  };
  $('cam-allow').onclick = () => {
    unlockMedia();
    store.set('camPrimed', '1');
    if ($('cam-mask').checked !== maskOn) { store.set('maskDefault', $('cam-mask').checked ? '1' : '0'); maskOn = $('cam-mask').checked; renderMaskDefault(); }
    closeSheet();
    begin();
  };
  $('camd-retry').onclick = () => { unlockMedia(); closeSheet(); begin(); };
  const isDesktopTg = () => Boolean(tg?.initData) && ['tdesktop', 'macos', 'weba', 'webk', 'web', 'unigram'].includes(tg.platform);
  function openInBrowser() { send({ t: 'handoff' }); haptic(); }
  $('camd-browser').onclick = () => { closeSheet(); openInBrowser(); };
  const desktopOs = () => {
    const s = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
    return /win/i.test(s) ? 'win' : /mac/i.test(s) ? 'mac' : '';
  };
  // Подсказка по коду ошибки и системе; браузер — запасной путь, только если в Telegram не вышло
  function camDeniedHelp(e) {
    const p = tg?.platform || '', name = e?.name || '';
    $('camd-browser').hidden = !isDesktopTg();
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return t('camd_busy');
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return t('camd_nocam');
    if (isDesktopTg()) {
      const os = desktopOs();
      return t(os === 'mac' ? 'camd_mac' : os === 'win' ? 'camd_win' : 'camd_desktop');
    }
    return t(p === 'ios' ? 'camd_ios' : p === 'android' || p === 'android_x' ? 'camd_android' : 'camd_other');
  }
  async function begin() {
    $('start').disabled = true;
    try {
      await startCamera();
    } catch (e) {
      send({ t: 'diag', kind: 'cam', name: e?.name, msg: e?.message, platform: tg?.platform, ver: tg?.version, os: desktopOs() });
      $('cam-error').hidden = false;
      $('cam-error').textContent = t('cam_error');
      $('camd-text').textContent = camDeniedHelp(e);
      $('camd-code').textContent = [e?.name || 'Error', tg?.platform, tg?.version, desktopOs()].filter(Boolean).join(' · ');
      openSheet('sheet-cam-denied');
      updateStart();
      haptic('error');
      return;
    }
    $('cam-error').hidden = true;
    store.set('consent', '1');
    send({ t: 'profile', gender: me.gender, langs: myLangs });
    showScreen('chat');
    if (maskOn) setMask(true);
    el.local.play().catch(() => {}); // srcObject назначен, пока экран был скрыт — автоплей не стартует сам
    el.selfBg.play().catch(() => {});
    haptic('medium');
    if (afterStart) { const f = afterStart; afterStart = null; state = 'idle'; setOverlay('idle'); f(); }
    else next();
  };

  connect();
})();
