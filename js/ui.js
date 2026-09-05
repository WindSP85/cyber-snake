/* ============================================================
   NEON://SNAKE — UI layer (SPEC §7, §8)
   CS.UI.show / hud / bossBar / toast / banner / renderBoard / on
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  // feature T24: 'duel' (the lobby) + 'duelresult' (the match result);
  // feature T25: 'battles' (the local duel history)
  const SCREENS = ['lang', 'menu', 'controls', 'board', 'ach', 'skins', 'upg', 'pause', 'gameover', 'duel', 'duelresult', 'battles'];
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
    if (name === 'ach') renderAch(); // feature T16: fresh cards on every show
    if (name === 'skins') renderSkins(); // feature T17: fresh swatches on every show
    if (name === 'upg') renderUpg(); // feature T19: fresh cards on every show
    if (name === 'battles') renderBattles(); // feature T25: fresh rows on every show
  }

  function fire(name) {
    if (typeof handlers[name] === 'function') handlers[name]();
  }

  /* ---------- feature T10: leaderboard (SPEC §13; T14: global) ---------- */

  function appendCell(tr, text, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text;
    tr.appendChild(td);
  }

  function loadBoard() {
    return (CS.Leaderboard && typeof CS.Leaderboard.load === 'function')
      ? CS.Leaderboard.load()
      : [];
  }

  /* rebuild the #board-list rows from an entry array */
  function renderBoardRows(entries) {
    const list = byId('board-list');
    if (!list) return;
    list.innerHTML = '';
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

  /* ---------- feature T14: board mode badge + remote refresh ---------- */

  /* one remote refresh at a time: a render while another request is
     still in flight must not fire a second fetch */
  let boardFetching = false;

  /* the mode badge lives right under the board screen title; a JS-made
     span so the markup (and the local-mode layout) stays untouched.
     feature T20: badges stack in creation order below the title — the
     mode badge first, the season badge right under it */
  function boardBadge(id) {
    const existing = byId(id);
    if (existing) return existing;
    const screen = byId('screen-board');
    if (!screen || typeof screen.querySelector !== 'function') return null;
    const title = screen.querySelector('.screen-title');
    if (!title || !title.parentNode) return null;
    const el = document.createElement('span');
    el.id = id;
    el.className = 'board-mode';
    let anchor = title.nextSibling;
    while (anchor && anchor.nodeType === 1 && anchor.classList &&
      anchor.classList.contains('board-mode')) {
      anchor = anchor.nextSibling; // skip the badges already on screen
    }
    title.parentNode.insertBefore(el, anchor);
    return el;
  }

  /* i18n key → badge text; null/'' → the badge is removed */
  function setBoardMode(key) {
    const el = byId('board-mode');
    if (!key) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    const badge = boardBadge('board-mode');
    if (badge) badge.textContent = t(key);
  }

  /* the "loading…" strip under the badge while a fetch is pending */
  function setBoardLoading(on) {
    const el = byId('board-loading');
    if (!on) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    const badge = boardBadge('board-loading');
    if (badge) badge.textContent = t('boardLoading');
  }

  /* feature T20 (SPEC §20): the "СЕЗОН: MM.YYYY" badge under the mode
     badge — shown in every global-mode outcome (even when the remote
     fetch degraded to the local rows); removed in local mode */
  function setBoardSeason(show) {
    const el = byId('board-season');
    if (!show) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    const season = (CS.Leaderboard &&
      typeof CS.Leaderboard.season === 'function')
      ? CS.Leaderboard.season()
      : '';
    if (!/^\d{4}-\d{2}$/.test(season)) return;
    const badge = boardBadge('board-season');
    if (badge) {
      // 'YYYY-MM' → the MM.YYYY display form (i18n seasonBadge '{1}')
      badge.textContent = t('seasonBadge',
        season.slice(5) + '.' + season.slice(0, 4));
    }
  }

  /* local rows instantly; in global mode the badge goes up right away
     and a guarded fetchRemote re-renders with the cloud top — or, on
     any failure, falls back to the local board with an offline badge.
     Every re-render refetches, so a fresh submit (which calls this
     right after CS.Leaderboard.submit) always shows current data. */
  function renderBoard() {
    const list = byId('board-list');
    if (!list) return;
    const global = !!(CS.Leaderboard &&
      typeof CS.Leaderboard.isGlobal === 'function' &&
      CS.Leaderboard.isGlobal());
    if (!global) {
      setBoardMode(null);
      setBoardSeason(false); // feature T20: no season outside the cloud
      setBoardLoading(false);
      renderBoardRows(loadBoard());
      return;
    }
    setBoardMode('boardGlobal');
    setBoardSeason(true); // feature T20: the badge shows in every outcome
    renderBoardRows(loadBoard()); // instant placeholder while loading
    if (boardFetching) return;    // fetch guard: one request at a time
    boardFetching = true;
    setBoardLoading(true);
    CS.Leaderboard.fetchRemote(function (rows) {
      boardFetching = false;
      setBoardLoading(false);
      if (rows && rows.length) {
        setBoardMode('boardGlobal');
        renderBoardRows(rows);
      } else {
        setBoardMode('boardLocal');
        renderBoardRows(loadBoard());
      }
    });
  }

  /* ---------- feature T16: achievements screen (SPEC §16) ---------- */

  /* rebuild the #ach-grid cards + the "N of 13" header; unlocked
     cards shine (yellow star + bright name), locked ones keep a dim
     outline but still show the condition — motivation, not mystery */
  function renderAch() {
    const grid = byId('ach-grid');
    if (!grid) return;
    const list = (CS.Ach && typeof CS.Ach.list === 'function')
      ? CS.Ach.list()
      : [];
    const cnt = (CS.Ach && typeof CS.Ach.count === 'function')
      ? CS.Ach.count()
      : { unlocked: 0, total: list.length };
    /* achOf carries '{1} of {2}': {1} goes through t(), {2} manually */
    setText('ach-count', t('achOf', cnt.unlocked).replace('{2}', String(cnt.total)));
    grid.innerHTML = '';
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const card = document.createElement('div');
      card.className = 'ach-card' + (a.unlocked ? ' unlocked' : '');
      const star = document.createElement('span');
      star.className = 'ach-star';
      star.textContent = a.unlocked ? '★' : '☆';
      const name = document.createElement('span');
      name.className = 'ach-name';
      name.textContent = t(a.nameKey);
      const desc = document.createElement('span');
      desc.className = 'ach-desc';
      desc.textContent = t(a.descKey);
      card.appendChild(star);
      card.appendChild(name);
      card.appendChild(desc);
      grid.appendChild(card);
    }
  }

  /* ---------- feature T17: skins screen (SPEC §17) ---------- */

  /* rebuild the #skins-grid swatches: each card is a 5-segment mini
     snake preview (static colors from CS.Skins.preview), the name and
     — for locked skins — the unlock condition; the active skin shines
     with a yellow frame + ✓; a click on an unlocked card selects it */
  function renderSkins() {
    const grid = byId('skins-grid');
    if (!grid) return;
    const list = (CS.Skins && typeof CS.Skins.list === 'function')
      ? CS.Skins.list()
      : [];
    const active = (CS.Skins && typeof CS.Skins.current === 'function')
      ? CS.Skins.current()
      : '';
    const preview = (CS.Skins && typeof CS.Skins.preview === 'function')
      ? function (id) { return CS.Skins.preview(id); }
      : function () { return []; };
    grid.innerHTML = '';
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const isActive = s.id === active;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'skin-card' + (isActive ? ' active' : '') +
        (s.unlocked ? '' : ' locked');
      const row = document.createElement('span');
      row.className = 'skin-preview';
      const colors = preview(s.id);
      for (let k = 0; k < colors.length; k++) {
        const seg = document.createElement('i');
        seg.className = 'skin-seg' + (k === 0 ? ' head' : '');
        seg.style.background = colors[k];
        if (k === 0) seg.style.boxShadow = '0 0 8px ' + colors[k];
        row.appendChild(seg);
      }
      const name = document.createElement('span');
      name.className = 'skin-name';
      name.textContent = t(s.nameKey);
      card.appendChild(row);
      card.appendChild(name);
      const mark = document.createElement('span');
      mark.className = 'skin-mark';
      mark.textContent = isActive ? '✓' : (s.unlocked ? '' : '🔒');
      card.appendChild(mark);
      if (!s.unlocked && s.condKey) {
        const cond = document.createElement('span');
        cond.className = 'skin-cond';
        cond.textContent = t(s.condKey);
        card.appendChild(cond);
        card.disabled = true; // a locked skin is not clickable
      } else if (s.unlocked) {
        card.addEventListener('click', function () {
          if (CS.Skins && typeof CS.Skins.select === 'function') {
            CS.Skins.select(s.id);
          }
          renderSkins(); // re-render: the ✓ moves to the new skin
        });
      }
      grid.appendChild(card);
    }
  }

  /* ---------- feature T19: upgrades screen (SPEC §19) ---------- */

  /* rebuild the #upg-grid cards: name, description, level pips
     (◾◾◽), the next-level price (or MAX) and the BUY button.
     The button dims and shows the current chip balance while the
     next level cannot be paid for; a successful buy plays 'levelup'
     and re-renders (a refused one just re-renders — the global
     button handler has already played 'click') */
  function renderUpg() {
    const grid = byId('upg-grid');
    if (!grid) return;
    const upg = CS.Upg || {};
    const list = typeof upg.list === 'function' ? upg.list() : [];
    const balance = typeof upg.chips === 'function' ? upg.chips() : 0;
    setText('upg-chips', t('upgChips', balance));
    grid.innerHTML = '';
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      const maxed = u.cost === null;
      const card = document.createElement('div');
      card.className = 'upg-card' + (maxed ? ' maxed' : '');
      const name = document.createElement('span');
      name.className = 'upg-name';
      name.textContent = t(u.nameKey);
      const desc = document.createElement('span');
      desc.className = 'upg-desc';
      desc.textContent = t(u.descKey);
      const meta = document.createElement('span');
      meta.className = 'upg-meta';
      const lvl = document.createElement('span');
      lvl.className = 'upg-level';
      lvl.textContent = new Array(u.level + 1).join('◾') +
        new Array(4 - u.level).join('◽');
      const cost = document.createElement('span');
      cost.className = 'upg-cost' + (maxed ? ' max' : '');
      cost.textContent = maxed ? t('upgMax') : t('upgChips', u.cost);
      meta.appendChild(lvl);
      meta.appendChild(cost);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small upg-buy' +
        (u.affordable ? '' : ' dim');
      btn.textContent = maxed ? t('upgMax')
        : (u.affordable ? t('upgBuy') : t('upgChips', balance));
      btn.addEventListener('click', function () {
        if (typeof upg.buy === 'function' && upg.buy(u.id)) {
          CS.Audio.sfx('levelup'); // the purchase fanfare
        }
        renderUpg(); // fresh pips, prices and the balance
      });
      card.appendChild(name);
      card.appendChild(desc);
      card.appendChild(meta);
      card.appendChild(btn);
      grid.appendChild(card);
    }
  }

  /* ---------- feature T25: my battles screen (the duel history) ---------- */

  /* rebuild #battles-stats + #battles-list from CS.DuelUI: the stats
     line «ПОБЕДЫ: n · ПОРАЖЕНИЯ: n · 🔥 СЕРИЯ: n», then one mono row
     per battle — a colored W/L/D marker, the rival's name, the score
     (my view) and the date; an empty history shows battlesEmpty */
  function renderBattles() {
    const list = byId('battles-list');
    if (!list) return;
    const duel = CS.DuelUI || {};
    const stats = typeof duel.stats === 'function'
      ? duel.stats()
      : { w: 0, l: 0, streak: 0 };
    const rows = typeof duel.history === 'function' ? duel.history() : [];
    setText('battles-stats',
      t('battlesWins', stats.w) + ' · ' + t('battlesLosses', stats.l) +
      ' · 🔥 ' + t('battlesStreak', stats.streak));
    list.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'battles-empty';
      empty.textContent = t('battlesEmpty');
      list.appendChild(empty);
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      const b = rows[i] || {};
      const r = b.r === 'win' ? 'win' : b.r === 'loss' ? 'loss' : 'draw';
      const row = document.createElement('div');
      row.className = 'battle-row battle-' + r;
      const mark = document.createElement('span');
      mark.className = 'battle-mark';
      mark.textContent = r === 'win' ? 'W' : r === 'loss' ? 'L' : 'D';
      const key = r === 'win' ? 'battleW' : r === 'loss' ? 'battleL' : 'battleD';
      mark.title = t(key); // the full word as the marker tooltip
      const name = document.createElement('span');
      name.className = 'battle-name';
      name.textContent = b.foe;
      const score = document.createElement('span');
      score.className = 'battle-score';
      score.textContent = b.sc;
      const date = document.createElement('span');
      date.className = 'battle-date';
      date.textContent = b.d;
      row.appendChild(mark);
      row.appendChild(name);
      row.appendChild(score);
      row.appendChild(date);
      list.appendChild(row);
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
  function t(key, arg) {
    return CS.I18N && typeof CS.I18N.t === 'function' ? CS.I18N.t(key, arg) : key;
  }

  /* ---------- feature T21: menu volume sliders (SPEC §21) ---------- */

  /* slider position <- CS.Audio volume (0..1 -> 0..100) */
  function syncVolumeSliders() {
    const music = byId('vol-music');
    const sfx = byId('vol-sfx');
    if (music && CS.Audio && typeof CS.Audio.getMusicVol === 'function') {
      music.value = String(Math.round(CS.Audio.getMusicVol() * 100));
    }
    if (sfx && CS.Audio && typeof CS.Audio.getSfxVol === 'function') {
      sfx.value = String(Math.round(CS.Audio.getSfxVol() * 100));
    }
  }

  /* the sliders live only in the menu panel (hidden with it on every
     other screen); each input event applies + persists the volume */
  function wireVolumeSliders() {
    const music = byId('vol-music');
    const sfx = byId('vol-sfx');
    syncVolumeSliders();
    if (music) {
      music.addEventListener('input', function () {
        if (CS.Audio && typeof CS.Audio.setMusicVol === 'function') {
          CS.Audio.setMusicVol(Number(music.value) / 100);
        }
      });
    }
    if (sfx) {
      sfx.addEventListener('input', function () {
        if (CS.Audio && typeof CS.Audio.setSfxVol === 'function') {
          CS.Audio.setSfxVol(Number(sfx.value) / 100);
        }
      });
    }
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
    // applyLang перезапишет текст кнопки лобби из data-i18n — вернём счётчик
    if (CS.DuelUI && typeof CS.DuelUI.menuCountSync === 'function') {
      CS.DuelUI.menuCountSync();
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
    // feature T16: achievements screen (menu button + back)
    bind('btn-ach', function () {
      showScreen('ach');
    });
    bind('btn-ach-back', function () {
      showScreen('menu');
    });
    // feature T17: skins screen (menu button + back)
    bind('btn-skins', function () {
      showScreen('skins');
    });
    bind('btn-skins-back', function () {
      showScreen('menu');
    });
    // feature T19: upgrades screen (menu button + back)
    bind('btn-upg', function () {
      showScreen('upg');
    });
    bind('btn-upg-back', function () {
      showScreen('menu');
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
    // game.js already listens for document keydown by e.code;
    // pointerdown = the turn registers the moment the finger TOUCHES the
    // tile (click would wait for the release — perceptible lag on phones)
    document.addEventListener('pointerdown', function (e) {
      const b = e.target && e.target.closest ? e.target.closest('.dpad-btn') : null;
      if (!b) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      document.dispatchEvent(new KeyboardEvent('keydown', { code: b.dataset.dir, bubbles: true }));
    });
    document.addEventListener('click', function (e) {
      // swallow the ghost click that follows our preventDefault'ed press
      if (e.target && e.target.closest && e.target.closest('.dpad-btn')) e.preventDefault();
    });
  }

  function init() {
    wire();
    updateMuteLabel();
    wireVolumeSliders(); // feature T21: menu music/sfx sliders
    CS.UI.hud({ best: loadBest() });
    // номер сборки в углу — единственный честный признак версии
    const badge = document.getElementById('ver-badge');
    if (badge) {
      const b = window.CS && CS.Config && CS.Config.build;
      badge.textContent = b ? 'СБОРКА ' + b : '';
    }
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

    /* feature T25: rebuild the battles rows right now */
    renderBattles: function () {
      renderBattles();
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
