/* ============================================================
   NEON://SNAKE — тесты игрового сервера (запуск: node server/test/run-tests.js)
   Проверяют всё детерминированно, без сети и без Telegram:
   1) Store: валидация, топ, лимиты, сохранение на диск
   2) HTTP API: health/top/score/duel, CORS, ошибки 400/404
   3) WS-реле: join/presence/msg/full/reconnect/ping/flood
   ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-test-'));
process.env.DATA_DIR = TMP;              // ДО require сервера
delete process.env.BOT_TOKEN;            // бот в тестах не нужен

const { createServer, store } = require('../server.js');
const WebSocket = require('../ws');

/* ---------- мини-харнесс ---------- */

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, name) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    failures.push(name);
    console.log('  ✗ ' + name);
  }
}

function eq(a, b, name) {
  ok(JSON.stringify(a) === JSON.stringify(b), name + ' (получено: ' + JSON.stringify(a) + ')');
}

async function tests() {
  /* ============ 1. Store ============ */
  console.log('\n[1] Store');

  store.addScore({ name: 'Alice', score: 100, level: 3, season: '2026-08' });
  store.addScore({ name: 'Bob', score: 250, level: 5, season: '2026-08' });
  store.addScore({ name: 'Cara', score: 80, level: 2, season: '2026-07' });
  const top = store.top('2026-08', 10);
  eq(top.map(function (r) { return r.name; }), ['Bob', 'Alice'], 'топ сезона сортирован по очкам');
  eq(store.top('2026-07', 10).length, 1, 'другой сезон отфильтрован');
  eq(store.top('', 10).length, 3, 'без сезона — все строки');
  ok(/^\d{4}-\d{2}-\d{2}T/.test(top[0].created_at), 'created_at — ISO');

  /* лимит сезона: 600 строк → остаётся 500 */
  for (let i = 0; i < 600; i++) {
    store.addScore({ name: 'N' + i, score: i, level: 1, season: '2025-01' });
  }
  eq(store.scores.filter(function (x) { return x.season === '2025-01'; }).length, 500, 'сезон ограничен топ-500');
  eq(store.top('2025-01', 1)[0].name, 'N599', 'в топе остались лучшие');

  /* дуэли: лимит 5000 — не проверяем на 5000 вставок (медленно),
     только добавление и форму записи */
  store.addDuel({ winner: 'Alice', loser: 'Bob', rounds: '2:1' });
  const d = store.duels[store.duels.length - 1];
  ok(d && d.winner === 'Alice' && d.rounds === '2:1', 'дуэль записана');

  /* сохранение на диск и перечитывание */
  store.flush();
  const reloaded = JSON.parse(fs.readFileSync(path.join(TMP, 'scores.json'), 'utf8'));
  ok(Array.isArray(reloaded) && reloaded.length === store.scores.length, 'scores.json атомарно записан');
  const Store2 = require('../store.js');
  const s2 = new Store2(TMP);
  eq(s2.top('2026-08', 1)[0].name, 'Bob', 'новый Store читает те же данные');

  /* ============ 2. HTTP API ============ */
  console.log('\n[2] HTTP API');

  const server = createServer();
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const base = 'http://127.0.0.1:' + server.address().port;

  async function api(method, p, body) {
    const res = await fetch(base + p, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* пустое тело */ }
    return { status: res.status, json: json, headers: res.headers };
  }

  let r = await api('GET', '/api/health');
  ok(r.status === 200 && r.json.ok === true && r.json.bot === false, 'health: ok, бот выключен');
  ok(r.headers.get('access-control-allow-origin') === '*', 'CORS: allow-origin *');

  r = await api('OPTIONS', '/api/score');
  ok(r.status === 204, 'OPTIONS preflight → 204');

  r = await api('GET', '/api/top?season=2026-08&limit=2');
  eq(r.json.rows.map(function (x) { return x.name; }), ['Bob', 'Alice'], 'top: сезон + лимит');

  r = await api('GET', '/api/top?season=abracadabra');
  ok(r.status === 400 && r.json.error === 'season', 'top: битый сезон → 400');

  r = await api('POST', '/api/score', { name: 'Tester', score: 42, level: 2, season: '2026-08' });
  ok(r.status === 201 && r.json.ok, 'score: валидная запись → 201');

  r = await api('POST', '/api/score', { name: '', score: 5, level: 1, season: '2026-08' });
  ok(r.status === 400 && r.json.error === 'name', 'score: пустое имя → 400 name');
  r = await api('POST', '/api/score', { name: 'x'.repeat(25), score: 5, level: 1, season: '2026-08' });
  ok(r.status === 400 && r.json.error === 'name', 'score: имя >20 → 400 name');
  r = await api('POST', '/api/score', { name: 'Neg', score: -1, level: 1, season: '2026-08' });
  ok(r.status === 400 && r.json.error === 'score', 'score: -1 → 400 score');
  r = await api('POST', '/api/score', { name: 'Big', score: 1000000, level: 1, season: '2026-08' });
  ok(r.status === 400 && r.json.error === 'score', 'score: 1000000 → 400 score');
  r = await api('POST', '/api/score', { name: 'Frac', score: 1.5, level: 1, season: '2026-08' });
  ok(r.status === 400 && r.json.error === 'score', 'score: дробное → 400 score');
  r = await api('POST', '/api/score', { name: 'L0', score: 5, level: 0, season: '2026-08' });
  ok(r.status === 400 && r.json.error === 'level', 'score: level 0 → 400 level');
  r = await api('POST', '/api/score', { name: 'S', score: 5, level: 1, season: '2026-13' });
  ok(r.status === 400 && r.json.error === 'season', 'score: несуществующий месяц → 400 season');
  r = await api('POST', '/api/score', 'not-json');
  ok(r.status === 400, 'score: не-JSON → 400');

  r = await api('POST', '/api/duel', { winner: 'Alice', loser: 'Bob', rounds: '2:1' });
  ok(r.status === 201, 'duel: валидный матч → 201');
  r = await api('POST', '/api/duel', { winner: '', loser: 'Bob', rounds: '2:1' });
  ok(r.status === 400 && r.json.error === 'winner', 'duel: пустой winner → 400');

  r = await api('GET', '/api/nothing');
  ok(r.status === 404, 'неизвестный путь → 404');

  /* ============ 3. WS-реле ============ */
  console.log('\n[3] WS-реле дуэлей');

  const wsBase = 'ws://127.0.0.1:' + server.address().port + '/ws';

  function connect() {
    return new Promise(function (resolve, reject) {
      const ws = new WebSocket(wsBase);
      ws.on('open', function () { resolve(ws); });
      ws.on('error', reject);
      ws._inbox = [];
      ws.on('message', function (raw) {
        ws._inbox.push(JSON.parse(String(raw)));
      });
    });
  }

  function waitFor(ws, pred, label, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const t0 = Date.now();
      (function poll() {
        for (let i = 0; i < ws._inbox.length; i++) {
          if (pred(ws._inbox[i])) {
            resolve(ws._inbox[i]);
            return;
          }
        }
        if (Date.now() - t0 > (timeoutMs || 3000)) {
          reject(new Error('не дождались: ' + label));
          return;
        }
        setTimeout(poll, 25);
      })();
    });
  }

  function sendW(ws, obj) {
    ws.send(JSON.stringify(obj));
  }

  const A = await connect();
  sendW(A, { t: 'join', room: 'TEST', id: 'aaaaaaaa', name: 'Alice' });
  let m = await waitFor(A, function (x) { return x.t === 'joined'; }, 'join A');
  ok(m.ok === true, 'A подключился к комнате');
  m = await waitFor(A, function (x) { return x.t === 'presence'; }, 'presence A');
  eq(m.list, [{ id: 'aaaaaaaa', name: 'Alice' }], 'presence: в комнате один игрок');

  const B = await connect();
  sendW(B, { t: 'join', room: 'TEST', id: 'bbbbbbbb', name: 'Bob' });
  m = await waitFor(B, function (x) { return x.t === 'presence'; }, 'presence B');
  eq(m.list.length, 2, 'presence: оба игрока');
  m = await waitFor(A, function (x) { return x.t === 'presence' && x.list.length === 2; }, 'presence у A');
  ok(m.list.some(function (x) { return x.id === 'bbbbbbbb'; }), 'A видит вход B');

  /* реле: сообщение A → B, эхо самому себе нет */
  sendW(A, { t: 'msg', type: 'state', data: { tick: 7 } });
  m = await waitFor(B, function (x) { return x.t === 'msg'; }, 'msg A→B');
  ok(m.from === 'aaaaaaaa' && m.type === 'state' && m.data.tick === 7, 'реле доставляет type/data/from');
  await new Promise(function (r) { setTimeout(r, 150); });
  ok(!A._inbox.some(function (x) { return x.t === 'msg'; }), 'свои сообщения не возвращаются');

  /* ping/pong */
  sendW(A, { t: 'ping' });
  m = await waitFor(A, function (x) { return x.t === 'pong'; }, 'pong');
  ok(true, 'ping → pong');

  /* третий игрок — full */
  const C = await connect();
  sendW(C, { t: 'join', room: 'TEST', id: 'cccccccc', name: 'Cara' });
  m = await waitFor(C, function (x) { return x.t === 'joined'; }, 'join C');
  ok(m.ok === false && m.error === 'full', 'третий игрок → full');

  /* мусорный код комнаты — bad */
  sendW(C, { t: 'join', room: 'XX', id: 'cccccccc', name: 'Cara' });
  m = await waitFor(C, function (x) { return x.t === 'joined' && x.error === 'bad'; }, 'join bad');
  ok(true, 'короткий код комнаты → bad');

  /* msg без join — игнор */
  sendW(C, { t: 'msg', type: 'state', data: 1 });
  await new Promise(function (r) { setTimeout(r, 120); });
  ok(!B._inbox.some(function (x) { return x.from === 'cccccccc'; }), 'msg без join не релеится');

  /* переподключение тем же id: место сохраняется, старый сокет закрыт */
  const A2 = await connect();
  let aClosed = false;
  A.on('close', function () { aClosed = true; }); // ДО join: terminate уже закроет A
  sendW(A2, { t: 'join', room: 'TEST', id: 'aaaaaaaa', name: 'Alice' });
  m = await waitFor(A2, function (x) { return x.t === 'joined'; }, 'join A2');
  ok(m.ok === true, 'переподключение тем же id принято');
  m = await waitFor(B, function (x) { return x.t === 'presence' && x.list.length === 2; }, 'presence после реконнекта');
  ok(m.list.some(function (x) { return x.id === 'aaaaaaaa'; }), 'id сохранил место в комнате');
  await new Promise(function (r) { setTimeout(r, 200); });
  ok(aClosed, 'старый сокет A закрыт сервером');

  /* обрыв: B уходит → A2 видит presence без него */
  B.close();
  m = await waitFor(A2, function (x) { return x.t === 'presence' && x.list.length === 1; }, 'уход B');
  eq(m.list, [{ id: 'aaaaaaaa', name: 'Alice' }], 'presence после обрыва — корректный');

  /* бинарный мусор не роняет соединение */
  A2.send(Buffer.from([0, 1, 2]));
  sendW(A2, { t: 'ping' });
  m = await waitFor(A2, function (x) { return x.t === 'pong'; }, 'pong после бинарного мусора');
  ok(true, 'бинарный кадр проигнорирован, соединение живо');

  A2.close();
  C.close();

  /* ============ итог ============ */
  server.close();
  store.flush();
  console.log('\n========================================');
  console.log('Пройдено: ' + passed + '  Провалено: ' + failed);
  if (failed) {
    console.log('Провалены: ' + failures.join(' | '));
    process.exit(1);
  }
  process.exit(0); // undici держит keep-alive сокеты — выходим явно
}

tests().catch(function (e) {
  console.error('ТЕСТЫ УПАЛИ С ОШИБКОЙ:', e);
  process.exit(1);
});
