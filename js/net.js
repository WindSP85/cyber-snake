/* ============================================================
   NEON://SNAKE — realtime transport for online duels (T22,
   SPEC §22; VPS-редакция: чистый WebSocket вместо Supabase)
   CS.Net: thin WebSocket wrapper for 1×1 rooms — join, message
   relay, presence. HOST/GUEST LOGIC LIVES ELSEWHERE (T23):
   this file is a pure transport, it knows nothing about the game.

   Один собственный сервер (server/server.js, Docker на VPS):
   - join → сервер держит комнату, третий игрок получает 'full'
   - msg   → сервер релеирует всем, КРОМЕ отправителя
   - presence → полный состав комнаты при каждом изменении
   Сокет умирает вместе со страницей — presence честное и
   мгновенное, никаких сторонних heartbeat-механик.

   With no CS.Config.wsUrl every call degrades into a silent
   'no_client' and no exception ever escapes this module:
   the offline / file:// game never touches the network.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  /* ---------- constants ---------- */

  const JOIN_TIMEOUT = 10000;   // connect + server 'joined' budget, ms
  const KEEPALIVE_EVERY = 12000; // app-level ping, keeps NAT alive
  const ROOM_LEN = 4;           // room code length
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
  const ID_LEN = 8;             // random session id length
  const NAME_MAX = 20;          // player name length limit (like T10)
  const NAME_KEY = 'cs_name';   // the same nick the leaderboard saves

  /* ---------- state ---------- */

  let socket = null;        // the single room WebSocket
  let status = 'idle';      // 'idle' | 'loading' | 'connected' | 'error'
  let roomCode = '';
  let myId = '';            // random id, one per page session
  let myName = 'PLAYER';
  let joinSettled = true;   // false while a join() is pending
  let joinDone = null;      // the pending join callback
  let joinTimer = 0;
  let keepaliveTimer = 0;
  let generation = 0;       // every join() gets its own; stale
                           // socket events from a previous room die here
  const msgCbs = [];        // onMessage listeners
  const presenceCbs = [];   // onPresence listeners

  /* ---------- helpers ---------- */

  function trimmed(value) {
    return String(value || '').trim();
  }

  /* the server address in CS.Config.wsUrl → duels are wired up */
  function isConfigured() {
    const cfg = CS.Config;
    if (!cfg) return false;
    return !!trimmed(cfg.wsUrl);
  }

  /* crypto-based index when available, Math.random otherwise */
  function randomIndex(max) {
    try {
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        const buf = new Uint32Array(1);
        window.crypto.getRandomValues(buf);
        return buf[0] % max;
      }
    } catch (e) {
      /* no crypto: fall through to Math.random */
    }
    return Math.floor(Math.random() * max);
  }

  function randomCode(len) {
    let out = '';
    for (let i = 0; i < len; i++) {
      out += CODE_ALPHABET.charAt(randomIndex(CODE_ALPHABET.length));
    }
    return out;
  }

  /* myId: a fresh random id per page session; myName: the Telegram
     account name, then the saved leaderboard nick, then 'PLAYER' */
  function ensureIds() {
    if (!myId) myId = randomCode(ID_LEN).toLowerCase();
    try {
      const wa = window.Telegram && window.Telegram.WebApp;
      const u = wa && wa.initDataUnsafe && wa.initDataUnsafe.user;
      if (u) {
        const tg = String(u.username || u.first_name || '').trim().slice(0, NAME_MAX);
        if (tg) {
          myName = tg;
          return;
        }
      }
    } catch (e) {
      /* not inside Telegram: try the local nick */
    }
    try {
      const saved = String(window.localStorage.getItem(NAME_KEY) || '').trim().slice(0, NAME_MAX);
      if (saved) {
        myName = saved;
        return;
      }
    } catch (e) {
      /* storage unavailable: keep the default */
    }
    myName = 'PLAYER';
  }

  function sendRaw(obj) {
    try {
      if (socket && socket.readyState === 1) { // OPEN
        socket.send(JSON.stringify(obj));
        return true;
      }
    } catch (e) {
      /* a dead socket resolves into the close handler below */
    }
    return false;
  }

  /* ---------- presence plumbing ---------- */

  /* the server list [{id, name}] → the API shape [{id, name,
     online, self}] every consumer already understands */
  function emitPresence(list) {
    const snapshot = [];
    const arr = Array.isArray(list) ? list : [];
    for (let i = 0; i < arr.length; i++) {
      snapshot.push({
        id: String(arr[i].id || ''),
        name: String(arr[i].name || 'PLAYER').slice(0, NAME_MAX),
        online: true,
        self: String(arr[i].id || '') === myId
      });
    }
    const ids = snapshot.map(function (x) { return x.id; });
    const info = { joined: ids, left: [] }; // membership DIFF details
    // are not needed downstream: every consumer re-reads the full list
    const cbs = presenceCbs.slice();
    for (let i = 0; i < cbs.length; i++) {
      try { cbs[i](snapshot, info); } catch (e) { /* a broken listener must not break the room */ }
    }
  }

  /* ---------- socket lifecycle ---------- */

  function settleJoin(res) {
    if (joinSettled) return;
    joinSettled = true;
    if (joinTimer) {
      window.clearTimeout(joinTimer);
      joinTimer = 0;
    }
    status = res && res.ok ? 'connected' : 'error';
    const done = joinDone; // grab BEFORE cleanupSocket() wipes it
    joinDone = null;
    if (!res || !res.ok) cleanupSocket();
    if (typeof done === 'function') {
      try { done(res); } catch (e) { /* the caller's callback is its own problem */ }
    }
  }

  /* silent teardown: no callbacks, no presence emission; repeat
     join() after this is fully supported */
  function cleanupSocket() {
    if (keepaliveTimer) {
      window.clearInterval(keepaliveTimer);
      keepaliveTimer = 0;
    }
    const ws = socket;
    socket = null;
    roomCode = '';
    joinSettled = true;
    joinDone = null;
    if (joinTimer) {
      window.clearTimeout(joinTimer);
      joinTimer = 0;
    }
    if (ws) {
      try { ws.onclose = null; } catch (e) { /* already gone */ }
      try { ws.onerror = null; } catch (e) { /* already gone */ }
      try { ws.onmessage = null; } catch (e) { /* already gone */ }
      try {
        if (ws.readyState === 0 || ws.readyState === 1) ws.close();
      } catch (e) {
        /* already gone */
      }
    }
  }

  /* ---------- public API ---------- */

  /* cb(ok bool); with a configured server this is instant — the
     native WebSocket needs no library download. false = local
     mode (no wsUrl): duels are simply unavailable */
  function ensureClientApi(cb) {
    const done = typeof cb === 'function' ? cb : function () {};
    done(isConfigured());
  }

  /* cb({ok, code}) — a fresh 4-char room code from the unambiguous
     alphabet; 'no_client' when the transport is not available */
  function createRoom(cb) {
    const done = typeof cb === 'function' ? cb : function () {};
    try {
      ensureClientApi(function (ok) {
        if (!ok) {
          done({ ok: false, error: 'no_client' });
          return;
        }
        done({ ok: true, code: randomCode(ROOM_LEN) });
      });
    } catch (e) {
      done({ ok: false, error: 'no_client' });
    }
  }

  /* cb({ok, error?}) with error ∈ 'no_client' | 'timeout' | 'full';
     opens the WebSocket, sends 'join' and waits for the verdict */
  function join(code, cb) {
    const done = typeof cb === 'function' ? cb : function () {};
    try {
      const norm = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!norm || !isConfigured()) {
        done({ ok: false, error: 'no_client' }); // nothing to dial
        return;
      }
      try {
        cleanupSocket(); // a repeat join silently drops the old room
        ensureIds();
      } catch (e) {
        done({ ok: false, error: 'no_client' });
        return;
      }

      const gen = ++generation;
      joinDone = done;
      joinSettled = false;
      roomCode = norm;
      status = 'loading';

      let ws = null;
      try {
        ws = new window.WebSocket(trimmed(CS.Config.wsUrl));
      } catch (e) {
        settleJoin({ ok: false, error: 'timeout' });
        return;
      }
      socket = ws;

      joinTimer = window.setTimeout(function () {
        if (gen === generation) settleJoin({ ok: false, error: 'timeout' });
      }, JOIN_TIMEOUT);

      ws.onopen = function () {
        if (gen !== generation) return;
        sendRaw({ t: 'join', room: roomCode, id: myId, name: myName });
      };
      ws.onerror = function () {
        if (gen !== generation) return;
        settleJoin({ ok: false, error: 'timeout' });
      };
      ws.onclose = function () {
        if (gen !== generation) return;
        if (status === 'connected') {
          // a live room died (network drop): report the empty room
          cleanupSocket();
          status = 'idle';
          emitPresence([]);
        } else {
          settleJoin({ ok: false, error: 'timeout' });
        }
      };
      ws.onmessage = function (evt) {
        if (gen !== generation) return;
        let msg = null;
        try {
          msg = JSON.parse(String(evt && evt.data));
        } catch (e) {
          return; // the server never sends garbage; ignore anyway
        }
        if (!msg || typeof msg !== 'object') return;

        if (msg.t === 'joined') {
          if (msg.ok) {
            settleJoin({ ok: true });
            // the server follows with the first 'presence' itself
          } else {
            settleJoin({ ok: false, error: msg.error === 'full' ? 'full' : 'timeout' });
          }
          return;
        }

        if (msg.t === 'presence') {
          if (status === 'connected') emitPresence(msg.list);
          return;
        }

        if (msg.t === 'msg') {
          const from = String(msg.from || '');
          if (from === myId) return; // a spare belt after the server
          const cbs = msgCbs.slice();
          for (let i = 0; i < cbs.length; i++) {
            try {
              cbs[i](String(msg.type), msg.data === undefined ? null : msg.data, from);
            } catch (e) {
              /* a broken listener must not break the transport */
            }
          }
          return;
        }

        if (msg.t === 'pong') return; // just liveness, nothing to do
      };

      /* app-level keepalive: NAT routers love dropping idle
         sockets; 12 s of silence is enough for some of them */
      keepaliveTimer = window.setInterval(function () {
        if (gen !== generation) return;
        sendRaw({ t: 'ping' });
      }, KEEPALIVE_EVERY);
    } catch (e) {
      done({ ok: false, error: 'no_client' });
    }
  }

  /* fire-and-forget broadcast {type, data}; the server relays it
     to the OTHER room member. false when not connected */
  function send(type, data) {
    try {
      if (!socket || status !== 'connected') return false;
      return sendRaw({
        t: 'msg',
        type: String(type),
        data: data === undefined ? null : data
      });
    } catch (e) {
      return false;
    }
  }

  /* cb(type, data, fromId) for every FOREIGN message */
  function onMessage(cb) {
    if (typeof cb === 'function') msgCbs.push(cb);
  }

  /* cb(list, diff): list — the full actual [{id, name, online,
     self}] snapshot; diff — {joined, left} of the triggering event */
  function onPresence(cb) {
    if (typeof cb === 'function') presenceCbs.push(cb);
  }

  /* the socket itself is the liveness now (server pings it);
     this stays as an explicit extra pulse for SPEC §22 */
  function heartbeat() {
    return sendRaw({ t: 'ping' });
  }

  /* teardown + reset; listeners stay registered, join() works again.
     A game-level farewell ('bye') is the CALLER's business (duelui
     already sends it before calling this) */
  function leave() {
    cleanupSocket();
    status = 'idle';
    emitPresence([]); // the room is empty now
  }

  /* debug: {status, roomCode} */
  function state() {
    return { status: status, roomCode: roomCode };
  }

  CS.Net = {
    ensureClient: ensureClientApi,
    createRoom: createRoom,
    join: join,
    send: send,
    onMessage: onMessage,
    onPresence: onPresence,
    heartbeat: heartbeat,
    leave: leave,
    state: state,
    myName: function () { return myName; }
  };
})();
