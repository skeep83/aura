// HOM-36 приёмка: анонимный веб-вход с webSrc=test_manual (как переход по ?src=test_manual)
import WebSocket from 'ws';
const ws = new WebSocket('wss://aura-life.online/ws');
const devId = 'web-h36-probe-' + Math.random().toString(36).slice(2, 8);
ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', initData: '', devId, tz: -180, lang: 'ru', platform: 'web', webSrc: 'test_manual', webRef: '' })));
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.t === 'ready') { console.log('READY devId=' + devId + ' shareLink=' + m.me.shareLink); setTimeout(() => process.exit(0), 300); }
  if (m.t === 'banned') { console.log('BANNED'); process.exit(1); }
});
ws.on('close', c => { console.log('CLOSE', c); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 15000);
