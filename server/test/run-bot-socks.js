/* ============================================================
   NEON://SNAKE — тест SOCKS5-пути бота (запуск: node server/test/run-bot-socks.js)
   Поднимает:
     - мок SOCKS5-прокси (127.0.0.1:9101): проверяет рукопожатие
       и CONNECT, соединяет с «Telegram»
     - мок Telegram API (127.0.0.1:9102, HTTPS, self-signed):
       отвечает на deleteWebhook/getUpdates
   И запускает НАСТОЯЩИЙ server/bot.js через оба мока — бот должен
   пройти deleteWebhook и уйти в цикл getUpdates, всё через прокси.
   ============================================================ */
'use strict';

process.env.TG_API_HOST = '127.0.0.1';
process.env.TG_API_PORT = '9102';
process.env.WARP_PROXY_HOST = '127.0.0.1';
process.env.WARP_PROXY_PORT = '9101';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed мока, только тест

const https = require('https');
const net = require('net');
const fs = require('fs');
const { run } = require('crypto');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name); console.log('  ✗ ' + name); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* ---------- сертификат: статическая фикстура (одноразовая, только
     для localhost-моков; секретной ценности не имеет) ---------- */
const TMP = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'bot-socks-'));
const FIXTURES = require('path').join(__dirname, 'fixtures');
if (!fs.existsSync(require('path').join(FIXTURES, 'mock-cert.pem'))) {
  console.log('нет фикстуры mock-cert.pem — тест пропущен');
  process.exit(0);
}

const sawHandshake = { greeting: false, connect: false, domain: '' };
const sawApi = { deleteWebhook: false, getUpdates: 0 };

/* ---------- мок Telegram API ---------- */
const apiServer = https.createServer({
  key: fs.readFileSync(require('path').join(FIXTURES, 'mock-key.pem')),
  cert: fs.readFileSync(require('path').join(FIXTURES, 'mock-cert.pem'))
}, function (req, res) {
  if (req.url.indexOf('/deleteWebhook') !== -1) sawApi.deleteWebhook = true;
  if (req.url.indexOf('/getUpdates') !== -1) sawApi.getUpdates++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true,"result":[]}');
});

/* ---------- мок SOCKS5 ---------- */
const socksServer = net.createServer(function (client) {
  let stage = 0;
  client.on('data', function (chunk) {
    if (stage === 0) {
      if (chunk[0] === 0x05 && chunk[1] === 0x01 && chunk[2] === 0x00) {
        sawHandshake.greeting = true;
        client.write(Buffer.from([0x05, 0x00]));
        stage = 1;
      } else {
        client.destroy();
      }
      return;
    }
    if (stage === 1 && chunk[0] === 0x05 && chunk[1] === 0x01 && chunk[3] === 0x03) {
      const dlen = chunk[4];
      sawHandshake.connect = true;
      sawHandshake.domain = chunk.slice(5, 5 + dlen).toString('utf8');
      // успешный ответ: VER REP=0 RSV ATYP=1 ADDR(4) PORT(2)
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      // мостик до «Telegram»: ПРОЗРАЧНЫЙ TCP — бот сам несёт TLS
      // через туннель, второй слой здесь всё бы сломал
      const up = net.connect({ host: '127.0.0.1', port: 9102 }, function () {
        up.pipe(client);
        client.pipe(up);
      });
      up.on('error', function () { client.destroy(); });
      stage = 2;
    }
  });
  client.on('error', function () { /* клиент ушёл */ });
});

async function tests() {
  await new Promise(function (r) { apiServer.listen(9102, '127.0.0.1', r); });
  await new Promise(function (r) { socksServer.listen(9101, '127.0.0.1', r); });

  const logs = [];
  const log = function (m) { logs.push(m); };

  /* пустое хранилище для /top */
  const Store = require('../store.js');
  const store = new Store(TMP);
  const bot = require('../bot.js');

  bot.runBot({ token: '123456:test-token', gameUrl: 'https://example.com/', store: store, log: log })
    .catch(function () { /* цикл не должен падать */ });

  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    if (sawApi.getUpdates >= 2) break;
    await sleep(150);
  }

  ok(sawHandshake.greeting, 'SOCKS5: рукопожатие по протоколу');
  ok(sawHandshake.connect, 'SOCKS5: CONNECT-запрос корректен');
  ok(sawHandshake.domain === '127.0.0.1', 'SOCKS5: адресат передан верно (' + sawHandshake.domain + ')');
  ok(sawApi.deleteWebhook, 'бот прошёл deleteWebhook через прокси');
  ok(sawApi.getUpdates >= 2, 'бот в цикле getUpdates (шагов: ' + sawApi.getUpdates + ')');
  ok(!logs.some(function (l) { return l.indexOf('недоступен') !== -1; }), 'бот не жаловался на сеть');

  if (failed) console.log('логи бота: ' + logs.join(' | '));
  console.log('\n========================================');
  console.log('Пройдено: ' + passed + '  Провалено: ' + failed);
  process.exit(failed ? 1 : 0);
}

tests().catch(function (e) {
  console.error('ТЕСТ УПАЛ:', e);
  process.exit(1);
});
