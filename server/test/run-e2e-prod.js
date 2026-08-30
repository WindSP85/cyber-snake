/* E2E: реальные js/net.js + js/leaderboard.js против БОЕВОГО сервера
   (запуск: node server/test/run-e2e-prod.js) — проверяет HTTPS-прокси
   nginx, сертификат, WebSocket-реле и API рекордов целиком. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WsLib = require('../ws');

const API = process.env.NEON_API || 'https://144-31-61-4.sslip.io';
const WS = process.env.NEON_WS || 'wss://144-31-61-4.sslip.io/ws';
const ROOT = path.join(__dirname, '..', '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name); console.log('  ✗ ' + name); }
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

class FakeWS {
  constructor(url) {
    this.readyState = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    const inner = new WsLib(url, { rejectUnauthorized: true });
    this._inner = inner;
    inner.on('open', () => { this.readyState = 1; if (this.onopen) this.onopen(); });
    inner.on('message', (raw) => { if (this.onmessage) this.onmessage({ data: String(raw) }); });
    inner.on('close', () => { this.readyState = 3; if (this.onclose) this.onclose(); });
    inner.on('error', (err) => { if (this.onerror) this.onerror(err); });
  }
  send(s) { try { this._inner.send(s); } catch (e) { /* уже закрыт */ } }
  close() { this.readyState = 2; try { this._inner.close(); } catch (e) {} }
}

function makePlayer(name) {
  const sandbox = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval, Date: Date,
    AbortController: AbortController
  };
  const win = {
    CS: {}, WebSocket: FakeWS, fetch: fetch.bind(globalThis),
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval,
    Date: Date, AbortController: AbortController,
    localStorage: { _d: {},
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
      setItem: function (k, v) { this._d[k] = String(v); },
      removeItem: function (k) { delete this._d[k]; } }
  };
  sandbox.window = win;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8'), sandbox);
  vm.runInContext('window.CS.Config.apiBase=' + JSON.stringify(API) + ';window.CS.Config.wsUrl=' + JSON.stringify(WS) + ';', sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/net.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/leaderboard.js'), 'utf8'), sandbox);
  win.localStorage.setItem('cs_name', name);
  return win;
}

async function tests() {
  console.log('Прод: ' + API);

  console.log('\n[1] /api/health');
  const h = await (await fetch(API + '/api/health')).json();
  ok(h.ok === true, 'health ok (uptime=' + h.uptime + 's, bot=' + h.bot + ')');

  console.log('\n[2] рекорды через настоящий leaderboard.js');
  const A = makePlayer('E2E-' + Date.now().toString(36).slice(-5));
  const sub = await new Promise(function (r) {
    A.CS.Leaderboard.submitRemote({ name: 'E2E-test', score: 77, level: 2 }, r);
  });
  ok(sub === true, 'отправка рекорда принята');
  const rows = await new Promise(function (r) { A.CS.Leaderboard.fetchRemote(r); });
  ok(Array.isArray(rows) && rows.some(function (x) { return x.name === 'E2E-test' && x.score === 77; }),
     'рекорд виден в топе');

  console.log('\n[3] дуэльный транспорт через настоящий net.js (wss + TLS + nginx)');
  const B = makePlayer('E2E-гость');
  let code = '';
  await new Promise(function (r) { A.CS.Net.createRoom(function (res) { code = res.code; r(); }); });
  ok(/^[A-Z0-9]{4}$/.test(code), 'код комнаты получен: ' + code);
  const ra = await new Promise(function (r) { A.CS.Net.join(code, r); });
  ok(ra.ok === true, 'хост вошёл в комнату через wss');
  const presA = [];
  A.CS.Net.onPresence(function (l) { presA.push(l); });
  const msgsB = [];
  B.CS.Net.onMessage(function (t, d, f) { msgsB.push({ t: t, d: d, f: f }); });
  const rb = await new Promise(function (r) { B.CS.Net.join(code, r); });
  ok(rb.ok === true, 'гость вошёл в комнату');
  await sleep(400);
  ok(presA.length && presA[presA.length - 1].length === 2, 'хост видит обоих игроков');
  A.CS.Net.send('hello', { e2e: 1 });
  await sleep(400);
  ok(msgsB.length === 1 && msgsB[0].t === 'hello' && msgsB[0].d.e2e === 1, 'реле доставило сообщение');
  B.CS.Net.leave();
  await sleep(400);
  ok(presA[presA.length - 1].length === 1, 'уход соперника виден мгновенно');
  A.CS.Net.leave();

  console.log('\n========================================');
  console.log('Пройдено: ' + passed + '  Провалено: ' + failed);
  if (failed) { console.log('Провалены: ' + failures.join(' | ')); process.exit(1); }
  process.exit(0);
}

tests().catch(function (e) {
  console.error('E2E УПАЛ:', e);
  process.exit(1);
});
