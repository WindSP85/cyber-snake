/* ============================================================
   NEON://SNAKE — leaderboard (feature T10, SPEC §13)
   CS.Leaderboard: local top-10 high scores.

   ARCHITECTURE NOTE: the provider seam below (providerRead /
   providerWrite / providerClear) is the only place that touches
   localStorage. To move the board to a server tomorrow, swap
   those three for fetch('/api/scores') calls — load / qualifies /
   submit / clear keep their signatures, so no caller (ui.js,
   game.js) needs a single change.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  const MAX_ENTRIES = 10;      // board size
  const NAME_MAX = 12;         // player name length limit
  const STORAGE_KEY = 'cs_board';

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

  /* ---------- public API ---------- */

  CS.Leaderboard = {
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
       name is empty. The weakest entry is evicted on overflow. */
    submit: function (entry) {
      if (!entry) return false;
      const s = Number(entry.score);
      if (!positive(s) || !CS.Leaderboard.qualifies(s)) return false;
      const name = String(entry.name || '').trim().slice(0, NAME_MAX);
      if (!name) return false;
      const level = Number(entry.level);
      const entries = providerRead();
      entries.push({
        name: name,
        score: s,
        level: Number.isFinite(level) && level > 0 ? Math.floor(level) : 1,
        date: localDate()
      });
      providerWrite(normalize(entries));
      return true;
    },

    /* wipe the board */
    clear: function () {
      providerClear();
    }
  };
})();
