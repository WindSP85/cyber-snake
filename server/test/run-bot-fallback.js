/* ============================================================
   NEON://SNAKE — тест резервных маршрутов бота (TG_API_IP список):
   первый адрес «мёртв» (127.0.0.2), бот обязан после сбоя уйти на
   второй (127.0.0.1, там мок Telegram) и продолжить опрос.
   Запуск: node server/test/run-bot-fallback.js
   ============================================================ */
'use strict';

process.env.TG_API_HOST = 'api.telegram.org';
process.env.TG_API_PORT = '9113';
process.env.TG_API_IP = '127.0.0.2,127.0.0.1'; // первый дохлый, второй живой
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

const saw = { requests: 0, host: '' };
const server = https.createServer({
  key: fs.readFileSync(path.join(__dirname, 'fixtures', 'mock-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'mock-cert.pem'))
}, function (req, res) {
  saw.requests++;
  saw.host = req.headers.host || '';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true,"result":[]}');
});

async function tests() {
  /* слушаем ТОЛЬКО 127.0.0.1 — 127.0.0.2:9113 отвергается сразу */
  await new Promise(function (r) { server.listen(9113, '127.0.0.1', r); });

  const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bot-fb-'));
  const Store = require('../store.js');
  const bot = require('../bot.js');
  const logs = [];
  bot.runBot({ token: '123456:test', gameUrl: 'https://example.com/',
               store: new Store(TMP), log: function (m) { logs.push(m); } })
    .catch(function () { /* цикл не должен падать */ });

  /* deleteWebhook по мёртвому адресу уйдёт в catch, затем цикл
     getUpdates повторит уже по живому; даём времени на оба круга */
  const t0 = Date.now();
  while (Date.now() - t0 < 12000 && saw.requests < 2) await sleep(150);

  ok(saw.requests >= 2, 'бот дошёл до живого адреса (запросов: ' + saw.requests + ')');
  ok(saw.host.indexOf('api.telegram.org') === 0, 'hostname сохранился: ' + saw.host);
  const fails = logs.filter(function (l) { return l.indexOf('недоступен') !== -1 || l.indexOf('пауза') !== -1; }).length;
  ok(fails >= 1 && fails <= 3, 'сбой первого адреса зафиксирован (сбоев: ' + fails + '), затем работа пошла');
  ok(logs.some(function (l) { return l.indexOf('deleteWebhook → 200') !== -1; }) ||
     saw.requests >= 2, 'после переключения запросы успешны');

  if (failed) console.log('логи: ' + logs.slice(0, 6).join(' | '));
  console.log('\nПройдено: ' + passed + '  Провалено: ' + failed);
  process.exit(failed ? 1 : 0);
}

tests().catch(function (e) {
  console.error('ТЕСТ УПАЛ:', e);
  process.exit(1);
});
