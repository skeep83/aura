// Режим маски: собеседник видит вместо лица эмодзи, а если лицо не найдено — размытый кадр.
// Кадры рисуются в canvas, и в звонок уходит дорожка canvas вместо камеры.
// Модерация продолжает получать настоящие кадры камеры (см. sendFrame в app.js).
window.AuraMask = {
  create({ getRawVideo }) {
    const EMOJI = ['🦊', '🐼', '😎', '👽', '🐯', '🤖', '🐸', '🦄', '🐵', '🐨'];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 480; canvas.height = 640;
    const track = canvas.captureStream(20).getVideoTracks()[0];
    let active = false;
    let landmarker = null;
    let emoji = EMOJI[0];
    let last = null; // последняя найденная рамка, чтобы маска не мигала

    function draw() {
      if (!active) return;
      const v = getRawVideo();
      if (!v || !v.videoWidth) return;
      const w = 480, h = Math.round(w * v.videoHeight / v.videoWidth);
      if (canvas.height !== h) canvas.height = h;

      let face = null;
      if (landmarker) { try { face = window.AuraFace.detect(landmarker, v); } catch {} }
      if (face) last = { box: face.box, at: performance.now() };
      const box = face?.box || (last && performance.now() - last.at < 400 ? last.box : null);

      if (box) {
        ctx.drawImage(v, 0, 0, w, h);
        const cx = (box.x + box.w / 2) * w, cy = (box.y + box.h / 2) * h;
        const size = Math.max(box.w * w, box.h * h) * 1.45;
        ctx.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(emoji, cx, cy + size * 0.06);
      } else {
        // Лица не видно или модель ещё грузится — прячем весь кадр
        ctx.filter = 'blur(28px)';
        ctx.drawImage(v, -20, -20, w + 40, h + 40);
        ctx.filter = 'none';
        ctx.font = `${w * 0.45}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(emoji, w / 2, h / 2);
      }
    }
    setInterval(draw, 50);

    return {
      track,
      get active() { return active; },
      enable() {
        emoji = EMOJI[Math.floor(Math.random() * EMOJI.length)];
        active = true;
        draw();
        window.AuraFace.load().then(lm => { landmarker = lm; }).catch(() => {});
      },
      disable() { active = false; },
    };
  },
};
