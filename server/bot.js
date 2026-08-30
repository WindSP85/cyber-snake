/* ============================================================
   NEON://SNAKE — Telegram-бот на VPS (long polling)
   Замена Supabase Edge Function: никаких вебхуков и секретов
   в панели — процесс сам забирает обновления getUpdates.

   Команды:
   - /start (или любое «start») — приветствие + кнопка «▶ ИГРАТЬ»
   - /top — топ-5 текущего сезона
   - любой другой текст — подсказка

   Если api.telegram.org недоступен с VPS (бывает на хостинге
   в РФ) — бот тихо ждёт и перепроверяет доступность раз в 5
   минут; API игры и дуэли работают независимо.
   ============================================================ */
'use strict';

const https = require('https');

const RETRY_MIN = 3000;     // пауза между попытками при сетевой ошибке
const RETRY_MAX = 60000;    // потолок экспоненциальной паузы
const IDLE_RECHECK = 300000; // повторная проверка доступности, мс (5 мин)

const WELCOME =
  '⚡ NEON://SNAKE — киберпанк-змейка с боссами и онлайн-дуэлями!\n\n' +
  '▶ Жми кнопку внизу — и в бой.\n' +
  '🏆 /top — топ сезона\n' +
  '⚔ Онлайн-бой → «Позвать в бой» — позови друга из любого чата.';

const HELP =
  'Я живой 🙂 Команды: /top — топ сезона. Игра — кнопка внизу.';

/* ---------- HTTP в одну строку без зависимостей ---------- */

function post(token, method, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const payload = JSON.stringify(body || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + token + '/' + method,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, function (res) {
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
    log('bot: api.telegram.org недоступен, повторю позже');
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
