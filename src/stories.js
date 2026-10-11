import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Карточки результатов игр для публикации в Telegram Stories.
// shareToStory принимает только публичный URL, поэтому картинка ненадолго хранится на сервере.
const MAX_BYTES = 2 * 1024 * 1024;
const TTL_MS = 48 * 60 * 60 * 1000;
const TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png' };

export class StoryStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    setInterval(() => this.cleanup(), 60 * 60 * 1000).unref();
  }

  // Принимает тело запроса, возвращает имя файла или бросает ошибку с кодом HTTP
  async save(req) {
    const ext = TYPES[(req.headers['content-type'] || '').split(';')[0]];
    if (!ext) throw Object.assign(new Error('bad type'), { status: 415 });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BYTES) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(chunk);
    }
    const name = crypto.randomBytes(12).toString('hex') + ext;
    await fs.promises.writeFile(path.join(this.dir, name), Buffer.concat(chunks));
    return name;
  }

  file(name) {
    if (!/^[a-f0-9]{24}\.(jpg|png)$/.test(name)) return null;
    return path.join(this.dir, name);
  }

  cleanup(now = Date.now()) {
    for (const f of fs.readdirSync(this.dir)) {
      const p = path.join(this.dir, f);
      try { if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p); } catch {}
    }
  }
}
