/* ============================================================
   NEON://SNAKE — leaderboard (feature T10, SPEC §13; T14: global)
   CS.Leaderboard: local top-10 high scores + optional Supabase.

   ARCHITECTURE NOTE: the provider seam below (providerRead /
   providerWrite / providerClear) is the only place that touches
   localStorage. The local board (load / qualifies / submit / clear)
   stays synchronous and always works — the global mode
   (feature T14) only ADDS fetchRemote / submitRemote on top and
   degrades gracefully: no CS.Config credentials → no network at
   all (file://-safe), a failed request → null / false, never an
   exception.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  const MAX_ENTRIES = 10;      // board size
  const NAME_MAX = 12;         // player name length limit
  const STORAGE_KEY = 'cs_board';
  const NET_TIMEOUT = 5000;    // feature T14: per-request budget, ms

  /* ---------- provider: localStorage (replace with a server API) ---------- */

  function providerRead() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      const entries = [];
      for (let i = 0; i < data.length; i++) {
        const e = data[i];
        if (!e || typeof e !== 'object') continue;
        entries.push({
          name: String(e.name || ''),
          score: Number(e.score) || 0,
          level: Number(e.level) > 0 ? Math.floor(Number(e.level)) : 1,
          date: String(e.date || '')
        });
      }
      return entries;
    } catch (e) {
      return []; // storage unavailable or corrupt payload: start empty
    }
  }

  function providerWrite(entries) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (e) {
      /* storage unavailable: the board lives until the next reload */
    }
  }

  function providerClear() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* storage unavailable: nothing to clear */
    }
  }

  /* ---------- helpers ---------- */

  function byScoreDesc(a, b) {
    return b.score - a.score;
  }

  /* defensive copy: sorted by score desc, capped at MAX_ENTRIES */
  function normalize(entries) {
    return entries.slice().sort(byScoreDesc).slice(0, MAX_ENTRIES);
  }

  /* local date as DD.MM.YYYY */
  function localDate() {
    const d = new Date();
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return dd + '.' + mm + '.' + d.getFullYear();
  }

  function positive(score) {
    return Number.isFinite(score) && score > 0;
  }

  /* ---------- feature T14: global mode (Supabase REST) ---------- */

  function trimmed(value) {
    return String(value || '').trim();
  }

  /* both credentials filled (without spaces) → the cloud is wired up */
  function isGlobal() {
    const cfg = CS.Config;
    if (!cfg) return false;
    return !!trimmed(cfg.supabaseUrl) && !!trimmed(cfg.supabaseKey);
  }

  /* {url}/rest/v1/... — tolerant of a trailing slash in the config */
  function endpoint(path) {
    return trimmed(CS.Config.supabaseUrl).replace(/\/+$/, '') + path;
  }

  function netHeaders(extra) {
    const key = trimmed(CS.Config.supabaseKey);
    const headers = {
      apikey: key,
      Authorization: 'Bearer ' + key
    };
    if (extra) {
      const keys = Object.keys(extra);
      for (let i = 0; i < keys.length; i++) headers[keys[i]] = extra[keys[i]];
    }
    return headers;
  }

  /* created_at (ISO 8601, e.g. 2026-08-15T10:00:00Z) → DD.MM.YYYY;
     the date part is taken as-is, so the value never shifts with the
     local timezone. Anything unparsable → ''. */
  function remoteDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (m) return m[3] + '.' + m[2] + '.' + m[1];
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return dd + '.' + mm + '.' + d.getFullYear();
  }

  /* rows from Supabase → the board entry shape, sorted by score desc */
  function normalizeRemote(rows) {
    const entries = [];
    if (!Array.isArray(rows)) return entries;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r || typeof r !== 'object') continue;
      const score = Number(r.score);
      if (!Number.isFinite(score)) continue;
      entries.push({
        name: String(r.name || ''),
        score: score,
        level: Number(r.level) > 0 ? Math.floor(Number(r.level)) : 1,
        date: remoteDate(r.created_at)
      });
    }
    return entries.sort(byScoreDesc);
  }

  /* a fetch + AbortController timeout wrapped so that neither a
     missing fetch, nor a network error, nor a broken promise chain
     can ever throw outside; settle() fires exactly once */
  function netFetch(url, options, onOk, onFail) {
    let settled = false;
    const settle = function (ok, value) {
      if (settled) return;
      settled = true;
      if (ok) onOk(value);
      else onFail();
    };
    try {
      if (typeof window.fetch !== 'function') {
        settle(false);
        return;
      }
      let signal = undefined;
      if (typeof window.AbortController === 'function') {
        const ctrl = new window.AbortController();
        signal = ctrl.signal;
        window.setTimeout(function () {
          try { ctrl.abort(); } catch (e) { /* already aborted or settled */ }
        }, NET_TIMEOUT);
      }
      window.fetch(url, options ? {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: signal
      } : { signal: signal }).then(function (res) {
        settle(true, res);
      }, function () {
        settle(false);
      });
    } catch (e) {
      settle(false);
    }
  }

  /* async global top-10; callback(rows | null), never throws */
  function fetchRemote(callback) {
    const done = typeof callback === 'function' ? callback : function () {};
    if (!isGlobal()) {
      done(null); // local mode: no network at all
      return;
    }
    netFetch(
      endpoint('/rest/v1/scores?select=name,score,level,created_at&order=score.desc&limit=10'),
      { method: 'GET', headers: netHeaders() },
      function (res) {
        if (!res || !res.ok || typeof res.json !== 'function') return done(null);
        try {
          res.json().then(function (rows) {
            const entries = normalizeRemote(rows);
            done(entries.length ? entries : null); // empty payload → local fallback
          }, function () {
            done(null);
          });
        } catch (e) {
          done(null);
        }
      },
      function () {
        done(null);
      }
    );
  }

  /* async push of one entry; callback(ok bool), silent failure */
  function submitRemote(entry, callback) {
    const done = typeof callback === 'function' ? callback : function () {};
    if (!isGlobal() || !entry) {
      done(false);
      return;
    }
    const name = String(entry.name || '').trim().slice(0, NAME_MAX);
    if (!name) {
      done(false); // the server CHECK would reject it anyway
      return;
    }
    const score = Number(entry.score);
    const level = Number(entry.level);
    netFetch(
      endpoint('/rest/v1/scores'),
      {
        method: 'POST',
        headers: netHeaders({
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        }),
        body: JSON.stringify({
          name: name,
          score: positive(score) ? Math.floor(score) : 0,
          level: Number.isFinite(level) && level > 0 ? Math.floor(level) : 1
        })
      },
      function (res) {
        done(!!res && !!res.ok);
      },
      function () {
        done(false);
      }
    );
  }

  /* ---------- public API ---------- */

  CS.Leaderboard = {
    /* feature T14: true when Supabase credentials are configured */
    isGlobal: function () {
      return isGlobal();
    },

    /* → [{name, score, level, date}], sorted by score desc, max 10 */
    load: function () {
      return normalize(providerRead());
    },

    /* true when the score is positive AND earns a top-10 slot */
    qualifies: function (score) {
      const s = Number(score);
      if (!positive(s)) return false;
      const top = normalize(providerRead());
      if (top.length < MAX_ENTRIES) return true;
      return s > top[MAX_ENTRIES - 1].score;
    },

    /* insert an entry; false when it does not qualify or the trimmed
       name is empty. The weakest entry is evicted on overflow.
       feature T14: in global mode the record is also mirrored to
       Supabase fire-and-forget — a network failure changes nothing
       locally (submitRemote reports via its own callback). */
    submit: function (entry) {
      if (!entry) return false;
      const s = Number(entry.score);
      if (!positive(s) || !CS.Leaderboard.qualifies(s)) return false;
      const name = String(entry.name || '').trim().slice(0, NAME_MAX);
      if (!name) return false;
      const level = Number(entry.level);
      const record = {
        name: name,
        score: s,
        level: Number.isFinite(level) && level > 0 ? Math.floor(level) : 1,
        date: localDate()
      };
      const entries = providerRead();
      entries.push(record);
      providerWrite(normalize(entries));
      if (isGlobal()) {
        submitRemote(record, null); // fire-and-forget
      }
      return true;
    },

    /* wipe the LOCAL board (the global one has no delete policy) */
    clear: function () {
      providerClear();
    },

    /* feature T14: async global top-10; callback(rows | null) */
    fetchRemote: function (callback) {
      fetchRemote(callback);
    },

    /* feature T14: async push; callback(ok bool) */
    submitRemote: function (entry, callback) {
      submitRemote(entry, callback);
    }
  };
})();
