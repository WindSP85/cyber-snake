/* ============================================================
   NEON://SNAKE — игровой сервер на VPS
   Один процесс, ноль внешних зависимостей (кроме вендорной ws):

   HTTP API (Caddy терминирует HTTPS и проксирует сюда):
   - GET  /api/health            — проверка живости
   - GET  /api/top?season=&limit=— топ сезона/общий
   - POST /api/score             — новый рекорд {name,score,level,season}
   - POST /api/duel              — итог матча {winner,loser,rounds}

   WebSocket /ws — реле дуэлей 1×1:
   - клиент: {t:'join',room,id,name} → {t:'joined',ok}
   - клиент: {t:'msg',type,data}    → всем остальным {t:'msg',type,data,from}
   - клиент: {t:'ping'}             → {t:'pong'}
   - сервер: {t:'presence',list:[{id,name}]} при каждом изменении состава
   Комната исчезает, когда опустела; третий игрок получает full.
   ============================================================ */
'use strict';

const http = require('http');
const { URL } = require('url');
const WebSocket = require('./ws');
const WebSocketServer = WebSocket.WebSocketServer;
const Store = require('./store');
const bot = require('./bot');
/* ядро дуэли: в контейнере лежит рядом (server/duel-core.js),
   в репозитории — общее с браузером (js/duel-core.js) */
const duelCore = (function () {
  try { return require('./duel-core'); } catch (e) { return require('../js/duel-core'); }
})();

/* ---------- конфигурация из окружения ---------- */

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || (__dirname + '/data');
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const GAME_URL = process.env.GAME_URL || 'https://windsp85.github.io/cyber-snake/';

const log = function () {
  const args = Array.prototype.slice.call(arguments);
  console.log(new Date().toISOString().slice(11, 19), args.join(' '));
};

const store = new Store(DATA_DIR);
store.onError = function (e) {
  log('ХРАНИЛИЩЕ: запись на диск падает (' + e.message + ') — данные живут только в памяти!');
};

/* ---------- HTTP API ---------- */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS_HEADERS));
  res.end(body);
}

/* тело запроса с ограничением размера (4 КБ достаточно с запасом) */
function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', function (chunk) {
    size += chunk.length;
    if (size > 4096) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', function () {
    try {
      cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
    } catch (e) {
      cb(new Error('bad json'));
    }
  });
  req.on('error', function () { cb(new Error('read error')); });
}

/* валидация рекорда: имя 1-20, очки 0-999999 int, сезон YYYY-MM */
function validScoreEntry(b) {
  const name = String(b && b.name || '').trim();
  if (!name || name.length > 20) return { error: 'name' };
  const score = Number(b.score);
  if (!Number.isFinite(score) || score < 0 || score > 999999 || Math.floor(score) !== score) {
    return { error: 'score' };
  }
  const level = Number(b.level);
  if (!Number.isFinite(level) || level < 1 || level > 999) return { error: 'level' };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(b.season || ''))) return { error: 'season' };
  return { name: name, score: score, level: level, season: b.season };
}

function validDuelEntry(b) {
  const winner = String(b && b.winner || '').trim();
  const loser = String(b && b.loser || '').trim();
  const rounds = String(b && b.rounds || '').trim();
  if (!winner || winner.length > 20) return { error: 'winner' };
  if (!loser || loser.length > 20) return { error: 'loser' };
  if (!rounds || rounds.length > 9) return { error: 'rounds' };
  return { winner: winner, loser: loser, rounds: rounds };
}

function handleApi(req, res, urlObj) {
  const route = urlObj.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (route === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      uptime: Math.floor(process.uptime()),
      scores: store.scores.length,
      duels: store.duels.length,
      bot: !!BOT_TOKEN
    });
    return;
  }

  if (route === '/api/top' && req.method === 'GET') {
    const season = (urlObj.searchParams.get('season') || '').trim();
    const limit = urlObj.searchParams.get('limit') || 10;
    if (season && !/^\d{4}-(0[1-9]|1[0-2])$/.test(season)) {
      sendJson(res, 400, { error: 'season' });
      return;
    }
    sendJson(res, 200, { rows: store.top(season, limit) });
    return;
  }

  if (route === '/api/score' && req.method === 'POST') {
    readBody(req, function (err, body) {
      if (err) {
        sendJson(res, 400, { error: 'body' });
        return;
      }
      const v = validScoreEntry(body);
      if (v.error) {
        sendJson(res, 400, { error: v.error });
        return;
      }
      store.addScore(v);
      sendJson(res, 201, { ok: true });
    });
    return;
  }

  if (route === '/api/duel' && req.method === 'POST') {
    readBody(req, function (err, body) {
      if (err) {
        sendJson(res, 400, { error: 'body' });
        return;
      }
      const v = validDuelEntry(body);
      if (v.error) {
        sendJson(res, 400, { error: v.error });
        return;
      }
      store.addDuel(v);
      /* ПВП-рейтинг: раскладываем счёт и способы побед;
         старые клиенты шлют только rounds 'W:L' — совместимо */
      const m = /^(\d)[:,.](\d)$/.exec(v.rounds);
      store.addPvpResult({
        winner: v.winner,
        loser: v.loser,
        wRounds: m ? Number(m[1]) : 0,
        lRounds: m ? Number(m[2]) : 0,
        causes: Array.isArray(body && body.causes) ? body.causes : []
      });
      sendJson(res, 201, { ok: true });
    });
    return;
  }

  /* ПВП: топ рейтинга + своя карточка (?name=, ?limit=) */
  if (route === '/api/pvp' && req.method === 'GET') {
    const name = (urlObj.searchParams.get('name') || '').trim().slice(0, 20);
    const limit = urlObj.searchParams.get('limit') || 10;
    sendJson(res, 200, {
      top: store.pvpTop(limit),
      me: name ? store.pvpPublic(name) : null
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/* ---------- WebSocket: комнаты дуэлей + лобби ожидания ---------- */

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

const rooms = new Map();     // code → Map(id → {ws, name}); на самой Map:
                             // .createdOpen — комната создана «открытой»
                             // (видна в лобби, пока ждёт соперника)
const MAX_ROOM_MEMBERS = 2;  // 1×1: третий лишний
const MAX_SOCKETS = 300;     // защита от исчерпания памяти
const PING_EVERY = 15000;    // протокольный ping всем сокетам
const LOBBY_MAX = 50;        // максимум строк в списке лобби
let sockets = 0;

function sendObj(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) {
    /* сокет умер — presence почистит по close-событию */
  }
}

/* список открытых комнат ожидания: [{code, name, rating, w, l, st}] —
   комната с одним игроком, созданная с флагом open; рейтинг/статусы
   ждущего подтягиваются из ПВП-статистики (SPEC §28);
   сортировка по рейтингу: сильнейшие сверху, кап LOBBY_MAX */
function lobbyList() {
  const all = [];
  rooms.forEach(function (room, code) {
    if (!room.createdOpen || room.size !== 1) return;
    let name = 'PLAYER';
    room.forEach(function (m) { name = m.name; });
    name = String(name).slice(0, 20);
    const pub = store.pvpPublic(name);
    const st = pub ? pub.statuses : [];
    all.push({
      code: code,
      name: name,
      rating: pub ? pub.rating : 1000,
      w: pub ? pub.wins : 0,
      l: pub ? pub.losses : 0,
      st: st.slice(-3) // три старших статуса для строки лобби
    });
  });
  all.sort(function (a, b) { return (b.rating | 0) - (a.rating | 0); });
  return all.slice(0, LOBBY_MAX);
}

/* сколько людей сейчас в лобби: наблюдатели списка + сами ждущие */
function lobbyOnline(list) {
  let watchers = 0;
  wss.clients.forEach(function (ws) {
    if (ws._lobby) watchers++;
  });
  return watchers + list.length;
}

/* разослать свежий список всем наблюдателям лобби */
function pushLobby() {
  const list = lobbyList();
  const payload = { t: 'lobby', list: list, online: lobbyOnline(list) };
  wss.clients.forEach(function (ws) {
    if (ws._lobby) sendObj(ws, payload);
  });
}

function roomSnapshot(code) {
  const room = rooms.get(code);
  if (!room) return [];
  const list = [];
  room.forEach(function (member) {
    list.push({ id: member.id, name: member.name });
  });
  return list;
}

/* ---------- серверные дуэли (SPEC §22: равные условия) ---------- */

/* сообщение «от сервера» обоим игрокам комнаты: клиентский net.js
   доставляет его в onMessage как обычнуюrelay-копию */
function roomSend(room, type, data) {
  const payload = {
    t: 'msg', type: type,
    data: data === undefined ? null : data,
    from: '#server'
  };
  room.forEach(function (member) { sendObj(member.ws, payload); });
}

function startMsg(room, id) {
  return {
    t: 'msg', type: 'start', from: '#server',
    data: {
      side: room.sideOf[id],
      gw: duelCore.GRID_W,
      gh: duelCore.GRID_H
    }
  };
}

/* результат матча пишет СЕРВЕР: он сам видел бой, счёт не накрутить
   двумя клиентскими POST'ами (старая двойная запись) */
const CAUSE_MAP = {
  dEat: 'bite',
  dTrapped: 'loop',
  dHead: 'headon',
  dCrash: 'crash'
};

function recordServerDuel(room, info, causes) {
  try {
    const side = info.side;
    if (side !== 0 && side !== 1) return; // ничья — не матч
    const names = [];
    room.forEach(function (m) { names[room.sideOf[m.id]] = m.name; });
    if (!names[side] || !names[1 - side]) return;
    const wRounds = info.s[side] | 0;
    const lRounds = info.s[1 - side] | 0;
    store.addDuel({ winner: names[side], loser: names[1 - side], rounds: wRounds + ':' + lRounds });
    store.addPvpResult({
      winner: names[side],
      loser: names[1 - side],
      wRounds: wRounds,
      lRounds: lRounds,
      causes: (causes[side] || []).map(function (k) {
        return CAUSE_MAP[k] || 'crash';
      })
    });
  } catch (e) { /* запись не должна ронять живой матч */ }
}

/* новый матч: стороны закрепляются за текущими участниками,
   каждому уходит 'start' с его стороной и размером арены */
function startRoomMatch(room) {
  const causes = [[], []]; // способы побед стороны 0 и 1
  room.match = duelCore.createMatch({
    onRound: function (info) {
      if (info.w === 0 || info.w === 1) causes[info.w].push(info.k);
      roomSend(room, 'round', info);
    },
    onWin: function (info) {
      roomSend(room, 'win', info);
      recordServerDuel(room, info, causes);
    }
  });
  room.match.begin();
  room.snapAcc = 0;
  room.ready = {};
  room.forEach(function (m) { sendObj(m.ws, startMsg(room, m.id)); });
}

/* оба нажали ГОТОВ → старт (решение только за сервером) */
function maybeStartMatch(room) {
  if (!room.ready) return;
  if (room.match && !room.match.done()) return;
  if (room.size !== 2) return;
  let both = true;
  room.forEach(function (m) { if (!room.ready[m.id]) both = false; });
  if (!both) return;
  const ids = [];
  room.forEach(function (m) { ids.push(m.id); });
  room.sideOf = {};
  room.sideOf[ids[0]] = 0; // первый в комнате (создатель) — сторона 0
  room.sideOf[ids[1]] = 1;
  room.rematch = {};
  startRoomMatch(room);
}

/* оба запросили реванш после конца матча — новый бой теми же
   сторонами (сообщения 'rematch' по-прежнему релеятся для UI) */
function maybeRematch(room) {
  const m = room.match;
  if (!m || !m.done() || room.size !== 2) return;
  let both = true;
  room.forEach(function (mem) { if (!room.rematch[mem.id]) both = false; });
  if (!both) return;
  room.rematch = {};
  startRoomMatch(room);
}

/* шаг серверной симуляции: все живые матчи разом, снапшот 16/с —
   та же частота, что была у хоста в T27 */
const SIM_STEP = 50;          // мс шага update()
const SNAP_EVERY = 0.0625;    // с между снапшотами
setInterval(function () {
  rooms.forEach(function (room) {
    const m = room.match;
    if (!m || !m.started() || m.done()) return;
    m.update(SIM_STEP / 1000);
    room.snapAcc = (room.snapAcc || 0) + SIM_STEP / 1000;
    if (room.snapAcc >= SNAP_EVERY || m.done()) {
      room.snapAcc = 0;
      roomSend(room, 'state', m.snapshot());
    }
  });
}, SIM_STEP);

function broadcastPresence(code) {
  const room = rooms.get(code);
  if (!room) return;
  const payload = { t: 'presence', list: roomSnapshot(code) };
  room.forEach(function (member) {
    sendObj(member.ws, payload);
  });
}

function leaveRoom(ws) {
  const code = ws._room;
  if (!code) return;
  ws._room = '';
  const room = rooms.get(code);
  if (!room) return;
  const member = room.get(ws._id);
  let removed = false;
  if (member && member.ws === ws) {
    room.delete(ws._id);
    removed = true;
  }
  /* not removed = этот id уже переприсоединился новым сокетом:
     состав не менялся — ничего не трогаем */
  if (room.size === 0) {
    rooms.delete(code);
    pushLobby(); // комната исчезла из списка ожидания
  } else if (removed) {
    if (room.ready) delete room.ready[ws._id];
    if (room.rematch) delete room.rematch[ws._id];
    if (room.match && !room.match.done()) {
      room.match = null; // бой без одного игрока не крутится:
                         // оставшийся получит presence-уход и abort
    }
    broadcastPresence(code);
    pushLobby(); // снова один игрок — комната снова ждёт
  }
}

function handleJson(ws, msg) {
  if (!msg || typeof msg !== 'object') return;

  /* подписка на лобби ожидания: сокет без комнаты получает список
     открытых комнат при входе и после каждого изменения */
  if (msg.t === 'lobby') {
    ws._lobby = true;
    const list = lobbyList();
    sendObj(ws, { t: 'lobby', list: list, online: lobbyOnline(list) });
    return;
  }

  if (msg.t === 'join') {
    const code = String(msg.room || '').toUpperCase();
    const id = String(msg.id || '');
    const name = String(msg.name || 'PLAYER').trim().slice(0, 20) || 'PLAYER';
    const open = !!msg.open;
    if (!/^[A-Z0-9]{4}$/.test(code) || !/^[a-zA-Z0-9]{4,16}$/.test(id)) {
      sendObj(ws, { t: 'joined', ok: false, error: 'bad' });
      return;
    }
    leaveRoom(ws); // повторный join просто меняет комнату
    ws._lobby = false; // игрок в комнате — пуш лобби ему больше не нужен

    let room = rooms.get(code);
    if (!room) {
      room = new Map();
      room.createdOpen = open; // «открытая» комната попадает в лобби
      room.ready = {};         // флаги ГОТОВ (сервер решает о старте)
      room.rematch = {};       // флаги реванша
      room.match = null;       // живой матч (симуляция на сервере)
      room.sideOf = {};        // id → сторона 0|1 в матче
      room.snapAcc = 0;        // накопитель между снапшотами
      rooms.set(code, room);
    }
    if (room.size >= MAX_ROOM_MEMBERS && !room.has(id)) {
      sendObj(ws, { t: 'joined', ok: false, error: 'full' });
      return;
    }
    /* переподключение тем же id: старый сокет закрываем, место сохраняется */
    const old = room.get(id);
    if (old && old.ws !== ws) {
      try { old.ws.terminate(); } catch (e) { /* уже мёртв */ }
    }
    ws._room = code;
    ws._id = id;
    room.set(id, { ws: ws, id: id, name: name });
    sendObj(ws, { t: 'joined', ok: true });
    /* переподключение в живой матч: сразу обратно в бой */
    if (room.match && !room.match.done() &&
        (room.sideOf[id] === 0 || room.sideOf[id] === 1)) {
      sendObj(ws, startMsg(room, id));
    }
    broadcastPresence(code);
    pushLobby(); // комната набрала двоих → исчезла из ожидания
    return;
  }

  if (msg.t === 'msg') {
    if (!ws._room) return; // сначала join
    const type = String(msg.type || '');
    if (!type || type.length > 32) return;
    const room = rooms.get(ws._room);
    if (!room) return;

    /* серверная дуэль: пока матч жив, ходы кормят симулятор,
       а клиентские 'state'/'round'/'win'/'start' больше не релеятся */
    if (room.match && !room.match.done()) {
      if (type === 'turn') {
        const side = room.sideOf[ws._id];
        if (side === 0 || side === 1) {
          room.match.input(side, msg.data && msg.data.dir);
        }
        return;
      }
      if (type === 'state' || type === 'round' || type === 'win' || type === 'start') {
        return;
      }
    }
    if (type === 'ready' || type === 'unready') {
      if (room.ready) room.ready[ws._id] = type === 'ready';
      maybeStartMatch(room);
      /* дальше обычное реле: соперник рисует бейдж ГОТОВ */
    } else if (type === 'rematch') {
      if (room.rematch) room.rematch[ws._id] = true;
      maybeRematch(room);
    }
    const payload = { t: 'msg', type: type, data: msg.data === undefined ? null : msg.data, from: ws._id };
    room.forEach(function (member) {
      if (member.ws !== ws) sendObj(member.ws, payload); // broadcast self:false
    });
    return;
  }

  if (msg.t === 'ping') {
    sendObj(ws, { t: 'pong' });
    return;
  }
}

wss.on('connection', function (ws, req) {
  sockets++;
  if (sockets > MAX_SOCKETS) {
    sockets--;
    ws.close(1013, 'busy');
    return;
  }
  ws._room = '';
  ws._id = '';
  ws._lobby = false;
  ws.isAlive = true;
  ws._count = 0; // простая защита от флуда: окно 60 с ниже

  ws.on('pong', function () { ws.isAlive = true; });
  ws.on('message', function (raw, isBinary) {
    ws.isAlive = true;
    if (isBinary) return; // протокол игры — только JSON-текст
    ws._count++;
    if (ws._count > 900) { // >15 сообщений/сек минуту подряд — это не игра
      ws.close(1008, 'flood');
      return;
    }
    let msg = null;
    try {
      msg = JSON.parse(String(raw));
    } catch (e) {
      return; // мусор молча игнорируем
    }
    try {
      handleJson(ws, msg);
    } catch (e) {
      /* одно битое сообщение не роняет соединение */
    }
  });
  ws.on('close', function () {
    sockets--;
    leaveRoom(ws);
  });
  ws.on('error', function () {
    try { ws.terminate(); } catch (e) { /* уже мёртв */ }
  });
});

/* протокольные ping/pong: мёртвые сокеты (NAT, обрыв) вычищаем,
   браузер отвечает на ping автоматически; здесь же открывается
   новое окно антифлуда (900 сообщений за 15 с = 60/с потолок) */
setInterval(function () {
  wss.clients.forEach(function (ws) {
    ws._count = 0;
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (e) { /* уже мёртв */ }
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* уже мёртв */ }
  });
}, PING_EVERY);

/* ---------- сборка сервера ---------- */

function createServer() {
  const server = http.createServer(function (req, res) {
    let urlObj = null;
    try {
      urlObj = new URL(req.url, 'http://localhost');
    } catch (e) {
      sendJson(res, 400, { error: 'bad url' });
      return;
    }
    if (urlObj.pathname.indexOf('/api/') === 0) {
      handleApi(req, res, urlObj);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });

  server.on('upgrade', function (req, socket, head) {
    let urlObj = null;
    try {
      urlObj = new URL(req.url, 'http://localhost');
    } catch (e) {
      socket.destroy();
      return;
    }
    if (urlObj.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, function (ws) {
      wss.emit('connection', ws, req);
    });
  });

  return server;
}

function main() {
  const server = createServer();
  server.listen(PORT, '0.0.0.0', function () {
    log('NEON://SNAKE server on :' + PORT + ' (data: ' + DATA_DIR + ')');
  });

  if (BOT_TOKEN) {
    bot.runBot({ token: BOT_TOKEN, gameUrl: GAME_URL, store: store, log: log })
      .catch(function (e) { log('bot stopped: ' + e.message); });
    log('bot: включён (long polling)');
  } else {
    log('bot: BOT_TOKEN не задан — пропускаю');
  }
}

/* тесты требуют сервер без listen — экспортируем фабрику */
module.exports = { createServer: createServer, store: store, wss: wss };

if (require.main === module) {
  main();
}
