/* ============================================================
   NEON://SNAKE — UI layer (SPEC §7, §8)
   CS.UI.show / hud / bossBar / toast / banner / on
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  const SCREENS = ['menu', 'controls', 'pause', 'gameover'];
  const TOAST_MS = 1600;
  const HANDLER_KEYS = ['start', 'resume', 'restart', 'menu', 'mute'];

  const handlers = {
    start: null,
    resume: null,
    restart: null,
    menu: null,
    mute: null
  };

  let toastTimer = 0;
  let wired = false;

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const el = byId(id);
    if (el && value !== undefined && value !== null) {
      el.textContent = String(value);
    }
  }

  /* name = screen id, or null to hide every screen (game view) */
  function showScreen(name) {
    SCREENS.forEach(function (screen) {
      const el = byId('screen-' + screen);
      if (!el) return;
      if (screen === name) el.classList.remove('hidden');
      else el.classList.add('hidden');
    });
  }

  function fire(name) {
    if (typeof handlers[name] === 'function') handlers[name]();
  }

  function updateMuteLabel() {
    const btn = byId('mute-btn');
    if (!btn) return;
    let muted = false;
    if (CS.Audio && typeof CS.Audio.getMuted === 'function') {
      muted = !!CS.Audio.getMuted();
    }
    btn.textContent = muted ? 'Звук: выкл' : 'Звук: вкл';
    btn.classList.toggle('muted', muted);
  }

  function loadBest() {
    try {
      const best = parseInt(window.localStorage.getItem('cs_best'), 10);
      return Number.isFinite(best) && best > 0 ? best : 0;
    } catch (e) {
      return 0;
    }
  }

  function wire() {
    if (wired) return;
    wired = true;

    const bind = function (id, handler) {
      const el = byId(id);
      if (el) el.addEventListener('click', handler);
    };

    bind('btn-start', function () {
      fire('start');
      showScreen(null);
    });
    bind('btn-resume', function () {
      fire('resume');
      showScreen(null);
    });
    bind('btn-restart', function () {
      fire('restart');
      showScreen(null);
    });
    bind('btn-menu', function () {
      fire('menu');
      showScreen('menu');
    });
    bind('btn-menu2', function () {
      fire('menu');
      showScreen('menu');
    });
    bind('btn-controls', function () {
      showScreen('controls');
    });
    bind('btn-controls-back', function () {
      showScreen('menu');
    });
    bind('mute-btn', function () {
      fire('mute');
      updateMuteLabel();
    });
  }

  function init() {
    wire();
    updateMuteLabel();
    CS.UI.hud({ best: loadBest() });
  }

  CS.UI = {
    /* 'menu' | 'game' | 'pause' | 'gameover' — switch screen overlays */
    show: function (name) {
      if (name === 'game' || name === null || name === undefined) {
        showScreen(null);
        return;
      }
      if (SCREENS.indexOf(name) !== -1) showScreen(name);
    },

    /* Partial update: {score, best, level} */
    hud: function (patch) {
      if (!patch) return;
      if ('score' in patch) {
        setText('score', patch.score);
        setText('final-score', patch.score);
      }
      if ('best' in patch) {
        setText('best', patch.best);
        setText('menu-best', patch.best);
        setText('final-best', patch.best);
      }
      if ('level' in patch) {
        setText('level', patch.level);
      }
    },

    /* Boss HP bar; show === false hides it */
    bossBar: function (hp, maxHp, show, name) {
      const bar = byId('bossbar');
      if (!bar) return;
      if (show === false) {
        bar.classList.add('hidden');
        return;
      }
      bar.classList.remove('hidden');
      setText('bossname', name);
      const fill = byId('bossfill');
      if (!fill) return;
      const max = Number(maxHp) > 0 ? Number(maxHp) : 1;
      const ratio = Math.max(0, Math.min(1, Number(hp) / max));
      fill.style.width = (ratio * 100).toFixed(1) + '%';
    },

    /* Big central label, fades out by itself (~1.6s, timer resets) */
    toast: function (text) {
      const el = byId('toast');
      if (!el) return;
      setText('toast', text);
      el.classList.remove('show');
      void el.offsetWidth; /* restart the animation */
      el.classList.add('show');
      if (toastTimer) {
        window.clearTimeout(toastTimer);
        toastTimer = 0;
      }
      toastTimer = window.setTimeout(function () {
        el.classList.remove('show');
        toastTimer = 0;
      }, TOAST_MS);
    },

    /* #boss-banner warning strip */
    banner: function (text, show) {
      const el = byId('boss-banner');
      if (!el) return;
      if (text !== undefined && text !== null) {
        el.textContent = String(text);
      }
      el.classList.toggle('hidden', show === false);
    },

    /* Subscribe to button events: {start, resume, restart, menu, mute} */
    on: function (callbacks) {
      if (!callbacks) return;
      HANDLER_KEYS.forEach(function (key) {
        if (typeof callbacks[key] === 'function') {
          handlers[key] = callbacks[key];
        }
      });
      wire();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
