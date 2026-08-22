/* ============================================================
   NEON://SNAKE — meta-progression upgrades (feature T19, SPEC §19)
   CS.Upg owns the data-chip bank (localStorage key 'cs_chips') and
   the 4 upgrades x 3 levels grid (localStorage key 'cs_upg' =
   {id: level}).

   Contract:
     CS.Upg.chips()        — current chip balance
     CS.Upg.earnRun(score) — bank floor(score/100), return the payout
     CS.Upg.list()         — [{id, nameKey, descKey, level, cost,
                             affordable}] for the shop screen
                             (cost = the next level price, null at max)
     CS.Upg.buy(id)        — pay for the next level; false when broke,
                             already maxed or unknown id
     CS.Upg.val(id)        — effective value for game.js:
                               life     0..3            extra start lives
                               magnet   0..3            radius bonus over the base 3
                               duration 1/1.4/1.8/2.2   effect time multiplier
                               luck     1/.8/.64/.512   pickup spawn interval
                             multiplier

   Chips are earned in game.js finishGameOver(): floor(score/100).
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  const CHIPS_KEY = 'cs_chips'; // the bank, integer chips
  const UPG_KEY = 'cs_upg';     // the bought levels, {id: level}
  const MAX_LEVEL = 3;

  /* the catalog: i18n keys and the per-level chip prices
     (costs[level] = the price of the level -> level + 1) */
  const DEFS = [
    { id: 'life', name: 'upgLife', desc: 'upgLifeD', costs: [30, 90, 200] },
    { id: 'magnet', name: 'upgMagnet', desc: 'upgMagnetD', costs: [25, 70, 150] },
    { id: 'duration', name: 'upgDuration', desc: 'upgDurationD', costs: [40, 100, 220] },
    { id: 'luck', name: 'upgLuck', desc: 'upgLuckD', costs: [35, 80, 180] }
  ];

  /* ---------- state ---------- */

  let chips = loadChips();
  let levels = loadLevels();

  /* ---------- helpers ---------- */

  function defById(id) {
    for (let i = 0; i < DEFS.length; i++) {
      if (DEFS[i].id === id) return DEFS[i];
    }
    return null;
  }

  function levelOf(id) {
    const v = levels[id];
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.min(MAX_LEVEL, Math.floor(v));
  }

  /* ---------- persistence ---------- */

  function loadChips() {
    try {
      const v = parseInt(window.localStorage.getItem(CHIPS_KEY), 10);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (e) {
      return 0; // storage unavailable: an empty bank
    }
  }

  function saveChips() {
    try {
      window.localStorage.setItem(CHIPS_KEY, String(chips));
    } catch (e) {
      /* storage unavailable: the bank lives until reload */
    }
  }

  function loadLevels() {
    const out = {};
    try {
      const raw = window.localStorage.getItem(UPG_KEY);
      const data = raw ? JSON.parse(raw) : null;
      if (data && typeof data === 'object') {
        for (let i = 0; i < DEFS.length; i++) {
          const v = parseInt(data[DEFS[i].id], 10);
          if (Number.isFinite(v) && v > 0) {
            out[DEFS[i].id] = Math.min(MAX_LEVEL, Math.floor(v));
          }
        }
      }
    } catch (e) {
      /* corrupted or unavailable: every upgrade stays at level 0 */
    }
    return out;
  }

  function saveLevels() {
    try {
      window.localStorage.setItem(UPG_KEY, JSON.stringify(levels));
    } catch (e) {
      /* storage unavailable: the levels live until reload */
    }
  }

  /* ---------- public API ---------- */

  CS.Upg = {
    /* the current chip balance */
    chips: function () {
      return chips;
    },

    /* pay floor(score/100) chips into the bank; returns the payout
       (0 when the run scored under 100) */
    earnRun: function (score) {
      const n = Math.floor(Number(score) / 100);
      if (!Number.isFinite(n) || n <= 0) return 0;
      chips += n;
      saveChips();
      return n;
    },

    /* the shop catalog for the upgrades screen (ui.js) */
    list: function () {
      const out = [];
      for (let i = 0; i < DEFS.length; i++) {
        const def = DEFS[i];
        const lvl = levelOf(def.id);
        const cost = lvl < MAX_LEVEL ? def.costs[lvl] : null;
        out.push({
          id: def.id,
          nameKey: def.name,
          descKey: def.desc,
          level: lvl,
          cost: cost,
          affordable: cost !== null && chips >= cost
        });
      }
      return out;
    },

    /* buy the next level; false when broke, maxed or unknown */
    buy: function (id) {
      const def = defById(id);
      if (!def) return false;
      const lvl = levelOf(def.id);
      if (lvl >= MAX_LEVEL) return false;
      const cost = def.costs[lvl];
      if (chips < cost) return false;
      chips -= cost;
      levels[def.id] = lvl + 1;
      saveChips();
      saveLevels();
      return true;
    },

    /* the effective value game.js multiplies in (see the header);
     rounding kills the float dust so 2.2 is exactly 2.2 */
    val: function (id) {
      const lvl = levelOf(id);
      if (id === 'duration') {
        return Math.round((1 + 0.4 * lvl) * 1000) / 1000;
      }
      if (id === 'luck') {
        return Math.round(Math.pow(0.8, lvl) * 1000) / 1000;
      }
      return lvl; // life / magnet: the plain per-level addend
    }
  };
})();
