// PWA: service worker + подготовка установки и пушей.
(function () {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });

  // Событие установки: сохраняем, чтобы кнопка «Установить» могла его вызвать.
  var deferred = null;
  window.AuraPWA = {
    canInstall: function () { return !!deferred; },
    install: function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; });
    },
    // Почва для веб-пушей: подписка отдельной задачей, здесь только хелпер.
    pushSubscribe: function (applicationServerKey) {
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey });
      });
    }
  };
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    window.dispatchEvent(new CustomEvent('aura-install-available'));
  });
})();
