// Покадровый рендер видеокреатива (branding/src/ad-video.html) через Chrome DevTools Protocol.
//   node branding/render-video.mjs <lang> <story|square> <outDir>   → кадры JPEG 30 к/с, 12 с
// Сборка в MP4 — ffmpeg (см. branding/ads/README.md).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const [lang = 'ru', fmt = 'story', out = 'frames'] = process.argv.slice(2);
const FPS = 30, SECONDS = 12;
const W = 540, H = fmt === 'square' ? 540 : 960;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const page = 'file://' + path.resolve('branding/src/ad-video.html') + `?lang=${lang}&fmt=${fmt}&t=0`;
fs.mkdirSync(out, { recursive: true });

const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
  `--user-data-dir=/tmp/aura-render-${port}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));
let id = 0;
const pending = new Map();
ws.on('message', m => { const d = JSON.parse(m); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const cdp = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await cdp('Page.enable');
await cdp('Page.navigate', { url: page });
await sleep(1500);
const total = FPS * SECONDS;
for (let f = 0; f < total; f++) {
  await cdp('Runtime.evaluate', { expression: `render(${(f / FPS).toFixed(4)})` });
  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  fs.writeFileSync(path.join(out, `${String(f).padStart(4, '0')}.jpg`), Buffer.from(shot.result.data, 'base64'));
}
ws.close();
chrome.kill();
console.log(`${lang}-${fmt}: ${total} кадров → ${out}`);
