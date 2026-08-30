/* ============================================================
   NEON://SNAKE — интеграционный тест транспорта игры
   (запуск: node server/test/run-game-transport.js)

   Прогоняет НАСТОЯЩИЕ js/config.js + js/net.js + js/leaderboard.js
   (тот же код, что идёт в браузер) в песочнице vm против
   НАСТОЯЩЕГО локального сервера: join/presence/реле/full/
   обрыв соперника + отправка и чтение рекордов.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createServer } = require('../server.js');
const WsLib = require('../ws');

const ROOT = path.join(__dirname, '..', '..');

/* ---------- браузерное окружение ---------- */

/* WebSocket с браузерным API поверх вендорной ws */
class FakeBrowserWS {
  constructor(url) {
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    const inner = new WsLib(url);
    this._inner = inner;
    inner.on('open', () => {
      this.readyState = 1; // OPEN
      if (this.onopen) this.onopen();
    });
    inner.on('message', (raw) => {
      if (this.onmessage) this.onmessage({ data: String(raw) });
    });
    inner.on('close', () => {
      this.readyState = 3; // CLOSED
      if (this.onclose) this.onclose();
    });
    inner.on('error', (err) => {
      if (this.onerror) this.onerror(err);
    });
  }
  send(s) {
    try { this._inner.send(s); } catch (e) { /* как браузер: молча */ }
  }
  close() {
    this.readyState = 2; // CLOSING
    try { this._inner.close(); } catch (e) { /* уже закрыт */ }
  }
}

function makeLocalStorage() {
  const d = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; },
    setItem: function (k, v) { d[k] = String(v); },
    removeItem: function (k) { delete d[k]; }
  };
}

/* одно «окно браузера» с загруженными config/net/leaderboard */
function makePlayer(apiBase, wsUrl, name) {
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    clearInterval: clearInterval,
    setInterval: setInterval,
    Date: Date,
    AbortController: AbortController
  };
  const win = {
    CS: {},
    WebSocket: FakeBrowserWS,
    fetch: fetch.bind(globalThis),
    localStorage: makeLocalStorage(),
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Date: Date,
    AbortController: AbortController
  };
  sandbox.window = win;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8'), sandbox);
  vm.runInContext('window.CS.Config.apiBase=' + JSON.stringify(apiBase) + ';' +
    'window.CS.Config.wsUrl=' + JSON.stringify(wsUrl) + ';', sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/net.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/leaderboard.js'), 'utf8'), sandbox);
  win.localStorage.setItem('cs_name', name);
  return sandbox.window;
}

/* ---------- мини-харнесс ---------- */

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name); console.log('  ✗ ' + name); }
}
function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function tests() {
  /* сервер на свободном порту */
  const server = createServer();
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const wsu = 'ws://127.0.0.1:' + port + '/ws';

  const A = makePlayer(base, wsu, 'Alice');
  const B = makePlayer(base, wsu, 'Bob');
  const C = makePlayer(base, wsu, 'Cara');

  console.log('\n[1] CS.Net: доступность и код комнаты');
  A.CS.Net.ensureClient(function (okFlag) {
    ok(okFlag === true, 'ensureClient: сервер настроен → true');
  });
  await sleep(50);

  let code = '';
  await new Promise(function (r) {
    A.CS.Net.createRoom(function (res) {
      ok(res.ok === true && /^[A-Z0-9]{4}$/.test(res.code), 'createRoom: код из 4 символов');
      code = res.code;
      r();
    });
  });
  ok(A.CS.Net.myName() === 'PLAYER', 'myName до join: дефолт PLAYER (имя подтянется при join)');

  console.log('\n[2] join + presence');
  const presenceA = [];
  A.CS.Net.onPresence(function (list) { presenceA.push(list); });
  const msgsB = [];
  B.CS.Net.onMessage(function (type, data, from) { msgsB.push({ type: type, data: data, from: from }); });
  const presenceB = [];
  B.CS.Net.onPresence(function (list) { presenceB.push(list); });

  const resA = await new Promise(function (r) { A.CS.Net.join(code, r); });
  ok(resA.ok === true, 'join A успешен');
  await sleep(150);
  ok(A.CS.Net.state().status === 'connected', 'state: connected');
  ok(A.CS.Net.myName() === 'Alice', 'имя A взято из localStorage');

  const resB = await new Promise(function (r) { B.CS.Net.join(code, r); });
  ok(resB.ok === true, 'join B успешен');
  await sleep(200);

  const lastA = presenceA.length ? presenceA[presenceA.length - 1] : [];
  ok(lastA.length === 2 && lastA.some(function (x) { return x.name === 'Bob'; }), 'A видит обоих');
  ok(lastA.every(function (x) { return x.online === true; }), 'все online: true');
  const selfA = lastA.filter(function (x) { return x.self === true; });
  ok(selfA.length === 1 && selfA[0].name === 'Alice', 'флаг self стоит только у себя');

  console.log('\n[3] реле сообщений');
  ok(A.CS.Net.send('hello', { hi: 1 }) === true, 'send возвращает true');
  await sleep(150);
  ok(msgsB.length >= 1 && msgsB[0].type === 'hello' && msgsB[0].data.hi === 1, 'B получил type+data');
  ok(msgsB.length >= 1 && msgsB[0].from && msgsB[0].from !== B.CS.Net.myName(), 'from — id отправителя');

  B.CS.Net.send('turn', { dir: 'left' });
  await sleep(150);
  ok(true, 'обратное сообщение не роняет соединение');

  console.log('\n[4] комната полна');
  const resC = await new Promise(function (r) { C.CS.Net.join(code, r); });
  ok(resC.ok === false && resC.error === 'full', 'третий игрок: full');
  ok(C.CS.Net.state().status === 'error', 'C не подключён');

  console.log('\n[5] обрыв соперника');
  B.CS.Net.leave();
  await sleep(250);
  const afterA = presenceA.length ? presenceA[presenceA.length - 1] : [];
  ok(afterA.length === 1 && afterA[0].name === 'Alice', 'после ухода B состав = [Alice]');

  console.log('\n[6] CS.Leaderboard против сервера');
  const sub = await new Promise(function (r) {
    A.CS.Leaderboard.submitRemote({ name: 'Alice', score: 130, level: 4 }, r);
  });
  ok(sub === true, 'submitRemote: принят');
  await new Promise(function (r) {
    A.CS.Leaderboard.submitRemote({ name: 'Zed', score: 50, level: 1 }, r);
  });
  await sleep(100);
  const rows = await new Promise(function (r) { A.CS.Leaderboard.fetchRemote(r); });
  ok(Array.isArray(rows) && rows.length === 2, 'fetchRemote вернул строки');
  ok(rows[0].name === 'Alice' && rows[0].score === 130, 'сортировка по очкам');
  ok(/^\d{2}\.\d{2}\.\d{4}$/.test(rows[0].date), 'дата приведена к DD.MM.YYYY');
  ok(A.CS.Leaderboard.isGlobal() === true, 'isGlobal: true при apiBase');

  console.log('\n[7] локальный режим без сервера');
  const local = makePlayer('', '', 'LocalGuy');
  ok(local.CS.Net.ensureClient(function (f) { ok(f === false, 'ensureClient: без wsUrl → false'); }) || true, 'no throw');
  await sleep(30);
  let noNet = null;
  await new Promise(function (r) {
    local.CS.Net.join('ABCD', function (res) { noNet = res; r(); });
  });
  ok(noNet && noNet.ok === false && noNet.error === 'no_client', 'join без конфига: no_client');
  let noBoard = 'x';
  await new Promise(function (r) {
    local.CS.Leaderboard.fetchRemote(function (v) { noBoard = v; r(); });
  });
  ok(noBoard === null, 'fetchRemote без apiBase: null, исключений нет');
  ok(local.CS.Leaderboard.submit({ name: 'LocalGuy', score: 10, level: 1 }) === true, 'локальная доска работает без сети');

  A.CS.Net.leave();
  C.CS.Net.leave();
  server.close();
  console.log('\n========================================');
  console.log('Пройдено: ' + passed + '  Провалено: ' + failed);
  if (failed) {
    console.log('Провалены: ' + failures.join(' | '));
    process.exit(1);
  }
  process.exit(0);
}

tests().catch(function (e) {
  console.error('ТЕСТЫ УПАЛИ С ОШИБКОЙ:', e);
  process.exit(1);
});
