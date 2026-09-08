/* корректный двух-клиентский стенд лобби: конфиг задаётся ДО загрузки
   модулей (duelui инициализируется при загрузке!), оба клиента против
   локального сервера. Проверка: A создаёт открытую комнату → B видит
   её в списке лобби. Запуск: node server/test/probe-lobby-ui.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createServer } = require('../server.js');
const WsLib = require('../ws');

const PORT = 18098;

class FakeWS {
  constructor(url) {
    this.readyState = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    const inner = new WsLib(url);
    this._inner = inner;
    inner.on('open', () => { this.readyState = 1; if (this.onopen) this.onopen(); });
    inner.on('message', (raw) => { if (this.onmessage) this.onmessage({ data: String(raw) }); });
    inner.on('close', () => { this.readyState = 3; if (this.onclose) this.onclose(); });
    inner.on('error', (e) => { if (this.onerror) this.onerror(e); });
  }
  send(s) { try { this._inner.send(s); } catch (e) {} }
  close() { try { this._inner.close(); } catch (e) {} }
}

function mkClient(tag) {
  const els = {};
  function mkEl(id) {
    const listeners = {};
    return {
      id: id, textContent: '', value: '', disabled: false, className: '',
      dataset: {}, style: {}, appended: 0, handlers: listeners,
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); },
        contains(c) { return this._s.has(c); }
      },
      addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
      removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
      focus() {}, select() {}, blur() {}, click() {},
      appendChild() { this.appended++; }, removeChild() {},
      querySelectorAll() { return []; }, querySelector() { return null; }
    };
  }
  const doc = {
    getElementById(id) { if (!els[id]) els[id] = mkEl(id); return els[id]; },
    createElement(t) { return mkEl('new-' + t); },
    createTextNode(txt) { return { textContent: String(txt) }; },
    querySelectorAll() { return []; }, querySelector() { return null; },
    addEventListener() {}, documentElement: mkEl('html'), body: mkEl('body'),
    readyState: 'complete'
  };
  const sb = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    document: doc,
    navigator: { userAgent: 'probe-' + tag },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
    location: { protocol: 'https:', search: '', hash: '' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() },
    WebSocket: FakeWS
  };
  sb.window = sb;
  /* КОНФИГ ДО ЗАГРУЗКИ МОДУЛЕЙ: duelui/watchLobby стартуют при загрузке */
  sb.CS = { Config: { apiBase: 'http://127.0.0.1:' + PORT, wsUrl: 'ws://127.0.0.1:' + PORT + '/ws' } };
  vm.createContext(sb);
  for (const f of ['i18n', 'net', 'duel-core', 'duel', 'duelui']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'js', f + '.js'), 'utf8'),
      sb, { filename: f + '.js' });
  }
  return {
    sb: sb,
    doc: doc,
    click(id) {
      const el = doc.getElementById(id);
      (el.handlers.click || []).forEach(function (fn) { fn({ preventDefault() {}, target: el }); });
    }
  };
}

const server = createServer();
server.listen(PORT, '127.0.0.1', function () {
  const A = mkClient('A');
  const B = mkClient('B');
  setTimeout(function () {
    A.click('btn-duel-create');
    setTimeout(function () {
      const stA = A.sb.CS.DuelUI.state();
      const list = B.doc.getElementById('duel-lobby-list');
      const empty = B.doc.getElementById('duel-lobby-empty');
      console.log('[A] mode=' + stA.mode + ' code=' + stA.code + ' connected=' + stA.connected);
      console.log('[B] карточек в списке лобби: ' + list.appended);
      console.log('[B] «пока никто не ждёт» скрыта: ' + empty.classList.contains('hidden'));
      const ok = stA.connected && list.appended > 0 && empty.classList.contains('hidden');
      console.log(ok ? 'ЛОББИ UI OK' : 'ЛОББИ UI СЛОМАНО');
      process.exit(ok ? 0 : 1);
    }, 2500);
  }, 1500);
});
