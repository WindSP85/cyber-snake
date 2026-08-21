/* ============================================================
   NEON://SNAKE — UI layer (SPEC §7, §8)
   CS.UI.show / hud / bossBar / toast / banner / renderBoard / on
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  const SCREENS = ['lang', 'menu', 'controls', 'board', 'pause', 'gameover'];
  const TOAST_MS = 1600;
  const CLEAR_CONFIRM_MS = 3000; // feature T10: "Sure?" arming window
  const HANDLER_KEYS = ['start', 'resume', 'restart', 'menu', 'mute', 'lang', 'save'];

  const handlers = {
    start: null,
    resume: null,
    restart: null,
    menu: null,
    mute: null,
    lang: null,
    save: null
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
    if (name === 'board') renderBoard(); // feature T10: fresh rows on every show
  }

  function fire(name) {
    if (typeof handlers[name] === 'function') handlers[name]();
  }

  /* ---------- feature T10: leaderboard (SPEC §13) ---------- */

  function appendCell(tr, text, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text;
    tr.appendChild(td);
  }

  /* rebuild the #board-list rows from CS.Leaderboard */
  function renderBoard() {
    const list = byId('board-list');
    if (!list) return;
    list.innerHTML = '';
    const entries = (CS.Leaderboard && typeof CS.Leaderboard.load === 'function')
      ? CS.Leaderboard.load()
      : [];
    if (!entries.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'board-empty';
      td.textContent = t('boardEmpty');
      tr.appendChild(td);
      list.appendChild(tr);
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const tr = document.createElement('tr');
      if (i < 3) tr.className = 'bd-top';
      appendCell(tr, String(i + 1), 'bd-place');
      appendCell(tr, e.name, 'bd-name');
      appendCell(tr, String(e.score), 'bd-score');
      appendCell(tr, String(e.level), 'bd-lvl');
      appendCell(tr, e.date, 'bd-date');
      list.appendChild(tr);
    }
  }

  /* the gameover name-save block — game.js decides when it shows */
  function hideScoreSave() {
    const el = byId('score-save');
    if (el) el.classList.add('hidden');
  }

  /* "Clear" uses a double-click confirm: the first click arms the
     button to "Sure?" for CLEAR_CONFIRM_MS, the second one wipes */
  let clearArmed = false;
  let clearTimer = 0;

  function setClearArmed(on) {
    clearArmed = on;
    const btn = byId('btn-board-clear');
    if (!btn) return;
    btn.textContent = t(on ? 'boardSure' : 'boardClear');
    btn.classList.toggle('sure', on);
  }

  function resetClearConfirm() {
    if (clearTimer) {
      window.clearTimeout(clearTimer);
      clearTimer = 0;
    }
    if (clearArmed) setClearArmed(false);
  }

  /* i18n translate (i18n.js always loads before this file) */
  function t(key) {
    return CS.I18N && typeof CS.I18N.t === 'function' ? CS.I18N.t(key) : key;
  }

  function updateMuteLabel() {
    const btn = byId('mute-btn');
    if (!btn) return;
    let muted = false;
    if (CS.Audio && typeof CS.Audio.getMuted === 'function') {
      muted = !!CS.Audio.getMuted();
    }
    const key = muted ? 'soundOff' : 'soundOn';
    btn.textContent = muted ? '🔇' : '🔊';
    btn.title = t(key);
    btn.setAttribute('data-i18n-title', key);
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

  /* switch the language and leave the language screen back to the menu */
  function applyLang(code) {
    if (CS.I18N && typeof CS.I18N.set === 'function') CS.I18N.set(code);
    showScreen('menu');
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
    bind('btn-board', function () {
      showScreen('board');
    });
    bind('btn-board-back', function () {
      resetClearConfirm();
      showScreen('menu');
    });
    bind('btn-board-clear', function () {
      if (!clearArmed) {
        setClearArmed(true);
        if (clearTimer) window.clearTimeout(clearTimer);
        clearTimer = window.setTimeout(function () {
          clearTimer = 0;
          setClearArmed(false);
        }, CLEAR_CONFIRM_MS);
        return;
      }
      resetClearConfirm();
      if (CS.Leaderboard && typeof CS.Leaderboard.clear === 'function') {
        CS.Leaderboard.clear();
      }
      renderBoard();
    });
    bind('btn-save', function () {
      hideScoreSave();
      fire('save');
    });
    bind('mute-btn', function () {
      fire('mute');
      updateMuteLabel();
    });

    // language screen (feature T7): pick a language, then go to the menu;
    // the 🌐 button only fires the 'lang' callback — game.js decides
    bind('btn-lang', function () {
      fire('lang');
    });
    bind('btn-lang-ru', function () {
      applyLang('ru');
    });
    bind('btn-lang-en', function () {
      applyLang('en');
    });

    // feature T12: portrait D-pad — replay tile taps as arrow keydowns;
    // game.js already listens for document keydown by e.code
    document.addEventListener('click', function (e) {
      const b = e.target && e.target.closest ? e.target.closest('.dpad-btn') : null;
      if (!b) return;
      document.dispatchEvent(new KeyboardEvent('keydown', { code: b.dataset.dir, bubbles: true }));
    });
  }

  function init() {
    wire();
    updateMuteLabel();
    CS.UI.hud({ best: loadBest() });
  }

  CS.UI = {
    /* 'lang' | 'menu' | 'game' | 'pause' | 'gameover' — switch screen overlays */
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

    /* feature T10: rebuild the leaderboard rows right now */
    renderBoard: function () {
      renderBoard();
    },

    /* Subscribe to button events: {start, resume, restart, menu, mute, lang, save} */
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
