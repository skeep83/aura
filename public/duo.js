// Duo «двое на двое»: mesh из 4 участников. С каждым — своё RTCPeerConnection,
// предложение (offer) делает участник с меньшим слотом. Сигналы идут через сервер с адресом-слотом.
// Битрейт видео ограничен: исходящих потоков три, а мобильный аплинк небольшой.
window.AuraDuo = (() => {
  const MAX_BITRATE = 700_000; // на каждый из трёх исходящих потоков

  function create({ send, getIce, getTracks, grid, onConnected, onAllGone, flagOf }) {
    let you = null;
    const peers = new Map(); // slot -> { pc, video, tile, pending: [] }

    function tileFor(slot, info) {
      const tile = document.createElement('div');
      tile.className = `duo-tile team-${info.team}`;
      const v = document.createElement('video');
      v.autoplay = true; v.playsInline = true;
      const tag = document.createElement('span');
      tag.className = 'duo-tag lg';
      tag.textContent = info.country ? flagOf(info.country) : '';
      tag.hidden = !info.country;
      tile.append(v, tag);
      tile.dataset.slot = slot;
      return { tile, video: v };
    }

    async function capBitrate(pc) {
      for (const s of pc.getSenders()) {
        if (s.track?.kind !== 'video') continue;
        try {
          const p = s.getParameters();
          p.encodings = p.encodings?.length ? p.encodings : [{}];
          p.encodings[0].maxBitrate = MAX_BITRATE;
          p.encodings[0].scaleResolutionDownBy = 1.5; // 720p → 480p: четыре окна на экране, лишние пиксели не нужны
          await s.setParameters(p);
        } catch {}
      }
    }

    function connect(info) {
      const pc = new RTCPeerConnection({ iceServers: getIce() });
      const { tile, video } = tileFor(info.slot, info);
      const peer = { pc, video, tile, pending: [], connected: false };
      peers.set(info.slot, peer);
      grid.append(tile);
      for (const t of getTracks()) pc.addTrack(t.track, t.stream);
      pc.ontrack = e => { if (video.srcObject !== e.streams[0]) { video.srcObject = e.streams[0]; video.play().catch(() => {}); } };
      pc.onicecandidate = e => { if (e.candidate) send({ t: 'duo_signal', to: info.slot, data: { candidate: e.candidate } }); };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected' && !peer.connected) {
          peer.connected = true;
          tile.classList.add('live');
          capBitrate(pc);
          onConnected?.();
        } else if (pc.connectionState === 'failed') {
          tile.classList.add('lost');
        }
      };
      if (you < info.slot) {
        pc.createOffer()
          .then(o => pc.setLocalDescription(o))
          .then(() => send({ t: 'duo_signal', to: info.slot, data: { sdp: pc.localDescription } }))
          .catch(e => console.warn('duo offer', e));
      }
    }

    function start(msg) {
      stop();
      you = msg.you;
      // Свой тайл — первым, напарник рядом, соперники снизу
      const mine = document.createElement('div');
      mine.className = `duo-tile me team-${msg.team} live`;
      const v = document.createElement('video');
      v.autoplay = true; v.playsInline = true; v.muted = true;
      const tracks = getTracks().filter(t => t.track.kind === 'video');
      v.srcObject = new MediaStream(tracks.map(t => t.track));
      v.play().catch(() => {});
      mine.append(v);
      grid.append(mine);
      const order = [...msg.peers].sort((a, b) => (a.team === msg.team ? -1 : 1) - (b.team === msg.team ? -1 : 1) || a.slot - b.slot);
      for (const p of order) connect(p);
      grid.hidden = false;
    }

    async function onSignal(from, data) {
      const peer = peers.get(from);
      if (!peer) return;
      const { pc } = peer;
      try {
        if (data.sdp) {
          await pc.setRemoteDescription(data.sdp);
          if (data.sdp.type === 'offer') {
            await pc.setLocalDescription(await pc.createAnswer());
            send({ t: 'duo_signal', to: from, data: { sdp: pc.localDescription } });
          }
          for (const c of peer.pending) await pc.addIceCandidate(c);
          peer.pending = [];
        } else if (data.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
          else peer.pending.push(data.candidate);
        }
      } catch (e) { console.warn('duo signal', e); }
    }

    // Смена своей видеодорожки (маска, другая камера) — во всех соединениях
    async function replaceVideo(track) {
      for (const { pc } of peers.values()) {
        const s = pc.getSenders().find(x => x.track?.kind === 'video');
        await s?.replaceTrack(track).catch(() => {});
      }
      const mine = grid.querySelector('.duo-tile.me video');
      if (mine) { mine.srcObject = new MediaStream([track]); mine.play().catch(() => {}); }
    }

    function tileOf(slot) { return peers.get(slot)?.tile || null; }

    function stop() {
      for (const p of peers.values()) {
        p.pc.ontrack = p.pc.onicecandidate = p.pc.onconnectionstatechange = null;
        p.pc.close();
      }
      peers.clear();
      grid.replaceChildren();
      grid.hidden = true;
      you = null;
      onAllGone?.();
    }

    return { start, stop, onSignal, replaceVideo, tileOf, get active() { return you !== null; } };
  }

  return { create };
})();
