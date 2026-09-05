/* ============================================================
   NEON://SNAKE — service worker (PWA офлайн-кэш)
   Стратегия: сеть-в-приоритете (network-first) для своей оболочки —
   игроки всегда получают свежую версию при онлайне; кэш — фолбэк
   на случай офлайна. Игровой сервер и Telegram — всегда мимо кэша.
   Отдельная оболочка обновляется на второй перезагрузке после
   деплоя (первая — скачивает новый sw.js, вторая — служит свежим).
   ============================================================ */
'use strict';

const VERSION = 'v7';
const CACHE = 'neon-snake-' + VERSION;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './css/style.css',
  './js/config.js',
  './js/i18n.js',
  './js/audio.js',
  './js/bosses.js',
  './js/fx.js',
  './js/leaderboard.js',
  './js/telegram.js',
  './js/net.js',
  './js/achievements.js',
  './js/skins.js',
  './js/upgrades.js',
  './js/daily.js',
  './js/quests.js',
  './js/duel.js',
  './js/duelui.js',
  './js/ui.js',
  './js/game.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  const url = e.request.url;
  if (e.request.method !== 'GET' ||
      url.indexOf(self.location.origin) !== 0) return;
  e.respondWith(
    fetch(e.request).then(function (resp) {
      // свежий ответ — обновляем кэш в фоне
      const copy = resp.clone();
      caches.open(CACHE).then(function (c) {
        c.put(e.request, copy);
      });
      return resp;
    }).catch(function () {
      // офлайн: отдаём последнее известное
      return caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
        return hit || caches.match('./index.html');
      });
    })
  );
});
