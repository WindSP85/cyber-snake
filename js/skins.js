/* ============================================================
   NEON://SNAKE — snake skins (feature T17, SPEC §17)
   CS.Skins owns the skin catalog, the unlock gates (achievement
   ids checked through CS.Ach.has) and the active skin persisted
   in localStorage key 'cs_skin'.

   Contract:
     CS.Skins.list()                 — [{id, nameKey, condKey, unlocked}]
     CS.Skins.has(id)                — this skin unlocked yet?
     CS.Skins.current()              — the active skin id ('neon' fallback)
     CS.Skins.select(id)             — pick an unlocked skin; false otherwise
     CS.Skins.colors(i, n, animTime) — css color of the segment i of n
     CS.Skins.alpha()                — whole-snake alpha (ghost = .65)
     CS.Skins.headGlow(animTime)     — the head shadow glow color
     CS.Skins.preview(id)            — 5 static swatch colors for ui.js

   Segment colors: every skin but 'rainbow' blends a head/tail HSL
   triple along the body; 'rainbow' derives the hue from the
   animation clock, 'ghost' keeps a pale gradient and dims the
   whole snake via alpha() (game.js applies it).
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  const SKIN_KEY = 'cs_skin';   // the active skin id
  const PREVIEW_SEGS = 5;       // mini-snake squares in a swatch
  const DEFAULT_ID = 'neon';

  /* head/tail: [hue, saturation, lightness]; 'ach' is the gate
     achievement id (null = free for everyone); 'alpha' optionally
     dims the whole snake (ghost) */
  const DEFS = [
    { id: 'neon', name: 'skinNeon', cond: null, ach: null,
      head: [186, 100, 50], tail: [311, 100, 58] },
    { id: 'ice', name: 'skinIce', cond: 'skinCondIce', ach: 'boss1',
      head: [190, 100, 58], tail: [220, 100, 68] },
    { id: 'toxic', name: 'skinToxic', cond: 'skinCondToxic', ach: 'lvl10',
      head: [100, 100, 50], tail: [140, 100, 58] },
    { id: 'magma', name: 'skinMagma', cond: 'skinCondMagma', ach: 'score2500',
      head: [20, 100, 52], tail: [350, 100, 60] },
    { id: 'gold', name: 'skinGold', cond: 'skinCondGold', ach: 'banker',
      head: [45, 100, 50], tail: [50, 100, 60] },
    { id: 'rainbow', name: 'skinRainbow', cond: 'skinCondRainbow', ach: 'boss5' },
    { id: 'ghost', name: 'skinGhost', cond: 'skinCondGhost', ach: 'mystery10',
      head: [0, 15, 92], tail: [210, 15, 80], alpha: 0.65 }
  ];

  /* ---------- state ---------- */

  let currentId = loadSkin();

  /* ---------- helpers ---------- */

  function defById(id) {
    for (let i = 0; i < DEFS.length; i++) {
      if (DEFS[i].id === id) return DEFS[i];
    }
    return null;
  }

  /* null gate = free; otherwise the achievement must be unlocked */
  function achOpen(ach) {
    if (!ach) return true;
    return !!(CS.Ach && typeof CS.Ach.has === 'function' && CS.Ach.has(ach));
  }

  function unlocked(id) {
    const def = defById(id);
    return !!def && achOpen(def.ach);
  }

  function hsl(h, s, l) {
    return 'hsl(' + Math.round(h) + ',' + Math.round(s) + '%,' + Math.round(l) + '%)';
  }

  /* the gradient skins: a straight head→tail HSL blend (t = 0..1) */
  function gradientColor(def, t) {
    const a = def.head;
    const b = def.tail;
    return hsl(
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t
    );
  }

  /* 'rainbow' ignores n and flows with the animation clock:
     hue = (animTime*60 + i*30) % 360, s = 100%, l = 55% */
  function colorOf(def, i, n, animTime) {
    if (def.id === 'rainbow') {
      const t = Number.isFinite(animTime) ? animTime : 0;
      const hue = (((t * 60 + i * 30) % 360) + 360) % 360;
      return hsl(hue, 100, 55);
    }
    return gradientColor(def, n <= 1 ? 0 : i / (n - 1));
  }

  /* ---------- persistence ---------- */

  function loadSkin() {
    let id = null;
    try {
      id = window.localStorage.getItem(SKIN_KEY);
    } catch (e) {
      id = null; // storage unavailable: the default skin runs
    }
    if (!unlocked(id)) return DEFAULT_ID; // unknown or re-locked
    return id;
  }

  function saveSkin() {
    try {
      window.localStorage.setItem(SKIN_KEY, currentId);
    } catch (e) {
      /* storage unavailable: the choice lives until reload */
    }
  }

  /* ---------- public API ---------- */

  CS.Skins = {
    /* the catalog for the skins screen (ui.js) */
    list: function () {
      const out = [];
      for (let i = 0; i < DEFS.length; i++) {
        out.push({
          id: DEFS[i].id,
          nameKey: DEFS[i].name,
          condKey: DEFS[i].cond,
          unlocked: unlocked(DEFS[i].id)
        });
      }
      return out;
    },

    /* unlocked yet? unknown ids are simply false */
    has: function (id) {
      return unlocked(String(id));
    },

    /* the active skin id; never a locked or unknown one */
    current: function () {
      return currentId;
    },

    /* pick a skin — only an unlocked one, otherwise false */
    select: function (id) {
      const sid = String(id);
      if (!unlocked(sid)) return false;
      currentId = sid;
      saveSkin();
      return true;
    },

    /* css color of the segment i of n for the active skin */
    colors: function (i, n, animTime) {
      return colorOf(defById(currentId) || DEFS[0], i, n, animTime);
    },

    /* whole-snake transparency (feature T17: the ghost skin) */
    alpha: function () {
      const def = defById(currentId) || DEFS[0];
      return typeof def.alpha === 'number' ? def.alpha : 1;
    },

    /* the glow around the head = the head color at this moment
       (the rainbow glow flows with animTime) */
    headGlow: function (animTime) {
      return colorOf(defById(currentId) || DEFS[0], 0, 1, animTime);
    },

    /* 5 static swatch colors (ui.js); the rainbow gets a full
       spectral spread instead of the clock-driven formula */
    preview: function (id) {
      const def = defById(id) || DEFS[0];
      const out = [];
      for (let k = 0; k < PREVIEW_SEGS; k++) {
        if (def.id === 'rainbow') {
          out.push(hsl(k * (360 / PREVIEW_SEGS), 100, 55));
        } else {
          out.push(gradientColor(def, k / (PREVIEW_SEGS - 1)));
        }
      }
      return out;
    }
  };
})();
