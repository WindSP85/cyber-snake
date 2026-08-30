/* ============================================================
   NEON://SNAKE — тест закрепления IP (TG_API_IP): DNS-подмена
   должна направить TCP на указанный адрес, сохранив hostname/SNI
   api.telegram.org (мок отвечает на 127.0.0.1).
   Запуск: node server/test/run-bot-pin.js
   ============================================================ */
'use strict';

process.env.TG_API_HOST = 'api.telegram.org';
process.env.TG_API_PORT = '9112';
process.env.TG_API_IP = '127.0.0.1';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed мока

const https = require('https');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name); console.log('  ✗ ' + name); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

const saw = { requests: 0, host: '', path: '' };

const server = https.createServer({
  key: fs.readFileSync(path.join(__dirname, 'fixtures', 'mock-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'mock-cert.pem'))
}, function (req, res) {
  saw.requests++;
  saw.host = req.headers.host || '';
  saw.path = req.url || '';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true,"result":[]}');
});

async function tests() {
  await new Promise(function (r) { server.listen(9112, '127.0.0.1', r); });

  const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bot-pin-'));
  const Store = require('../store.js');
  const bot = require('../bot.js');
  const logs = [];
  bot.runBot({ token: '123456:test', gameUrl: 'https://example.com/',
               store: new Store(TMP), log: function (m) { logs.push(m); } })
    .catch(function () { /* цикл не должен падать */ });

  const t0 = Date.now();
  while (Date.now() - t0 < 10000 && saw.requests < 2) await sleep(150);

  ok(saw.requests >= 2, 'бот дошёл до мока через закреплённый IP (запросов: ' + saw.requests + ')');
  ok(saw.host.indexOf('api.telegram.org') === 0, 'Host остался api.telegram.org: ' + saw.host);
  ok(saw.path.indexOf('/bot123456:test/') === 0, 'путь API сохранён: ' + saw.path);
  ok(!logs.some(function (l) { return l.indexOf('недоступен') !== -1; }), 'без сетевых жалоб');

  if (failed) console.log('логи: ' + logs.join(' | '));
  console.log('\nПройдено: ' + passed + '  Провалено: ' + failed);
  process.exit(failed ? 1 : 0);
}

tests().catch(function (e) {
  console.error('ТЕСТ УПАЛ:', e);
  process.exit(1);
});
