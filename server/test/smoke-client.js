/* smoke-прогон клиентской цепочки: все js-модули index.html грузятся
   в vm-песочнице без исключений, ключевые неймспейсы CS живы.
   Запуск: node server/test/smoke-client.js  */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILES = ['config', 'i18n', 'audio', 'bosses', 'fx', 'leaderboard',
  'telegram', 'net', 'duel-core', 'duel', 'achievements', 'skins',
  'daily', 'quests', 'upgrades', 'duelui', 'ui', 'game'];
const NS = ['CS.Config', 'CS.I18N', 'CS.Audio', 'CS.BossFight', 'CS.FX',
  'CS.Leaderboard', 'CS.Net', 'CS.DuelCore', 'CS.Duel', 'CS.Ach',
  'CS.Skins', 'CS.Daily', 'CS.Quests', 'CS.Upg', 'CS.UI', 'CS.Game', 'CS.TG'];

function noop() {}
function fakeCtx() {
  return new Proxy({}, {
    get: function (t, k) {
      if (k === 'createRadialGradient' || k === 'createPattern' ||
          k === 'createLinearGradient') {
        return function () { return { addColorStop: noop }; };
      }
      return noop;
    },
    set: function () { return true; }
  });
}
function fakeCanvas() {
  return { width: 0, height: 0, style: fakeStyle(), getContext: function () { return fakeCtx(); } };
}
function fakeStyle() {
  return new Proxy({}, {
    get: function (t, k) { return typeof k === 'string' ? noop : undefined; },
    set: function () { return true; }
  });
}
function el() {
  return {
    style: fakeStyle(),
    classList: { add: noop, remove: noop, toggle: noop, contains: function () { return false; } },
    addEventListener: noop, removeEventListener: noop,
    appendChild: noop, removeChild: noop,
    setAttribute: noop, getAttribute: function () { return null; },
    focus: noop, select: noop, blur: noop, click: noop,
    getContext: function () { return fakeCtx(); },
    textContent: '', value: '', dataset: {}, disabled: false,
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; }
  };
}

const sb = {
  console: { log: noop, warn: noop, error: noop, info: noop },
  document: {
    createElement: function (t) { return t === 'canvas' ? fakeCanvas() : el(); },
    createTextNode: function (t) { return el(); },
    getElementById: function () { return el(); },
    querySelectorAll: function () { return []; },
    querySelector: function () { return null; },
    addEventListener: noop,
    documentElement: el(),
    body: el(),
    readyState: 'loading'
  },
  navigator: { userAgent: 'smoke', language: 'ru', serviceWorker: undefined },
  localStorage: {
    getItem: function () { return null; }, setItem: noop, removeItem: noop,
    key: function () { return null; }, length: 0
  },
  location: { protocol: 'file:', search: '', hash: '', href: 'file:///x/index.html' },
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  setTimeout: function (f) { return 0; }, clearTimeout: noop,
  setInterval: function (f) { return 0; }, clearInterval: noop,
  performance: { now: function () { return Date.now(); } },
  devicePixelRatio: 1,
  AudioContext: undefined, webkitAudioContext: undefined,
  WebSocket: undefined
};
sb.window = sb;
vm.createContext(sb);

let failed = 0;
let loaded = 0;
for (let i = 0; i < FILES.length; i++) {
  const f = FILES[i];
  try {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '..', '..', 'js', f + '.js'), 'utf8'),
      sb, { filename: f + '.js' }
    );
    loaded++;
  } catch (e) {
    console.log('FAIL ' + f + '.js: ' + e.message);
    failed++;
  }
}
console.log('модулей загрузилось: ' + loaded + '/' + FILES.length);

for (let i = 0; i < NS.length; i++) {
  const parts = NS[i].split('.');
  let v = sb;
  for (let k = 0; k < parts.length; k++) v = v && v[parts[k]];
  if (!v) {
    console.log('FAIL неймспейс ' + NS[i]);
    failed++;
  }
}

console.log(failed ? 'SMOKE FAIL (' + failed + ')' : 'SMOKE OK');
process.exit(failed ? 1 : 0);
