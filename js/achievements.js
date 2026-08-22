/* ============================================================
   NEON://SNAKE — achievements (feature T16, SPEC §16)
   CS.Ach: 13 achievements unlocked by gameplay events.

   Contract (called from game.js):
     CS.Ach.event(name, value) — 'meal' | 'bossDown' | 'level' |
       'score' | 'jackpot' | 'coresCaught' | 'bankConverted' |
       'mystery' | 'respawn'; value carries the number where it
       matters (level reached, current score, segments banked).
     CS.Ach.resetRun()        — startGame: per-run counters to 0
     CS.Ach.has(id)           — unlocked yet? (feature T17 skins ask)
     CS.Ach.count()           — {unlocked, total}
     CS.Ach.list()            — card data for the screen (ui.js)

   Persistence: cs_ach = [id, ...] (all-time unlocks) and
   cs_k_total = {bossKills, jackpots, mysteries} (all-time
   counters) — both survive reloads; the per-run counters
   (cores caught, respawns spent) live in memory only and are
   wiped by resetRun() on every startGame.

   The unlock toast is this module's own #ach-toast DOM node
   (fixed, top-center, yellow frame, queued) — CS.UI stays
   untouched.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  const ACH_KEY = 'cs_ach';       // unlocked ids, all-time
  const TOTALS_KEY = 'cs_k_total'; // lifetime counters, all-time
  const TOAST_MS = 2200;          // unlock toast lifetime, ms
  const TOAST_GAP = 180;          // pause between queued toasts, ms

  /* ordered card list (screen order); the conditions live in event() */
  const DEFS = [
    { id: 'firstMeal', name: 'achFirstMeal', desc: 'aFirstMeal' },
    { id: 'boss1', name: 'achBoss1', desc: 'aBoss1' },
    { id: 'boss5', name: 'achBoss5', desc: 'aBoss5' },
    { id: 'lvl5', name: 'achLvl5', desc: 'aLvl5' },
    { id: 'lvl10', name: 'achLvl10', desc: 'aLvl10' },
    { id: 'score1000', name: 'achScore1000', desc: 'aScore1000' },
    { id: 'score2500', name: 'achScore2500', desc: 'aScore2500' },
    { id: 'jackpot', name: 'achJackpot', desc: 'aJackpot' },
    { id: 'jackpot3', name: 'achJackpot3', desc: 'aJackpot3' },
    { id: 'cores', name: 'achCores', desc: 'aCores' },
    { id: 'banker', name: 'achBanker', desc: 'aBanker' },
    { id: 'mystery10', name: 'achMystery10', desc: 'aMystery10' },
    { id: 'survivor', name: 'achSurvivor', desc: 'aSurvivor' }
  ];

  /* ---------- state ---------- */

  let unlocked = loadUnlocked();
  let totals = loadTotals();
  const run = { cores: 0, respawns: 0 }; // wiped by resetRun()

  /* ---------- helpers ---------- */

  function t(key) {
    return CS.I18N && typeof CS.I18N.t === 'function' ? CS.I18N.t(key) : key;
  }

  function defById(id) {
    for (let i = 0; i < DEFS.length; i++) {
      if (DEFS[i].id === id) return DEFS[i];
    }
    return null;
  }

  function known(id) {
    return defById(id) !== null;
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /* ---------- persistence ---------- */

  function loadUnlocked() {
    try {
      const raw = window.localStorage.getItem(ACH_KEY);
      const data = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(data)) return [];
      const ids = [];
      for (let i = 0; i < data.length; i++) {
        const id = String(data[i]);
        if (known(id) && ids.indexOf(id) === -1) ids.push(id);
      }
      return ids;
    } catch (e) {
      return []; // storage unavailable or corrupt: start empty
    }
  }

  function saveUnlocked() {
    try {
      window.localStorage.setItem(ACH_KEY, JSON.stringify(unlocked));
    } catch (e) {
      /* storage unavailable: unlocks live until the next reload */
    }
  }

  function loadTotals() {
    const zero = { bossKills: 0, jackpots: 0, mysteries: 0 };
    try {
      const raw = window.localStorage.getItem(TOTALS_KEY);
      const data = raw ? JSON.parse(raw) : null;
      if (!data || typeof data !== 'object') return zero;
      return {
        bossKills: Math.max(0, Math.floor(Number(data.bossKills) || 0)),
        jackpots: Math.max(0, Math.floor(Number(data.jackpots) || 0)),
        mysteries: Math.max(0, Math.floor(Number(data.mysteries) || 0))
      };
    } catch (e) {
      return zero;
    }
  }

  function saveTotals() {
    try {
      window.localStorage.setItem(TOTALS_KEY, JSON.stringify(totals));
    } catch (e) {
      /* storage unavailable: counters live until the next reload */
    }
  }

  /* ---------- unlock toast: own DOM node, CS.UI untouched ---------- */

  let toastEl = null;
  let toastQueue = [];
  let toastBusy = false;

  function ensureToast() {
    if (toastEl) return toastEl;
    try {
      toastEl = document.createElement('div');
      toastEl.id = 'ach-toast';
      if (document.body && typeof document.body.appendChild === 'function') {
        document.body.appendChild(toastEl);
      }
    } catch (e) {
      toastEl = null; // no DOM (headless test): unlocks stay silent
    }
    return toastEl;
  }

  function nextToast() {
    if (!toastQueue.length) {
      toastBusy = false;
      return;
    }
    toastBusy = true;
    const el = ensureToast();
    const text = toastQueue.shift();
    if (el && el.classList) {
      el.textContent = '★ ' + text;
      el.classList.remove('show');
      void el.offsetWidth; /* restart the CSS transition */
      el.classList.add('show');
    }
    window.setTimeout(function () {
      if (el && el.classList) el.classList.remove('show');
      window.setTimeout(nextToast, TOAST_GAP);
    }, TOAST_MS);
  }

  function queueToast(text) {
    toastQueue.push(text);
    if (!toastBusy) nextToast();
  }

  /* ---------- unlock ---------- */

  function unlock(id) {
    if (unlocked.indexOf(id) !== -1) return; // never duplicated
    unlocked.push(id);
    saveUnlocked();
    const def = defById(id);
    queueToast(def ? t(def.name) : id);
    if (CS.Audio && typeof CS.Audio.sfx === 'function') {
      CS.Audio.sfx('ach'); // before ensure() it is ignored there
    }
  }

  /* ---------- events (the only condition surface) ---------- */

  function event(name, value) {
    switch (name) {
      case 'meal':
        unlock('firstMeal');
        break;
      case 'bossDown':
        totals.bossKills++;
        saveTotals();
        unlock('boss1');
        if (totals.bossKills >= 5) unlock('boss5');
        break;
      case 'level':
        if (num(value) >= 5) unlock('lvl5');
        if (num(value) >= 10) unlock('lvl10');
        break;
      case 'score':
        if (num(value) >= 1000) unlock('score1000');
        if (num(value) >= 2500) unlock('score2500');
        break;
      case 'jackpot':
        totals.jackpots++;
        saveTotals();
        unlock('jackpot');
        if (totals.jackpots >= 3) unlock('jackpot3');
        break;
      case 'coresCaught':
        run.cores++;
        if (run.cores >= 2) unlock('cores'); // both cores in one run
        break;
      case 'bankConverted':
        if (num(value) >= 8) unlock('banker');
        break;
      case 'mystery':
        totals.mysteries++;
        saveTotals();
        if (totals.mysteries >= 10) unlock('mystery10');
        break;
      case 'respawn':
        run.respawns++;
        if (run.respawns >= 3) unlock('survivor'); // all 3 lives spent
        break;
      default:
        break; // unknown events are ignored
    }
  }

  /* ---------- public API ---------- */

  CS.Ach = {
    /* gameplay event hook from game.js */
    event: function (name, value) {
      event(name, value);
    },

    /* a fresh run: per-run counters start from zero (unlocks stay) */
    resetRun: function () {
      run.cores = 0;
      run.respawns = 0;
    },

    /* unlocked yet? unknown ids are simply false */
    has: function (id) {
      return unlocked.indexOf(String(id)) !== -1;
    },

    /* {unlocked, total} for the screen header */
    count: function () {
      return { unlocked: unlocked.length, total: DEFS.length };
    },

    /* card data for ui.js: [{id, nameKey, descKey, unlocked}] */
    list: function () {
      const out = [];
      for (let i = 0; i < DEFS.length; i++) {
        out.push({
          id: DEFS[i].id,
          nameKey: DEFS[i].name,
          descKey: DEFS[i].desc,
          unlocked: unlocked.indexOf(DEFS[i].id) !== -1
        });
      }
      return out;
    }
  };
})();
