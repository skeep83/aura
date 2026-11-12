// Service Worker Aura: сеть в приоритете, кэш только как запасной путь для статики.
// WebRTC-приложение: ничего агрессивно не кешируем, чтобы не ломать обновления.
var CACHE = 'aura-shell-v1';
var SHELL = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (/^\/(api|s|ws)\b/.test(url.pathname)) return; // бэкенд не трогаем
  e.respondWith(
    fetch(req).then(function (res) {
      if (res.ok && (url.pathname === '/' || /\.(js|css|png|svg|webp|json)$/.test(url.pathname))) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return caches.match(req); })
  );
});

// Веб-пуши (подключаются отдельной задачей): показ готов, подписка — на стороне приложения.
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  if (!data.title) return;
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-96.png', data: data.url || '/'
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data || '/'));
});
