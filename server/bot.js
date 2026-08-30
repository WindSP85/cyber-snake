/* ============================================================
   NEON://SNAKE — Telegram-бот на VPS (long polling)
   Никаких вебхуков и панелей: процесс сам забирает обновления
   getUpdates.

   Команды:
   - /start (или любое «start») — приветствие + кнопка «▶ ИГРАТЬ»
   - /top — топ-5 текущего сезона
   - любой другой текст — подсказка

   Обход блокировки api.telegram.org на РФ-хостинге: Cloudflare
   WARP на хосте работает SOCKS5-прокси (режим proxy не меняет
   маршрутизацию сервера), бот ходит в Telegram через него.
   Переменные: WARP_PROXY_HOST + WARP_PROXY_PORT (пустые = напрямую).

   Если Telegram всё же недоступен — бот тихо ждёт и перепроверяет;
   API игры и дуэли работают независимо.
   ============================================================ */
'use strict';

const https = require('https');
const net = require('net');

const API_HOST = process.env.TG_API_HOST || 'api.telegram.org';
const API_PORT = Number(process.env.TG_API_PORT) || 443;
const API_IP = process.env.TG_API_IP || '';   // обход блокировки части
                                              // диапазона Telegram у провайдера
const PROXY_HOST = process.env.WARP_PROXY_HOST || '';
const PROXY_PORT = Number(process.env.WARP_PROXY_PORT) || 0;
const USE_PROXY = !!PROXY_HOST && !!PROXY_PORT;

/* DNS-подмена для исходящего соединения: hostname/SNI/сертификат
   остаются api.telegram.org, а TCP идёт на закреплённый IP */
function pinnedLookup(host, opts, cb) {
  if (API_IP && host === API_HOST) {
    cb(null, [{ address: API_IP, family: 4 }]);
    return;
  }
  const dns = require('dns');
  dns.lookup(host, opts, cb);
}

const RETRY_MIN = 3000;     // пауза между попытками при сетевой ошибке
const RETRY_MAX = 60000;    // потолок экспоненциальной паузы

const WELCOME =
  '⚡ NEON://SNAKE — киберпанк-змейка с боссами и онлайн-дуэлями!\n\n' +
  '▶ Жми кнопку внизу — и в бой.\n' +
  '🏆 /top — топ сезона\n' +
  '⚔ Онлайн-бой → «Позвать в бой» — позови друга из любого чата.';

const HELP =
  'Я живой 🙂 Команды: /top — топ сезона. Игра — кнопка внизу.';

/* ---------- SOCKS5 без зависимостей (рукопожатие + CONNECT) ----------
   Возвращает ГОЛЫЙ сокет до API_HOST:443; TLS поверх него делает
   сам https.request через createConnection — сертификат
   api.telegram.org проверяется как обычно. */

function socks5Connect(cb) {
  let stage = 0;
  const sock = net.connect(PROXY_PORT, PROXY_HOST);
  const fail = function (err) {
    cleanup();
    cb(err);
  };
  const cleanup = function () {
    sock.removeAllListeners('data');
    sock.removeAllListeners('error');
    try { sock.destroy(); } catch (e) { /* уже мёртв */ }
  };
  sock.once('error', function (err) { fail(err); });
  sock.once('connect', function () {
    // приветствие: версия 5, один метод — без аутентификации
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
  });
  sock.on('data', function onData(chunk) {
    if (stage === 0) {
      if (chunk.length < 2 || chunk[0] !== 0x05) {
        fail(new Error('socks: плохое приветствие'));
        return;
      }
      if (chunk[1] !== 0x00) {
        fail(new Error('socks: прокси требует аутентификацию'));
        return;
      }
      // запрос CONNECT к домену (тип адреса 3)
      const host = Buffer.from(API_HOST, 'utf8');
      const req = Buffer.alloc(7 + host.length);
      req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
      req[4] = host.length;
      host.copy(req, 5);
      req.writeUInt16BE(API_PORT, 5 + host.length);
      sock.write(req);
      stage = 1;
      return;
    }
    // ответ CONNECT: VER REP RSV ATYP ...
    if (chunk.length < 4 || chunk[1] !== 0x00) {
      fail(new Error('socks: connect отклонён (' + (chunk[1] | 0) + ')'));
      return;
    }
    sock.removeAllListeners('data');
    sock.removeAllListeners('error');
    cb(null, sock);
  });
}

/* TLS-сокет через прокси: https.request с createConnection НЕ делает
   TLS сам — эта опция заменяет транспорт целиком, поэтому обертываем
   туннель сами; сертификат api.telegram.org проверяется как обычно */
function proxySocket() {
  return new Promise(function (resolve, reject) {
    socks5Connect(function (err, sock) {
      if (err) {
        reject(err);
        return;
      }
      const tls = require('tls');
      const tlsSock = tls.connect({ socket: sock, servername: API_HOST }, function () {
        resolve(tlsSock);
      });
      tlsSock.once('error', function (e) {
        try { sock.destroy(); } catch (e2) { /* уже мёртв */ }
        reject(e);
      });
    });
  });
}

/* ---------- HTTP в одну строку без зависимостей ---------- */

function post(token, method, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const payload = JSON.stringify(body || {});
    const go = function (extra) {
      const req = https.request(Object.assign({
        hostname: API_HOST,
        port: API_PORT,
        path: '/bot' + token + '/' + method,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        lookup: API_IP ? pinnedLookup : undefined,
        timeout: timeoutMs
      }, extra || {}), function (res) {
        let raw = '';
        res.on('data', function (chunk) { raw += chunk; });
        res.on('end', function () {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(raw) });
          } catch (e) {
            resolve({ status: res.statusCode, json: null });
          }
        });
      });
      req.on('timeout', function () {
        req.destroy(new Error('timeout'));
      });
      req.on('error', reject);
      req.end(payload);
    };
    if (USE_PROXY) {
      proxySocket().then(function (sock) {
        go({ createConnection: function () { return sock; } });
      }, reject);
    } else {
      go();
    }
  });
}

/* ---------- сезон ---------- */

function seasonKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

/* ---------- обработка одного сообщения ---------- */

function keyboard(gameUrl) {
  return {
    keyboard: [[{ text: '▶ ИГРАТЬ', web_app: { url: gameUrl } }]],
    resize_keyboard: true
  };
}

async function handle(token, gameUrl, store, msg) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId || !msg.text) return;
  const cmd = String(msg.text).trim().toLowerCase().split('@')[0];
  const kb = keyboard(gameUrl);

  if (cmd === '/start' || cmd === 'start') {
    await post(token, 'sendMessage', {
      chat_id: chatId, text: WELCOME, reply_markup: kb
    }, 15000);
    return;
  }

  if (cmd === '/top' || cmd === '/top5') {
    const rows = store.top(seasonKey(), 5);
    const body = rows.length
      ? rows.map(function (x, i) { return (i + 1) + '. ' + x.name + ' — ' + x.score; }).join('\n')
      : 'Пока пусто — стань первым чемпионом!';
    await post(token, 'sendMessage', {
      chat_id: chatId, text: '🏆 ТОП-5 СЕЗОНА:\n' + body, reply_markup: kb
    }, 15000);
    return;
  }

  await post(token, 'sendMessage', {
    chat_id: chatId, text: HELP, reply_markup: kb
  }, 15000);
}

/* ---------- главный цикл ---------- */

async function runBot(opts) {
  const token = opts.token;
  const gameUrl = opts.gameUrl;
  const store = opts.store;
  const log = opts.log || function () {};
  let offset = 0;
  let pause = RETRY_MIN;
  let running = true;

  /* старый вебхук (если вдруг остался) конфликтует с getUpdates —
     снимаем его при первом старте */
  try {
    const wh = await post(token, 'deleteWebhook', { drop_pending_updates: false }, 10000);
    log('bot: deleteWebhook → ' + wh.status);
  } catch (e) {
    log('bot: api.telegram.org недоступен, повторю позже (' + e.message + ')');
  }

  while (running) {
    try {
      const res = await post(token, 'getUpdates', {
        offset: offset,
        timeout: 25,
        allowed_updates: ['message']
      }, 35000);

      if (!res.json || !res.json.ok) {
        throw new Error('getUpdates failed: ' + res.status);
      }
      pause = RETRY_MIN; // сеть ожила — сбрасываем паузу

      const updates = res.json.result || [];
      for (let i = 0; i < updates.length; i++) {
        const u = updates[i];
        offset = Math.max(offset, (u.update_id || 0) + 1);
        try {
          if (u.message) await handle(token, gameUrl, store, u.message);
        } catch (e) {
          log('bot: ошибка обработки сообщения: ' + e.message);
        }
      }

      if (updates.length === 0) {
        /* long poll вернулся пусто (30 c тишины) — просто крутимся дальше */
        await new Promise(function (r) { setTimeout(r, 250); });
      }
    } catch (e) {
      log('bot: пауза ' + pause + ' мс (' + e.message + ')');
      await new Promise(function (r) { setTimeout(r, pause); });
      pause = Math.min(pause * 2, RETRY_MAX);
    }
  }
}

module.exports = { runBot: runBot };
