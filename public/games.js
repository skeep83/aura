// Игры в звонке. Логика на клиентах, сервер только пересылает сообщения {t:'game', data} собеседнику.
// Протокол data.g: topic | invite | accept | decline | rps | nl_lost
window.AuraGames = {
  create({ send, toast, haptic, layer, isTalking, getRawVideo, getLang, onResult, requestAiTopic }) {
    const { t } = window.AuraI18n;
    const TOPICS = {
      ru: [
        'Какой самый неожиданный поступок ты совершал(а) в жизни?', 'Куда бы ты поехал(а), если бы билет был бесплатным прямо сейчас?',
        'Какая песня у тебя сейчас на повторе?', 'Чему ты научился(лась) за последний месяц?', 'Какой фильм можешь пересматривать бесконечно?',
        'Если бы можно было один день прожить чужой жизнью — чьей?', 'Самая странная еда, которую ты пробовал(а)?',
        'Какая у тебя суперспособность в обычной жизни?', 'Что тебя гарантированно рассмешит?', 'О какой профессии ты мечтал(а) в детстве?',
        'Лучший совет, который тебе давали?', 'Что бы ты сделал(а) с миллионом, если его нужно потратить за сутки?',
        'Какое приложение ты удалил(а) бы первым?', 'Сова или жаворонок? Докажи.', 'Какой навык ты бы выучил(а) за одну ночь?',
        'Самое красивое место, где ты был(а)?', 'Что ты думаешь о людях, которые едят пиццу с ананасами?',
        'Какую вещь ты бы спас(ла) из горящего дома (все живые в безопасности)?', 'Какой у тебя самый бесполезный талант?',
        'Если бы ты был(а) мемом — каким?', 'Кого из знаменитостей позвал(а) бы на ужин?', 'Что ты сделаешь в первую очередь после этого звонка?',
      ],
      en: [
        'What is the most spontaneous thing you have ever done?', 'If a plane ticket were free right now, where would you go?',
        'What song is on repeat for you lately?', 'What did you learn in the last month?', 'Which movie could you rewatch forever?',
        'If you could live someone else’s life for a day — whose?', 'Weirdest food you have ever tried?',
        'What is your everyday superpower?', 'What always makes you laugh?', 'What did you want to be as a kid?',
        'Best advice you have ever received?', 'You must spend a million in 24 hours — how?',
        'Which app would you delete first?', 'Night owl or early bird? Prove it.', 'What skill would you learn overnight?',
        'The most beautiful place you have been to?', 'Pineapple on pizza — yes or no?', 'Your most useless talent?',
        'If you were a meme, which one?', 'Which celebrity would you invite to dinner?',
      ],
    };
    const NAMES = { rps: t('name_rps'), nolaugh: t('name_nolaugh') };
    const RPS = { rock: '✊', paper: '✋', scissors: '✌️' };
    const beats = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

    let game = null; // { kind, ... }
    let topicTimer = null;

    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    function show(card) { layer.replaceChildren(card); layer.hidden = false; }
    function clear() { layer.replaceChildren(); layer.hidden = true; }
    function card(title, body, buttons = []) {
      const c = el('div', 'game-card lg');
      c.append(el('h3', null, title));
      if (typeof body === 'string') c.append(el('p', null, body)); else if (body) c.append(body);
      if (buttons.length) {
        const row = el('div', 'row');
        for (const [label, fn, cls] of buttons) { const b = el('button', cls || '', label); b.onclick = fn; row.append(b); }
        c.append(row);
      }
      return c;
    }

    // ---------- Тема для разговора ----------
    function showTopicText(text, ai = false) {
      clearTimeout(topicTimer);
      show(card(ai ? `✨ ${t('topic_title')}` : t('topic_title'), text, [[t('more_topic'), () => sendTopic(), 'go'], [t('hide'), clear]]));
      topicTimer = setTimeout(clear, 25_000);
    }
    function showTopic(i) {
      const list = TOPICS[getLang() === 'ru' ? 'ru' : 'en'];
      showTopicText(list[i % list.length]);
    }
    // Своя тема из списка — запасной вариант, если ИИ выключен или не ответил
    function sendStaticTopic() {
      const i = Math.floor(Math.random() * 1000);
      send({ g: 'topic', i });
      showTopic(i);
    }
    let aiWait = null;
    function sendTopic() {
      haptic();
      if (!requestAiTopic?.()) return sendStaticTopic();
      show(card(`✨ ${t('topic_title')}`, t('topic_thinking')));
      clearTimeout(aiWait);
      aiWait = setTimeout(sendStaticTopic, 6000);
    }
    function aiTopicFailed() { clearTimeout(aiWait); sendStaticTopic(); }

    // ---------- Камень-ножницы-бумага: до двух побед ----------
    function rpsStart() {
      game = { kind: 'rps', round: 1, mine: {}, theirs: {}, me: 0, them: 0, locked: false };
      rpsRender();
    }
    function rpsRender(note) {
      const g = game;
      const body = el('div');
      body.append(el('div', 'score', `${g.me} : ${g.them}`));
      if (note) body.append(el('p', null, note));
      const picks = el('div', 'rps-picks');
      for (const [k, e] of Object.entries(RPS)) {
        const b = el('button', g.mine[g.round] === k ? 'picked' : '', e);
        b.disabled = Boolean(g.mine[g.round]) || g.locked;
        b.onclick = () => rpsPick(k);
        picks.append(b);
      }
      body.append(picks);
      show(card(t('rps_round', { n: g.round }) + (g.mine[g.round] && !g.theirs[g.round] ? t('waiting_opp') : ''), body));
    }
    function rpsPick(k) {
      const g = game;
      if (!g || g.mine[g.round]) return;
      g.mine[g.round] = k;
      send({ g: 'rps', r: g.round, pick: k });
      haptic();
      rpsResolve();
    }
    function rpsResolve() {
      const g = game;
      const a = g.mine[g.round], b = g.theirs[g.round];
      if (!a || !b) return rpsRender();
      let note;
      const pair = { a: RPS[a], b: RPS[b] };
      if (a === b) note = t('draw', pair);
      else if (beats[a] === b) { g.me++; note = t('you_win_round', pair); }
      else { g.them++; note = t('they_win_round', pair); }
      g.locked = true;
      rpsRender(note);
      setTimeout(() => {
        if (game !== g) return;
        if (g.me === 2 || g.them === 2) return finish(g.me > g.them
          ? { emoji: '🏆', title: t('win_title', { s: `${g.me}:${g.them}` }), subtitle: t('win_sub') }
          : { emoji: '🤝', title: t('lose_title', { s: `${g.me}:${g.them}` }), subtitle: t('lose_sub') });
        g.round++;
        g.locked = false;
        rpsRender();
      }, 1400);
    }

    // ---------- «Не смейся»: кто первый улыбнётся — проиграл ----------
    const NL_LIMIT = 60_000;
    function nlStart() {
      const g = game = { kind: 'nolaugh', startAt: performance.now() + 3000, over: false, streak: 0, lm: null, honor: false };
      window.AuraFace.load().then(lm => { g.lm = lm; }).catch(() => { g.honor = true; });
      const tick = () => {
        if (game !== g || g.over) return;
        const now = performance.now();
        if (now < g.startAt) {
          show(card(t('nl_title'), el('div', 'big-timer', String(Math.ceil((g.startAt - now) / 1000)))));
          return setTimeout(tick, 200);
        }
        const ms = now - g.startAt;
        if (ms >= NL_LIMIT) return nlEnd(null, ms);
        // Улыбку проверяем на своей камере
        if (g.lm) {
          try {
            const f = window.AuraFace.detect(g.lm, getRawVideo());
            g.streak = f && f.smile > 0.5 ? g.streak + 1 : 0;
            if (g.streak >= 3) { send({ g: 'nl_lost', ms: Math.round(ms) }); return nlEnd('me', ms); }
          } catch {}
        }
        const body = el('div');
        body.append(el('div', 'big-timer', (ms / 1000).toFixed(1) + ' s'));
        body.append(el('p', null, t(g.lm ? 'nl_watch' : g.honor ? 'nl_honor' : 'nl_loading')));
        const btns = g.lm ? [] : [[t('nl_smiled'), () => { send({ g: 'nl_lost', ms: Math.round(ms) }); nlEnd('me', ms); }]];
        show(card(t('nl_title'), body, btns));
        setTimeout(tick, 100);
      };
      tick();
    }
    function nlEnd(loser, ms) {
      const g = game;
      if (!g || g.kind !== 'nolaugh' || g.over) return;
      g.over = true;
      const sec = (ms / 1000).toFixed(1);
      if (loser === 'me') finish({ emoji: '😂', title: t('nl_lost_title', { s: sec }), subtitle: t('nl_lost_sub') });
      else if (loser === 'them') finish({ emoji: '🗿', title: t('nl_win_title', { s: sec }), subtitle: t('nl_win_sub') });
      else finish({ emoji: '🗿', title: t('nl_draw_title'), subtitle: t('nl_draw_sub') });
    }

    // ---------- Общее ----------
    function finish(result) {
      game = null;
      haptic('success');
      show(card(t('result'), `${result.emoji} ${result.title}`, [
        [t('share_story'), () => onResult(result), 'go'],
        [t('close'), clear],
      ]));
    }

    function start(kind) {
      if (!isTalking()) return toast(t('games_only_call'));
      if (kind === 'topic') return sendTopic();
      game = { kind: 'pending', want: kind };
      send({ g: 'invite', game: kind });
      if (kind === 'nolaugh') window.AuraFace.load().catch(() => {});
      show(card(t('invite_sent'), t('waiting_accept', { game: NAMES[kind] }), [[t('cancel'), () => { game = null; clear(); }]]));
    }

    function begin(kind) {
      if (kind === 'rps') rpsStart();
      else if (kind === 'nolaugh') nlStart();
    }

    function onMessage(d) {
      switch (d.g) {
        case 'topic': showTopic(Number(d.i) || 0); break;
        case 'topic_text': clearTimeout(aiWait); if (typeof d.text === 'string') showTopicText(d.text.slice(0, 200), true); break;
        case 'invite':
          if (!NAMES[d.game]) return;
          haptic('medium');
          if (d.game === 'nolaugh') window.AuraFace.load().catch(() => {});
          show(card(t('challenge'), t('challenge_text', { game: NAMES[d.game] }), [
            [t('play'), () => { send({ g: 'accept', game: d.game }); begin(d.game); }, 'go'],
            [t('not_now'), () => { send({ g: 'decline' }); clear(); }],
          ]));
          break;
        case 'accept':
          if (game?.kind === 'pending' && game.want === d.game) begin(d.game);
          break;
        case 'decline':
          if (game?.kind === 'pending') { game = null; clear(); toast(t('declined')); }
          break;
        case 'rps':
          if (game?.kind !== 'rps') return;
          game.theirs[Number(d.r)] = RPS[d.pick] ? d.pick : 'rock';
          if (Number(d.r) === game.round) rpsResolve();
          break;
        case 'nl_lost':
          nlEnd('them', Number(d.ms) || 0);
          break;
      }
    }

    function reset() { game = null; clearTimeout(topicTimer); clearTimeout(aiWait); clear(); }

    return { start, onMessage, reset, aiTopicFailed };
  },
};
