/* ============================================================
   NEON://SNAKE — online duel lobby ui (feature T24, SPEC §22)
   CS.DuelUI is the whole duel user journey over the T22 transport
   (CS.Net) and the T23 simulation (CS.Duel): the menu entry, the
   lobby (create a room / join by code), the t.me deep link, the
   host start protocol, the result screen with the rematch
   handshake and every network error mapping.

   Roles (SPEC §22): the room creator is the HOST (myIndex 0, the
   simulated authority), everyone who joins by code or deep link is
   the GUEST (myIndex 1). Start protocol: the host sees the rival
   in presence and broadcasts start{seed}; both sides then call
   CS.Game.startDuel({host, myIndex, onMatchEnd}) — the guest also
   greets with hello{} right after its join (the name already lives
   in presence). Rematch: both sides press РЕВАНШ, the host starts
   the new match with a fresh seed as soon as both flags are up.
   A rival presence drop mid-match aborts the duel (result
   'aborted' → «СОПЕРНИК ПОКИНУЛ»); after the match end it only
   locks the rematch button.

   Feature T25 (the duel sociology): every finished match (win,
   loss, draw — never an abort) is saved into the local 'cs_duels'
   history (up to 20, newest first). The lobby wears the «🔥 N
   ПОДРЯД» badge on a 3+ win streak, the battles screen (ui.js
   renderBattles) shows the stats + the last rows, and a win with
   a known rival name offers the t.me brag share. The history is
   purely local — it is written from the PC browser too.

   Every user-visible string is an i18n key; offline / file:// the
   transport degrades silently and the lobby shows the inline
   'no network' error and nothing else.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  /* ---------- constants ---------- */

  const LINK_URL = 'https://t.me/windspsnake_bot/snake?startapp=room-';
  const LINK_TEXT = 't.me/windspsnake_bot/snake?startapp=room-';
  const CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;     // the net.js code alphabet (no 0/O/1/I)
  const DEEP_RE = /^room-([A-HJ-NP-Z2-9]{4})$/i;
  const COPIED_MS = 2000;                    // «СКОПИРОВАНО» flash length
  const DUELS_KEY = 'cs_duels';              // feature T25: the local history
  const DUELS_MAX = 20;                      // the newest 20 battles only
  const STREAK_MIN = 3;                      // «🔥 N ПОДРЯД» badge threshold
  const BRAG_URL = 'https://t.me/windspsnake_bot/snake'; // the brag target

  /* ---------- state ---------- */

  let wired = false;
  let mode = 'idle';        // 'idle' | 'host' | 'guest'
  let roomCode = '';
  let connected = false;    // CS.Net.join settled ok
  let started = false;      // a match was started (CS.Game.startDuel)
  let ended = false;        // onMatchEnd fired, the result screen is up
  let rematchMine = false;  // I pressed РЕВАНШ
  let rematchFoe = false;   // the rival pressed it
  let foeGone = false;      // the rival left after the match end
  let myNetId = '';         // my presence key (learned from list[].self)
  let foeName = '';         // the rival's display name (from presence)
  let busy = false;         // an async create/join is in flight
  let flow = 0;             // bump on reset: stale async callbacks die
  let copiedTimer = 0;
  let lastR = 'aborted';    // feature T25: the latest finished match result
  let lastScore = '0:0';    // feature T25: its score, my view («2:1»)

  /* ---------- dom / i18n helpers ---------- */

  function byId(id) {
    return document.getElementById(id);
  }

  function t(key, arg) {
    return CS.I18N && typeof CS.I18N.t === 'function' ? CS.I18N.t(key, arg) : key;
  }

  function setText(id, value) {
    const el = byId(id);
    if (el) el.textContent = String(value);
  }

  function show(id, on) {
    const el = byId(id);
    if (el && el.classList && typeof el.classList.toggle === 'function') {
      el.classList.toggle('hidden', !on);
    }
  }

  function visible(id) {
    const el = byId(id);
    return !!el && !el.classList.contains('hidden');
  }

  /* ---------- net helpers ---------- */

  function netSend(type, data) {
    try {
      return !!(CS.Net && typeof CS.Net.send === 'function' && CS.Net.send(type, data));
    } catch (e) {
      return false;
    }
  }

  /* cb error -> the inline message key (SPEC §22 lobby errors) */
  function mapErr(err) {
    if (err === 'full') return 'duelErrFull';
    if (err === 'timeout') return 'duelErrTimeout';
    if (err === 'none') return 'duelErrNone';
    return 'duelErrNoNet'; // 'no_client' and anything unknown
  }

  /* a match is running right now (between start and its end) */
  function inMatch() {
    return started && !ended;
  }

  /* ---------- feature T25: the local duel history ---------- */

  /* 'cs_duels': [{foe, r: 'win'|'loss'|'draw', sc: '2:1', d: 'DD.MM.YYYY'}]
     newest first, capped at DUELS_MAX; written from any browser (Telegram
     or a desktop one) — the file:// and offline cases included */
  function loadDuels() {
    try {
      const raw = window.localStorage.getItem(DUELS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function saveDuels(arr) {
    try {
      window.localStorage.setItem(DUELS_KEY, JSON.stringify(arr));
    } catch (e) {
      /* storage unavailable: the history lives until the reload */
    }
  }

  /* today as DD.MM.YYYY (local time) */
  function todayStr() {
    const d = new Date();
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
  }

  /* a finished match goes on top; an aborted duel is not a battle */
  function recordDuel(r, score) {
    if (r !== 'win' && r !== 'loss' && r !== 'draw') return;
    const arr = loadDuels();
    arr.unshift({
      foe: String(foeName || 'RIVAL').slice(0, 20),
      r: r,
      sc: String(score),
      d: todayStr()
    });
    saveDuels(arr.slice(0, DUELS_MAX));
  }

  /* {w, l, streak}: streak counts the leading wins (a draw or a loss
     breaks it), w/l are the totals across the whole history */
  function duelStats() {
    const arr = loadDuels();
    let w = 0;
    let l = 0;
    let streak = 0;
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i] && arr[i].r;
      if (r === 'win') w++;
      else if (r === 'loss') l++;
    }
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i] || arr[i].r !== 'win') break;
      streak++;
    }
    return { w: w, l: l, streak: streak };
  }

  /* ---------- lobby ui ---------- */

  function setError(key) {
    const el = byId('duel-error');
    show('duel-error', !!key);
    if (el && key) el.textContent = t(key);
  }

  function setWait(on) {
    show('duel-wait', on);
    if (on) {
      setText('duel-wait-text', t('duelWait'));
      setText('duel-role', mode === 'host' ? t('duelHost') : t('duelGuest'));
      show('duel-role', true);
    }
  }

  /* feature T25: the «🔥 N ПОДРЯД» badge under the role line —
     alive from a 3-win streak, refreshed on every lobby open and
     after every match */
  function renderStreakBadge() {
    const streak = duelStats().streak;
    const on = streak >= STREAK_MIN;
    show('duel-streak', on);
    if (on) setText('duel-streak', t('duelStreakBadge', streak));
  }

  /* the room code as one HUGE letter per plate */
  function renderCode(code) {
    const box = byId('duel-code');
    if (!box) return;
    box.textContent = '';
    for (let i = 0; i < code.length; i++) {
      const s = document.createElement('span');
      s.className = 'duel-char';
      s.textContent = code.charAt(i);
      box.appendChild(s);
    }
  }

  function resetRematchButton() {
    const btn = byId('btn-duel-rematch');
    if (!btn) return;
    btn.classList.remove('dim');
    btn.setAttribute('data-i18n', 'duelRematch');
    btn.textContent = t('duelRematch');
  }

  function waitRematchButton() {
    const btn = byId('btn-duel-rematch');
    if (!btn) return;
    btn.classList.add('dim');
    btn.setAttribute('data-i18n', 'duelWaitRematch'); // a language switch keeps it right
    btn.textContent = t('duelWaitRematch');
  }

  function lockRematchButton() {
    const btn = byId('btn-duel-rematch');
    if (!btn) return;
    btn.classList.add('dim');
    btn.setAttribute('data-i18n', 'duelResultLeft');
    btn.textContent = t('duelResultLeft');
  }

  /* the lobby back to its two fresh blocks (no channel actions) */
  function resetLobby() {
    mode = 'idle';
    roomCode = '';
    connected = false;
    started = false;
    ended = false;
    rematchMine = false;
    rematchFoe = false;
    foeGone = false;
    myNetId = '';
    busy = false;
    if (copiedTimer) {
      window.clearTimeout(copiedTimer);
      copiedTimer = 0;
    }
    setError(null);
    setWait(false);
    show('duel-room', false);
    show('duel-create-block', true);
    show('duel-join-block', true);
    show('duel-link-copy', false);
    show('duel-copied', false);
    show('duel-streak', false); // feature T25: openLobby re-renders it
    show('btn-duel-brag', false); // feature T25: the old result must not leak
    const input = byId('duel-code-input');
    if (input) {
      input.value = '';
      input.readOnly = false;
    }
    const goBtn = byId('btn-duel-go');
    if (goBtn) goBtn.disabled = false;
    resetRematchButton();
  }

  /* full reset: also say bye, drop the channel (repeat joins stay
     supported by net.js) and refresh the rematch button */
  function reset() {
    flow++;
    netSend('bye');
    try {
      if (CS.Net && typeof CS.Net.leave === 'function') CS.Net.leave();
    } catch (e) {
      /* nothing to drop: fine */
    }
    resetLobby();
  }

  function openLobby() {
    reset();
    renderStreakBadge(); // feature T25: the streak badge is a fresh read
    if (CS.UI && typeof CS.UI.show === 'function') CS.UI.show('duel');
  }

  /* feature T25: «МОИ БОИ» — the battles screen over the lobby */
  function openBattles() {
    if (CS.UI && typeof CS.UI.show === 'function') CS.UI.show('battles');
  }

  /* its «НАЗАД»: back into the lobby exactly as it was — no channel
     reset, so a waiting room survives the history peek */
  function backToLobby() {
    if (CS.UI && typeof CS.UI.show === 'function') CS.UI.show('duel');
  }

  /* Esc / «НАЗАД» from the lobby (no match is live there) */
  function toMenu() {
    reset();
    if (CS.UI && typeof CS.UI.show === 'function') CS.UI.show('menu');
  }

  /* «ВЫХТИ» on the result screen: the match is over, CS.Game.endDuel
     stops the frozen duel, restores the solo canvas and shows the menu */
  function exitAfterMatch() {
    reset();
    if (CS.Game && typeof CS.Game.endDuel === 'function') CS.Game.endDuel();
    else if (CS.UI && typeof CS.UI.show === 'function') CS.UI.show('menu');
  }

  /* ---------- create / join flows ---------- */

  /* (a) «СОЗДАТЬ БОЙ»: client -> room code -> join the room channel */
  function onCreate() {
    if (busy || mode !== 'idle') return;
    if (!CS.Net || typeof CS.Net.ensureClient !== 'function' ||
        typeof CS.Net.createRoom !== 'function' || typeof CS.Net.join !== 'function') {
      setError('duelErrNoNet');
      return;
    }
    busy = true;
    const tok = flow;
    CS.Net.ensureClient(function (ok) {
      if (tok !== flow) return; // the user left while loading
      if (!ok) {
        busy = false;
        setError('duelErrNoNet');
        return;
      }
      CS.Net.createRoom(function (res) {
        if (tok !== flow) return;
        busy = false;
        if (!res || !res.ok) {
          setError(mapErr(res && res.error));
          return;
        }
        enterRoom(res.code, 'host');
      });
    });
  }

  /* (b) «ВОЙТИ ПО КОДУ»: 4 chars from the code alphabet */
  function onGo() {
    if (busy || mode !== 'idle') return;
    const input = byId('duel-code-input');
    const code = String(input && input.value || '')
      .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (!CODE_RE.test(code)) {
      setError('duelErrNone');
      return;
    }
    enterRoom(code, 'guest');
  }

  /* the shared room entry: lobby visuals first, then the channel */
  function enterRoom(code, role) {
    mode = role;
    roomCode = code;
    started = false;
    ended = false;
    rematchMine = false;
    rematchFoe = false;
    foeGone = false;
    setError(null);
    if (role === 'host') {
      renderCode(code);
      setText('duel-link', LINK_TEXT + code);
      show('duel-room', true);
      show('duel-create-block', false);
      show('duel-join-block', false);
    } else {
      show('duel-create-block', false);
      const input = byId('duel-code-input');
      if (input) {
        input.value = code;
        input.readOnly = true;
      }
      const goBtn = byId('btn-duel-go');
      if (goBtn) goBtn.disabled = true;
    }
    setWait(true);
    const tok = flow;
    CS.Net.join(code, function (res) {
      if (tok !== flow) return; // the user left while joining
      if (!res || !res.ok) {
        resetLobby(); // net.js already dropped the half-open channel
        setError(mapErr(res && res.error));
        return;
      }
      connected = true;
      if (mode === 'guest') netSend('hello', null); // the name is in presence
    });
  }

  /* ---------- the match ---------- */

  /* host only: a fresh seed per match (SPEC §22 start{seed}) */
  function startMatch() {
    const seed = Math.floor(Math.random() * 0x7fffffff);
    netSend('start', { seed: seed });
    beginMatch();
  }

  function beginMatch() {
    started = true;
    ended = false;
    rematchMine = false;
    rematchFoe = false;
    foeGone = false;
    setError(null);
    setWait(false);
    show('duel-room', false);
    if (CS.UI && typeof CS.UI.show === 'function') CS.UI.show('game');
    const ok = CS.Game && typeof CS.Game.startDuel === 'function'
      ? CS.Game.startDuel({
          host: mode === 'host',
          myIndex: mode === 'host' ? 0 : 1,
          onMatchEnd: onMatchEnd
        })
      : false;
    if (!ok) exitAfterMatch(); // duel.js somehow missing: a safe exit
  }

  /* CS.Duel onMatchEnd: {result: 'win'|'loss'|'draw'|'aborted', score:[a,b]} */
  function onMatchEnd(res) {
    ended = true;
    const r = res && res.result ? String(res.result) : 'aborted';
    const key = r === 'win' ? 'duelResultWin'
      : r === 'loss' ? 'duelResultLoss'
      : r === 'draw' ? 'duelResultDraw'
      : 'duelResultLeft';
    const title = byId('duel-result-title');
    if (title) {
      title.textContent = t(key);
      title.className = 'screen-title duel-res-' +
        (r === 'aborted' ? 'left' : r);
    }
    const sc = res && Array.isArray(res.score) ? res.score : [0, 0];
    const myIdx = mode === 'host' ? 0 : 1;
    const mine = (sc[myIdx] | 0) + ':' + (sc[1 - myIdx] | 0);
    lastR = r;
    lastScore = mine;
    setText('duel-result-score', mine);
    /* feature T25: the brag share needs a won duel and a known rival
       (outside Telegram the .tg-only css keeps the button hidden) */
    show('btn-duel-brag', r === 'win' && !!foeName);
    resetRematchButton();
    if (CS.UI && typeof CS.UI.show === 'function') CS.UI.show('duelresult');
    recordDuel(r, mine); // feature T25: the local history ('aborted' skipped)
    renderStreakBadge(); // the lobby badge is ready for the next visit
    reportDuelResult(r, sc); // SPEC §22: match history in the cloud
  }

  /* fire-and-forget duel_results insert (only real win/loss matches) */
  function reportDuelResult(r, sc) {
    try {
      if (r !== 'win' && r !== 'loss') return;
      const cfg = window.CS && CS.Config;
      if (!cfg || !cfg.supabaseUrl || !cfg.supabaseKey) return;
      const mine = (CS.Net && typeof CS.Net.myName === 'function' ? CS.Net.myName() : '') || 'PLAYER';
      const foe = foeName || 'RIVAL';
      const body = {
        winner: r === 'win' ? mine : foe,
        loser: r === 'win' ? foe : mine,
        rounds: (sc[0] | 0) + ':' + (sc[1] | 0)
      };
      const ctl = new AbortController();
      const kill = setTimeout(function () { ctl.abort(); }, 5000);
      fetch(cfg.supabaseUrl.replace(/\/$/, '') + '/rest/v1/duel_results', {
        method: 'POST',
        headers: {
          'apikey': cfg.supabaseKey,
          'Authorization': 'Bearer ' + cfg.supabaseKey,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(body),
        signal: ctl.signal
      }).catch(function () {}).then(function () { clearTimeout(kill); });
    } catch (e) {
      /* the duel result screen must never depend on the network */
    }
  }

  /* ---------- rematch ---------- */

  function onRematch() {
    if (!ended || rematchMine || foeGone) return;
    rematchMine = true;
    netSend('rematch');
    waitRematchButton(); // «ждём соперника…» right on the pressed button
    if (mode === 'host' && rematchFoe) startMatch();
  }

  /* ---------- presence / messages ---------- */

  function handlePresence(list, diff) {
    if (mode === 'idle') return;
    let others = 0;
    if (Array.isArray(list)) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i] || {};
        if (e.self) myNetId = String(e.id || '');
        else {
          others++;
          const nm = String(e.name || '').trim();
          if (nm) foeName = nm.slice(0, 20);
        }
      }
    }
    const left = diff && Array.isArray(diff.left) ? diff.left : [];
    let foreignLeft = false;
    for (let i = 0; i < left.length; i++) {
      if (String(left[i]) !== myNetId) foreignLeft = true;
    }
    if (foreignLeft) {
      if (inMatch() && CS.Duel && typeof CS.Duel.active === 'function' &&
          CS.Duel.active() && typeof CS.Duel.abort === 'function') {
        CS.Duel.abort(); // -> onMatchEnd({result:'aborted'})
      } else if (ended && !foeGone) {
        foeGone = true;
        lockRematchButton(); // the rival is gone: no rematch can happen
      }
      return;
    }
    /* host: the rival arrived (presence >= 2) -> auto-start */
    if (!inMatch() && !ended && mode === 'host' && connected && others >= 1) {
      startMatch();
    }
  }

  function handleNetMessage(type) {
    if (mode === 'idle') return;
    if (type === 'start') {
      if (mode === 'guest' && connected && !inMatch()) beginMatch();
      return;
    }
    if (type === 'rematch') {
      if (ended && !foeGone) {
        rematchFoe = true;
        if (mode === 'host' && rematchMine) startMatch();
      }
    }
    /* hello / bye / duel-internal types: presence is the source of truth */
  }

  /* ---------- invite / clipboard ---------- */

  function onInvite() {
    if (!roomCode) return;
    try {
      if (CS.TG && typeof CS.TG.shareLink === 'function') {
        CS.TG.shareLink(LINK_URL + roomCode, t('duelInvite'));
      }
    } catch (e) {
      /* sharing is optional: ignore any failure */
    }
  }

  /* feature T25: «ХВАСТАТЬСЯ» on the result screen — share the app
     link with the «Я разбил ИМЯ 2:1!» text; only a real won duel
     against a known rival ever gets here (the button is hidden
     otherwise, and .tg-only hides it outside Telegram) */
  function onBrag() {
    if (lastR !== 'win' || !foeName) return;
    try {
      if (CS.TG && typeof CS.TG.shareLink === 'function') {
        CS.TG.shareLink(BRAG_URL, t('duelBrag', foeName + ' ' + lastScore));
      }
    } catch (e) {
      /* sharing is optional: ignore any failure */
    }
  }

  function flashCopied() {
    show('duel-copied', true);
    if (copiedTimer) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(function () {
      copiedTimer = 0;
      show('duel-copied', false);
    }, COPIED_MS);
  }

  function onCopy() {
    if (!roomCode) return;
    const link = LINK_URL + roomCode;
    const fallbackInput = byId('duel-link-copy');
    const revealFallback = function () {
      if (!fallbackInput) return;
      fallbackInput.value = link;
      show('duel-link-copy', true);
      try {
        fallbackInput.focus();
        fallbackInput.select();
        if (document.execCommand) document.execCommand('copy');
      } catch (e) {
        /* the text stays selected for a manual copy */
      }
    };
    try {
      const nav = window.navigator || {};
      if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        nav.clipboard.writeText(link).then(flashCopied, revealFallback);
        return;
      }
    } catch (e) {
      /* no clipboard api: fall through to the manual fallback */
    }
    revealFallback();
  }

  /* ---------- deep link (room-XXXX) ---------- */

  /* WebApp.initParam.startapp first, initDataUnsafe.start_param as the
     belt; anything but room-<4 valid chars> is not a duel link */
  function deepLinkCode() {
    let raw = '';
    try {
      const wa = window.Telegram && window.Telegram.WebApp;
      if (wa) {
        const a = wa.initParam && wa.initParam.startapp;
        const b = wa.initDataUnsafe && wa.initDataUnsafe.start_param;
        raw = String(a || b || '');
      }
    } catch (e) {
      raw = '';
    }
    const m = DEEP_RE.exec(raw.trim());
    return m ? m[1].toUpperCase() : '';
  }

  /* game.js boot calls this after the language screen: the invited
     guest lands straight in the lobby with the code pre-joined */
  function bootDeepLink() {
    const code = deepLinkCode();
    if (!code) return false;
    openLobby();
    enterRoom(code, 'guest');
    return true;
  }

  /* ---------- input ---------- */

  function onCodeInput() {
    const input = byId('duel-code-input');
    if (!input || input.readOnly) return;
    const norm = String(input.value || '')
      .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (norm !== input.value) input.value = norm;
  }

  function onCodeKey(e) {
    if (!e || (e.key || '') !== 'Enter') return;
    if (e.preventDefault) e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    onGo();
  }

  /* Esc leaves the lobby (and the result screen) — a duel itself can
     never be paused (SPEC §22), and game.js ignores Esc in 'menu' */
  function onKeyDown(e) {
    const code = (e && (e.code || e.key)) || '';
    if (code !== 'Escape') return;
    if (visible('screen-battles')) {
      backToLobby(); // feature T25: back into the duel context
      return;
    }
    if (visible('screen-duel')) {
      toMenu();
      return;
    }
    if (visible('screen-duelresult')) exitAfterMatch();
  }

  /* ---------- wiring ---------- */

  function wire() {
    if (wired) return;
    wired = true;
    const bind = function (id, handler) {
      const el = byId(id);
      if (el && typeof el.addEventListener === 'function') {
        el.addEventListener('click', handler);
      }
    };
    bind('btn-duel', openLobby);
    bind('btn-duel-create', onCreate);
    bind('btn-duel-invite', onInvite);
    bind('btn-duel-copy', onCopy);
    bind('btn-duel-go', onGo);
    bind('btn-duel-back', toMenu);
    bind('btn-duel-rematch', onRematch);
    bind('btn-duel-exit', exitAfterMatch);
    bind('btn-duel-brag', onBrag); // feature T25
    bind('btn-battles', openBattles); // feature T25
    bind('btn-battles-back', backToLobby); // feature T25
    const input = byId('duel-code-input');
    if (input && typeof input.addEventListener === 'function') {
      input.addEventListener('input', onCodeInput);
      input.addEventListener('keydown', onCodeKey);
    }
    document.addEventListener('keydown', onKeyDown);
    try {
      if (CS.Net && typeof CS.Net.onMessage === 'function') {
        CS.Net.onMessage(handleNetMessage);
      }
      if (CS.Net && typeof CS.Net.onPresence === 'function') {
        CS.Net.onPresence(handlePresence);
      }
    } catch (e) {
      /* no transport: the lobby simply never connects */
    }
  }

  function init() {
    wire();
  }

  /* ---------- public api ---------- */

  CS.DuelUI = {
    init: init,
    /* show a fresh lobby (the menu «ОНЛАЙН-БОЙ» button) */
    open: openLobby,
    /* game.js boot hook: the room-XXXX Telegram deep link */
    bootDeepLink: bootDeepLink,
    /* game.js goMenu hook: drop the channel + reset the lobby */
    reset: reset,
    /* feature T25: the local history — {w, l, streak} and the raw
       rows for ui.js renderBattles (test.html + headless tests too) */
    stats: duelStats,
    history: loadDuels,
    /* live debug/QA view (test.html + headless tests) */
    state: function () {
      return {
        mode: mode,
        code: roomCode,
        connected: connected,
        started: started,
        ended: ended,
        rematchMine: rematchMine,
        rematchFoe: rematchFoe,
        foeGone: foeGone
      };
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
