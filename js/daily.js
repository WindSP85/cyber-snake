/* ============================================================
   NEON://SNAKE — daily challenge (feature T20, SPEC §20)
   CS.Daily derives the day's run modifier from a deterministic hash
   of the local date (YYYY-MM-DD), tracks whether the live run carries
   it and keeps the per-day best score in localStorage
   ('cs_daily_YYYY-MM-DD' — one record per challenge day).

   Contract:
     CS.Daily.today()          → {id, nameKey, descKey, seed}
     CS.Daily.active()         → the live run's modifier id | false
     CS.Daily.start()/stop()   → game.js marks the run start / end
     CS.Daily.best()           → the day's best score (0 = none yet)
     CS.Daily.setBest(score)   → raise + persist the day best

   The five modifiers (SPEC §20): mirror — reversed controls for the
   whole run, ice — tick speed x0.6 for the whole run, cream — food
   pays x2 but grows the snake double, dark — only the area around
   the head is visible, hunt — mystery pickups weigh x2, viruses
   meaner. game.js applies each one at its own decision point; this
   module only picks the modifier of the day and owns the flag plus
   the day best. No DOM, no network — file://-safe by construction.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  /* the catalog order fixes the seed → modifier mapping */
  const MODS = [
    { id: 'mirror', nameKey: 'dMirror', descKey: 'dMirrorD' },
    { id: 'ice', nameKey: 'dIce', descKey: 'dIceD' },
    { id: 'cream', nameKey: 'dCream', descKey: 'dCreamD' },
    { id: 'dark', nameKey: 'dDark', descKey: 'dDarkD' },
    { id: 'hunt', nameKey: 'dHunt', descKey: 'dHuntD' }
  ];

  let activeId = null; // the live run's modifier, null = a normal run

  /* the local date as YYYY-MM-DD — the day boundary follows the
     player's clock, not UTC */
  function dateStr() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  /* djb2 over the date string: deterministic and engine-independent
     (plain charCodeAt arithmetic, no built-in hash, no randomness) */
  function hashDate(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  function bestKey() {
    return 'cs_daily_' + dateStr();
  }

  CS.Daily = {
    /* the modifier of the day with its i18n keys and the raw seed */
    today: function () {
      const seed = hashDate(dateStr());
      const mod = MODS[seed % MODS.length];
      return {
        id: mod.id,
        nameKey: mod.nameKey,
        descKey: mod.descKey,
        seed: seed
      };
    },

    /* the live run's modifier id, or false for a normal run */
    active: function () {
      return activeId || false;
    },

    /* mark the live run as the day challenge (game.js startGame) */
    start: function () {
      activeId = CS.Daily.today().id;
      return activeId;
    },

    /* the challenge run is over / a normal run begins (game.js) */
    stop: function () {
      activeId = null;
    },

    /* today's best challenge score, 0 when nobody scored yet */
    best: function () {
      try {
        const v = parseInt(window.localStorage.getItem(bestKey()), 10);
        return Number.isFinite(v) && v > 0 ? v : 0;
      } catch (e) {
        return 0; // storage unavailable: no day best
      }
    },

    /* raise the day best (never lowers); returns the stored value */
    setBest: function (score) {
      const n = Math.floor(Number(score));
      if (Number.isFinite(n) && n > CS.Daily.best()) {
        try {
          window.localStorage.setItem(bestKey(), String(n));
        } catch (e) {
          /* storage unavailable: the record lives until reload */
        }
        return n;
      }
      return CS.Daily.best();
    }
  };
})();
