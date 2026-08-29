/* ============================================================
   NEON://SNAKE — realtime transport for online duels (feature T22,
   SPEC §22)
   CS.Net: thin Supabase Realtime wrapper for 1×1 rooms — rooms,
   broadcast, presence. HOST/GUEST LOGIC LIVES ELSEWHERE (T23):
   this file is a pure transport, it knows nothing about the game.

   The supabase-js client is loaded DYNAMICALLY and only on demand
   (the second documented CDN exception in AGENTS.md): the offline /
   file:// game never touches the network. With no CS.Config
   credentials every call degrades into a silent 'no_client' and no
   exception ever escapes this module.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  /* ---------- constants ---------- */

  const CDN_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
  const LOAD_TIMEOUT = 10000;   // client download budget, ms
  const JOIN_TIMEOUT = 10000;   // subscribe + first presence budget, ms
  const ROOM_LEN = 4;           // room code length
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
  const ID_LEN = 8;             // random session id length
  const NAME_MAX = 20;          // player name length limit (like T10)
  const NAME_KEY = 'cs_name';   // the same nick the leaderboard saves
  const MAX_FOREIGN = 2;        // 2 strangers already inside → room full
  const EVENT = 'duel';         // the single broadcast event; game
                                // semantics travel in payload.type

  /* ---------- state ---------- */

  let client = null;        // cached supabase-js client
  let clientLoading = false;
  let loadCbs = [];         // pending ensureClient callbacks
  let status = 'idle';      // 'idle' | 'loading' | 'connected' | 'error'
  let channel = null;       // current realtime channel
  let roomCode = '';
  let myId = '';            // random id, one per page session
  let myName = 'PLAYER';
  let joinSettled = true;   // false while a join() is pending
  let joinDone = null;      // the pending join callback
  let joinTimer = 0;
  const msgCbs = [];        // onMessage listeners
  const presenceCbs = [];   // onPresence listeners

  /* ---------- helpers ---------- */

  function trimmed(value) {
    return String(value || '').trim();
  }

  /* both credentials filled → the cloud is wired up (like T14) */
  function isConfigured() {
    const cfg = CS.Config;
    if (!cfg) return false;
    return !!trimmed(cfg.supabaseUrl) && !!trimmed(cfg.supabaseKey);
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

  /* swallow a maybe-promise so a rejected send/unsubscribe never
     becomes an unhandled rejection */
  function eat(promise) {
    try {
      if (promise && typeof promise.catch === 'function') {
        promise.catch(function () { /* network noise: ignore */ });
      }
    } catch (e) {
      /* not a promise: nothing to do */
    }
  }

  /* ---------- client loading (the only network touchpoint) ---------- */

  function ensureClient(cb) {
    const done = typeof cb === 'function' ? cb : function () {};
    try {
      if (client) {
        done(true); // cached
        return;
      }
      if (!isConfigured()) {
        done(false); // local mode: no network at all
        return;
      }
      loadCbs.push(done);
      if (clientLoading) return;
      clientLoading = true;
      status = 'loading';

      let settled = false;
      let timer = 0;
      const script = document.createElement('script');
      const finish = function (ok) {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        clientLoading = false;
        if (!ok) {
          status = 'error';
          try {
            if (script.parentNode && typeof script.parentNode.removeChild === 'function') {
              script.parentNode.removeChild(script);
            }
          } catch (e) {
            /* the dead tag is harmless */
          }
        } else {
          status = 'idle'; // client ready, not connected anywhere yet
        }
        const cbs = loadCbs.splice(0, loadCbs.length);
        for (let i = 0; i < cbs.length; i++) {
          try { cbs[i](ok); } catch (e) { /* a broken callback changes nothing */ }
        }
      };

      timer = window.setTimeout(function () {
        finish(false); // CDN unreachable / offline
      }, LOAD_TIMEOUT);

      script.onload = function () {
        try {
          const lib = window.supabase;
          if (!lib || typeof lib.createClient !== 'function') {
            finish(false);
            return;
          }
          client = lib.createClient(
            trimmed(CS.Config.supabaseUrl),
            trimmed(CS.Config.supabaseKey)
          );
          finish(!!client);
        } catch (e) {
          finish(false);
        }
      };
      script.onerror = function () {
        finish(false);
      };
      script.async = true;
      const host = document.head || document.body || document.documentElement;
      if (!host || typeof host.appendChild !== 'function') {
        finish(false); // no DOM to attach the tag to
        return;
      }
      script.src = CDN_URL;
      host.appendChild(script);
    } catch (e) {
      clientLoading = false;
      status = 'error';
      loadCbs = []; // nothing is loading anymore: drop the queue
      try { done(false); } catch (e2) { /* nothing more to do */ }
    }
  }

  /* ---------- presence plumbing ---------- */

  /* the full CURRENT participant list rebuilt from presenceState()
     (the source of truth) — [{id, name, online, self}] */
  function presenceList() {
    const list = [];
    try {
      const state = channel && typeof channel.presenceState === 'function'
        ? channel.presenceState()
        : null;
      if (!state) return list;
      for (const key in state) {
        if (!Object.prototype.hasOwnProperty.call(state, key)) continue;
        const metas = state[key];
        const meta = Array.isArray(metas) && metas.length && typeof metas[0] === 'object'
          ? metas[0]
          : {};
        list.push({
          id: String(key),
          name: String(meta.name || 'PLAYER').slice(0, NAME_MAX),
          online: true,
          self: String(key) === myId
        });
      }
    } catch (e) {
      /* a broken presence state just yields what we managed to read */
    }
    return list;
  }

  function emitPresence(list, diff) {
    const snapshot = list.slice();
    const info = { joined: (diff && diff.joined || []).slice(), left: (diff && diff.left || []).slice() };
    const cbs = presenceCbs.slice();
    for (let i = 0; i < cbs.length; i++) {
      try { cbs[i](snapshot, info); } catch (e) { /* a broken listener must not break the room */ }
    }
  }

  /* every presence event re-emits the full actualized list; while a
     join() is still pending the same list decides 'full' */
  function handlePresence(diff) {
    const list = presenceList();
    if (!joinSettled) {
      let foreign = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i].id !== myId) foreign++;
      }
      if (foreign >= MAX_FOREIGN) {
        settleJoin({ ok: false, error: 'full' });
        return;
      }
      settleJoin({ ok: true }); // first sync: we are in, room not overfull
    }
    emitPresence(list, diff);
  }

  function diffKeys(evt) {
    try {
      if (evt && typeof evt === 'object' && typeof evt.key === 'string' && evt.key) {
        return [evt.key];
      }
    } catch (e) {
      /* unexpected shape: no diff info */
    }
    return [];
  }

  /* ---------- channel lifecycle ---------- */

  function settleJoin(res) {
    if (joinSettled) return;
    joinSettled = true;
    if (joinTimer) {
      window.clearTimeout(joinTimer);
      joinTimer = 0;
    }
    status = res && res.ok ? 'connected' : 'error';
    const done = joinDone; // grab BEFORE cleanupChannel() wipes it
    joinDone = null;
    if (!res || !res.ok) cleanupChannel();
    if (typeof done === 'function') {
      try { done(res); } catch (e) { /* the caller's callback is its own problem */ }
    }
  }

  /* silent teardown: no callbacks, no presence emission; repeat
     join() after this is fully supported */
  function cleanupChannel() {
    const ch = channel;
    channel = null;
    roomCode = '';
    joinSettled = true;
    joinDone = null;
    if (joinTimer) {
      window.clearTimeout(joinTimer);
      joinTimer = 0;
    }
    if (!ch) return;
    try {
      if (typeof ch.unsubscribe === 'function') eat(ch.unsubscribe());
    } catch (e) {
      /* already gone */
    }
    try {
      if (client && typeof client.removeChannel === 'function') {
        eat(client.removeChannel(ch));
      }
    } catch (e) {
      /* already gone */
    }
  }

  function onBroadcast(msg) {
    try {
      const p = msg && typeof msg === 'object' ? msg.payload : null;
      if (!p || typeof p !== 'object') return;
      if (p.from === myId) return; // self:false already cuts it; a spare belt
      const cbs = msgCbs.slice();
      for (let i = 0; i < cbs.length; i++) {
        try {
          cbs[i](String(p.type), p.data === undefined ? null : p.data, p.from);
        } catch (e) {
          /* a broken listener must not break the transport */
        }
      }
    } catch (e) {
      /* malformed payload: drop it silently */
    }
  }

  /* ---------- public API ---------- */

  /* cb(ok bool); loads supabase-js from the CDN exactly once, on
     demand only; false on no config / no network / 10s timeout */
  function ensureClientApi(cb) {
    ensureClient(cb);
  }

  /* cb({ok, code}) — a fresh 4-char room code from the unambiguous
     alphabet; 'no_client' when the transport is not available */
  function createRoom(cb) {
    const done = typeof cb === 'function' ? cb : function () {};
    try {
      ensureClient(function (ok) {
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
     joins the `room-<code>` broadcast+presence channel */
  function join(code, cb) {
    const done = typeof cb === 'function' ? cb : function () {};
    try {
      const norm = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!norm) {
        done({ ok: false, error: 'no_client' }); // nothing to dial
        return;
      }
      ensureClient(function (ok) {
        if (!ok) {
          done({ ok: false, error: 'no_client' });
          return;
        }
        try {
          cleanupChannel(); // a repeat join silently drops the old room
          ensureIds();
          joinDone = done;
          joinSettled = false;
          roomCode = norm;
          status = 'loading';

          channel = client.channel('room-' + norm, {
            config: {
              broadcast: { self: false },
              presence: { key: myId }
            }
          });
          if (typeof channel.on === 'function') {
            channel.on('broadcast', { event: EVENT }, onBroadcast);
            channel.on('presence', { event: 'sync' }, function () {
              handlePresence({ joined: [], left: [] });
            });
            channel.on('presence', { event: 'join' }, function (evt) {
              handlePresence({ joined: diffKeys(evt), left: [] });
            });
            channel.on('presence', { event: 'leave' }, function (evt) {
              handlePresence({ joined: [], left: diffKeys(evt) });
            });
          }
          if (typeof channel.subscribe !== 'function') {
            settleJoin({ ok: false, error: 'timeout' });
            return;
          }
          joinTimer = window.setTimeout(function () {
            settleJoin({ ok: false, error: 'timeout' });
          }, JOIN_TIMEOUT);
          channel.subscribe(function (st) {
            if (st === 'SUBSCRIBED') {
              try {
                eat(channel.track({ name: myName }));
              } catch (e) {
                /* presence is best effort; broadcast still works */
              }
            } else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') {
              settleJoin({ ok: false, error: 'timeout' });
            }
          });
        } catch (e) {
          done({ ok: false, error: 'timeout' });
          cleanupChannel();
        }
      });
    } catch (e) {
      done({ ok: false, error: 'no_client' });
    }
  }

  /* fire-and-forget broadcast {type, data, from: myId}; false when
     not connected */
  function send(type, data) {
    try {
      if (!channel || status !== 'connected' || typeof channel.send !== 'function') {
        return false;
      }
      eat(channel.send({
        type: 'broadcast',
        event: EVENT,
        payload: {
          type: String(type),
          data: data === undefined ? null : data,
          from: myId
        }
      }));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* cb(type, data, fromId) for every FOREIGN message */
  function onMessage(cb) {
    if (typeof cb === 'function') msgCbs.push(cb);
  }

  /* cb(list, diff): list — the full actual [{id, name, online,
     self}] snapshot; diff — {joined, left} ids of the event that
     triggered the emission (a leave → the rival drop check) */
  function onPresence(cb) {
    if (typeof cb === 'function') presenceCbs.push(cb);
  }

  /* realtime presence heartbeats on its own (track above); this is
     an explicit liveness re-pulse for the SPEC §22 rival-drop check */
  function heartbeat() {
    try {
      if (!channel || status !== 'connected' || typeof channel.track !== 'function') {
        return false;
      }
      eat(channel.track({ name: myName }));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* teardown + reset; listeners stay registered, join() works again */
  function leave() {
    try {
      settleJoin({ ok: false, error: 'timeout' }); // unhang a pending join()
    } catch (e) {
      /* nothing pending */
    }
    cleanupChannel();
    status = 'idle';
    emitPresence([], { joined: [], left: [] }); // the room is empty now
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
    state: state
  };
})();
