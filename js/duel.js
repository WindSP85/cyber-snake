/* ============================================================
   NEON://SNAKE — online duel core (feature T23, SPEC §22)
   CS.Duel is the full duel simulation living inside game.js as
   the 'duel' state: the main rAF loop keeps running, but its
   update/render branch into this module while a match is live.
   The solo game states are never touched by duel code.

   Host authority (SPEC §22): the host simulates BOTH snakes and
   broadcasts state snapshots every 100 ms; the guest renders the
   snapshots and only sends its turns. Transport: CS.Net.send /
   CS.Net.onMessage (js/net.js, T22) — without a room every send
   degrades silently, so the module never breaks offline/file://.

   Round rules (SPEC §22, sacred):
   - wall / own body              -> round to the rival
   - head into the rival's body   -> BITE: the rival is cut at the
     bite point, the dropped segments become food (2 cells per 3
     segments, rounded up, max 12), the biter rides through the
     body for 0.4 s; fewer than 3 segments left -> DEVOURED
   - head-on (same cell / swap)   -> the longer snake wins,
     equal lengths -> round draw
   - TRAPPED: flood fill from the head over free cells (food is
     passable) < length + 5  -> round to the encircler with a
     1 s slow-mo, flash and banner
   Match: best of 3 rounds, first to 2 wins.

   Public surface (game.js + the T24 ui):
     CS.Duel.init({cell, grid, hooks})        — game.js injection
     CS.Duel.begin({host, myIndex, onMatchEnd}) — start a match
     CS.Duel.stop()                           — teardown anytime
     CS.Duel.active()                         — is a match live
     CS.Duel.update(dt) / draw(g)             — 'duel' branches
     CS.Duel.input(dir)                       — steer MY snake
     CS.Duel.state()                          — live debug view
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  /* ---------- tuning (SPEC §22) ---------- */

  const TICK_RATE = 9.5;          // shared ticks per second (x1.15 fix)
  const START_LEN = 5;            // snake length at a round start
  const START_X0 = 0.15;          // opposite thirds of the arena
  const START_X1 = 0.85;
  const TURN_BUFFER = 1;          // one buffered turn per snake
  const COUNTDOWN_TIME = 3;       // 3-2-1 phase, s
  const ROUNDEND_TIME = 2.5;      // round result banner, s
  const MATCH_WINS = 2;           // first to 2 wins
  const MATCH_ROUNDS = 3;         // ...of at most 3 rounds
  const FOOD_STANDING = 2;        // packets on the field, always
  const FOOD_GROW = 2;            // segments gained per packet
  const FOOD_TOTAL_MAX = 16;      // hard cap incl. bite leftovers
  const FOOD_PER_CUT = 3;         // 2 food cells per 3 cut segs
  const FOOD_CUT_MAX = 12;        // max food cells per bite
  const BITE_PASS_TIME = 0.4;     // ride-through window, s
  const BITE_MIN_KEEP = 3;        // fewer left -> devoured
  const TRAP_MARGIN = 5;          // reachable < len + 5 -> trapped
  const TRAP_SLOWMO = 1;          // slow-mo length, s
  const TRAP_SLOW_FACTOR = 0.2;   // simulation speed while trapped
  const STATE_INTERVAL = 0.1;     // host snapshot broadcast, s
  const STATE_TIMEOUT = 3;        // guest rival-drop threshold, s
  const SNAP_LERP = 0.12;         // guest head lerp window, s
  const TICK_GUARD = 6;           // max ticks per update frame

  const DIR = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };
  const DIR_NAMES = ['up', 'down', 'left', 'right'];
  const DIR_LIST = [DIR.up, DIR.down, DIR.left, DIR.right];

  const BG = '#04050c';
  const GRID_LINE = 'rgba(0,240,255,.07)';
  const RIVAL_HEAD = [255, 122, 0];   // #ff7a00
  const RIVAL_TAIL = [255, 45, 85];   // #ff2d55
  const RIVAL_GLOW = '#ff7a00';
  const MY_GLOW = '#00f0ff';

  /* ---------- injected config (game.js) ---------- */

  let cfg = null;        // {cell, grid(), hooks{resize}} — see init()
  let CELL = 30;

  /* ---------- state ---------- */

  let GW = 42;                 // arena, cells (×2 solo area)
  let GH = 28;
  let live = false;            // a match is running
  let host = true;             // host authority flag
  let myIndex = 0;             // my snake (host default 0)
  let foeIndex = 1;
  let onMatchEndCb = null;

  let phase = 'idle';          // countdown|fight|roundEnd|matchEnd
  let phaseTimer = 0;
  let round = 1;
  let score = [0, 0];
  let roundWinner = null;      // 0|1|-1 once a round resolved
  let matchEnded = false;
  let snakes = [];             // [{segs,dir,queue,growth,pass}] x 2
  let food = [];               // [{x,y}]
  let tickTimer = 0;
  let animTime = 0;
  let slowmo = 0;              // TRAP_SLOWMO seconds remaining
  let banner = null;           // {key,t,total,color}
  let lastCount = -1;          // countdown beep tracker

  let stateTimer = 0;          // host: broadcast throttle
  let netStateAge = 0;         // guest: seconds since last state
  let snapAge = 0;             // guest: seconds since snapshot
  let guestLastCount = -1;     // guest countdown beeps
  let events = { bite: 0, trap: 0, eat: 0, round: 0 }; // host counters
  let guestEvents = { bite: 0, trap: 0, eat: 0, round: 0 };
  let netBound = false;

  /* flood fill scratch (typed arrays, one allocation per match) */
  let blocked = null;          // Uint8Array: both bodies
  let seen = null;             // Int32Array: generation stamps
  let queueBuf = null;         // Int32Array: BFS queue
  let stamp = 0;

  /* ---------- helpers ---------- */

  function idx(x, y) { return y * GW + x; }

  function tr(key, a, b) {
    let s = key;
    try {
      if (CS.I18N && typeof CS.I18N.t === 'function') s = CS.I18N.t(key, a);
    } catch (e) {
      s = key;
    }
    if (b !== undefined) s = String(s).replace('{2}', String(b));
    return s;
  }

  function sfx(name) {
    try {
      if (CS.Audio && typeof CS.Audio.sfx === 'function') CS.Audio.sfx(name);
    } catch (e) { /* headless: silence */ }
  }

  function fx(name, a, b, c, d) {
    try {
      const f = CS.FX && CS.FX[name];
      if (typeof f === 'function') f.call(CS.FX, a, b, c, d);
    } catch (e) { /* headless: silence */ }
  }

  function haptic(kind) {
    try {
      if (CS.TG && typeof CS.TG.haptic === 'function') CS.TG.haptic(kind);
    } catch (e) { /* outside Telegram: silence */ }
  }

  function netSend(type, data) {
    try {
      return !!(CS.Net && typeof CS.Net.send === 'function' && CS.Net.send(type, data));
    } catch (e) {
      return false;
    }
  }

  function colorStr(rgb) {
    return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
  }

  /* the rival's fixed orange->red body blend */
  function rivalColor(i, n) {
    const k = n <= 1 ? 0 : i / (n - 1);
    return colorStr([
      Math.round(RIVAL_HEAD[0] + (RIVAL_TAIL[0] - RIVAL_HEAD[0]) * k),
      Math.round(RIVAL_HEAD[1] + (RIVAL_TAIL[1] - RIVAL_HEAD[1]) * k),
      Math.round(RIVAL_HEAD[2] + (RIVAL_TAIL[2] - RIVAL_HEAD[2]) * k)
    ]);
  }

  /* my snake always wears the active skin (feature T17) */
  function myColor(i, n) {
    try {
      if (CS.Skins && typeof CS.Skins.colors === 'function') {
        return CS.Skins.colors(i, n, animTime);
      }
    } catch (e) { /* fall through to the neon default */ }
    return i === 0 ? '#00f0ff' : '#ff2bd6';
  }

  function sideColor(side, i, n) {
    return side === myIndex ? myColor(i, n) : rivalColor(i, n);
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* accepts a vector {x,y}, a name 'up'... or 0..3 */
  function normDir(d) {
    if (typeof d === 'string' && DIR[d]) return DIR[d];
    if (typeof d === 'number' && DIR_LIST[d]) return DIR_LIST[d];
    if (d && typeof d === 'object' && Number.isFinite(d.x) && Number.isFinite(d.y)) {
      for (let k = 0; k < 4; k++) {
        if (DIR_LIST[k].x === d.x && DIR_LIST[k].y === d.y) return DIR_LIST[k];
      }
    }
    return null;
  }

  function dirName(d) {
    for (let k = 0; k < 4; k++) {
      if (DIR_LIST[k].x === d.x && DIR_LIST[k].y === d.y) return DIR_NAMES[k];
    }
    return 'up';
  }

  function dirIndex(d) {
    for (let k = 0; k < 4; k++) {
      if (DIR_LIST[k].x === d.x && DIR_LIST[k].y === d.y) return k;
    }
    return 0;
  }

  /* ---------- snakes ---------- */

  function makeSnake(headX, headY, dir, len) {
    const segs = [];
    for (let i = 0; i < len; i++) {
      const x = headX - dir.x * i;
      const y = headY - dir.y * i;
      segs.push({ prev: { x: x, y: y }, curr: { x: x, y: y } });
    }
    return { segs: segs, dir: dir, queue: [], growth: 0, pass: 0 };
  }

  /* buffer of 1, latest valid turn wins; no repeats, no 180s */
  function queueTurn(s, d) {
    const last = s.queue.length ? s.queue[s.queue.length - 1] : s.dir;
    if (d.x === last.x && d.y === last.y) return;
    if (d.x === -last.x && d.y === -last.y) return;
    if (s.queue.length >= TURN_BUFFER) s.queue[s.queue.length - 1] = d;
    else s.queue.push(d);
  }

  function takeTurn(s) {
    while (s.queue.length) {
      const d = s.queue.shift();
      if (d.x === -s.dir.x && d.y === -s.dir.y) continue;
      if (d.x === s.dir.x && d.y === s.dir.y) continue;
      s.dir = d;
      break;
    }
  }

  function moveSnake(s, c) {
    const last = s.segs.length - 1;
    const oldTailX = s.segs[last].curr.x;
    const oldTailY = s.segs[last].curr.y;
    for (let i = last; i > 0; i--) {
      const sg = s.segs[i];
      const ahead = s.segs[i - 1].curr;
      sg.prev.x = sg.curr.x;
      sg.prev.y = sg.curr.y;
      sg.curr.x = ahead.x;
      sg.curr.y = ahead.y;
    }
    const h = s.segs[0];
    h.prev.x = h.curr.x;
    h.prev.y = h.curr.y;
    h.curr.x = c.x;
    h.curr.y = c.y;
    if (s.growth > 0) {
      s.growth--;
      s.segs.push({
        prev: { x: oldTailX, y: oldTailY },
        curr: { x: oldTailX, y: oldTailY }
      });
    }
  }

  /* own body collision AFTER the move: the freeing tail cell is
     already vacated, so any coincidence here is a real crash */
  function selfCrash(s) {
    const head = s.segs[0].curr;
    for (let i = 1; i < s.segs.length; i++) {
      if (s.segs[i].curr.x === head.x && s.segs[i].curr.y === head.y) return true;
    }
    return false;
  }

  /* ---------- food ---------- */

  function occupiedSet() {
    const occ = {};
    for (let i = 0; i < 2; i++) {
      const segs = snakes[i].segs;
      for (let k = 0; k < segs.length; k++) occ[idx(segs[k].curr.x, segs[k].curr.y)] = 1;
    }
    for (let i = 0; i < food.length; i++) occ[idx(food[i].x, food[i].y)] = 1;
    return occ;
  }

  function spawnFood() {
    const occ = occupiedSet();
    const free = [];
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        if (!occ[idx(x, y)]) free.push(idx(x, y));
      }
    }
    if (!free.length) return;
    const c = free[Math.floor(Math.random() * free.length)];
    food.push({ x: c % GW, y: Math.floor(c / GW) });
  }

  function maintainFood() {
    while (food.length < FOOD_STANDING) {
      const before = food.length;
      spawnFood();
      if (food.length === before) break; // no room at all
    }
  }

  function eatFood(s) {
    const head = s.segs[0].curr;
    for (let i = food.length - 1; i >= 0; i--) {
      if (food[i].x === head.x && food[i].y === head.y) {
        food.splice(i, 1);
        s.growth += FOOD_GROW;
        fx('burst', head.x * CELL + CELL / 2, head.y * CELL + CELL / 2, '#ff2bd6', 7);
        sfx('eat');
        haptic('click');
      }
    }
  }

  /* the bite leftovers: ceil(2*dropped/3) cells, max 12, spread
     over the dropped cells; the field cap trims the oldest */
  function dropFood(cells) {
    if (!cells.length) return;
    const n = Math.min(FOOD_CUT_MAX, Math.ceil(cells.length * 2 / FOOD_PER_CUT));
    for (let i = 0; i < n; i++) {
      const c = cells[Math.floor(i * cells.length / n)];
      let dup = false;
      for (let k = 0; k < food.length; k++) {
        if (food[k].x === c.x && food[k].y === c.y) { dup = true; break; }
      }
      if (!dup) food.push({ x: c.x, y: c.y });
    }
    while (food.length > FOOD_TOTAL_MAX) food.shift();
  }

  /* ---------- trap detection (flood fill, typed arrays) ---------- */

  function allocFlood() {
    const n = GW * GH;
    blocked = new Uint8Array(n);
    seen = new Int32Array(n);
    queueBuf = new Int32Array(n);
    stamp = 0;
  }

  function markBlocked() {
    blocked.fill(0);
    for (let i = 0; i < 2; i++) {
      const segs = snakes[i].segs;
      for (let k = 0; k < segs.length; k++) {
        blocked[idx(segs[k].curr.x, segs[k].curr.y)] = 1;
      }
    }
  }

  /* reachable free cells (food counts as passable) from a head */
  function reachCount(s) {
    const head = s.segs[0].curr;
    const start = idx(head.x, head.y);
    stamp++;
    let qh = 0;
    let qt = 0;
    seen[start] = stamp;
    queueBuf[qt++] = start;
    let count = 0;
    while (qh < qt) {
      const c = queueBuf[qh++];
      count++;
      const cx = c % GW;
      const cy = (c - cx) / GW;
      if (cx > 0) { const n = c - 1; if (!blocked[n] && seen[n] !== stamp) { seen[n] = stamp; queueBuf[qt++] = n; } }
      if (cx < GW - 1) { const n = c + 1; if (!blocked[n] && seen[n] !== stamp) { seen[n] = stamp; queueBuf[qt++] = n; } }
      if (cy > 0) { const n = c - GW; if (!blocked[n] && seen[n] !== stamp) { seen[n] = stamp; queueBuf[qt++] = n; } }
      if (cy < GH - 1) { const n = c + GW; if (!blocked[n] && seen[n] !== stamp) { seen[n] = stamp; queueBuf[qt++] = n; } }
    }
    return count;
  }

  function trapCheck() {
    markBlocked();
    const r0 = reachCount(snakes[0]);
    const r1 = reachCount(snakes[1]);
    const t0 = r0 < snakes[0].segs.length + snakes[0].growth + TRAP_MARGIN;
    const t1 = r1 < snakes[1].segs.length + snakes[1].growth + TRAP_MARGIN;
    if (t0 && t1) return r0 === r1 ? -1 : (r0 < r1 ? 1 : 0);
    if (t0) return 1;
    if (t1) return 0;
    return null;
  }

  /* ---------- the tick (host authority, both snakes) ---------- */

  function targetOf(s) {
    const h = s.segs[0].curr;
    return { x: h.x + s.dir.x, y: h.y + s.dir.y };
  }

  /* returns 'devoured' | 'bite' | null; cuts the rival on contact */
  function biteCheck(me, foe) {
    if (me.pass > 0) return null; // riding through the body
    const head = me.segs[0].curr;
    for (let k = 1; k < foe.segs.length; k++) {
      const c = foe.segs[k].curr;
      if (c.x !== head.x || c.y !== head.y) continue;
      const dropped = [];
      const foeSide = sideOf(foe);
      for (let s = k; s < foe.segs.length; s++) {
        dropped.push({ x: foe.segs[s].curr.x, y: foe.segs[s].curr.y });
        fx('burst', foe.segs[s].curr.x * CELL + CELL / 2, foe.segs[s].curr.y * CELL + CELL / 2,
          sideColor(foeSide, s, foe.segs.length), 6);
      }
      foe.segs.length = k;   // everything from the bite point falls off
      foe.growth = 0;
      dropFood(dropped);
      me.pass = BITE_PASS_TIME;
      events.bite++;
      fx('glitch', 0.2);
      fx('shake', 5);
      sfx('duelBite');
      haptic('heavy');
      return foe.segs.length < BITE_MIN_KEEP ? 'devoured' : 'bite';
    }
    return null;
  }

  /* which arena side (0|1) a snake object belongs to */
  function sideOf(s) {
    return snakes[0] === s ? 0 : 1;
  }

  function endRound(winner, key) {
    if (winner === 0 || winner === 1) score[winner]++;
    roundWinner = winner;
    phase = 'roundEnd';
    phaseTimer = ROUNDEND_TIME;
    events.round++;
    setBanner(key, ROUNDEND_TIME + 0.6,
      winner === -1 ? '#ffe600' : sideColor(winner, 0, 1));
    const loser = winner === -1 ? null : 1 - winner;
    for (let i = 0; i < 2; i++) {
      const h = snakes[i].segs[0].curr;
      if (i === winner) fx('burst', h.x * CELL + CELL / 2, h.y * CELL + CELL / 2, '#00ff9d', 18);
      else if (i === loser) fx('burst', h.x * CELL + CELL / 2, h.y * CELL + CELL / 2, '#ff2d55', 16);
    }
    netSend('round', { w: winner, r: round, s: [score[0], score[1]], k: key });
  }

  function trapWin(winner) {
    slowmo = TRAP_SLOWMO;
    events.trap++;
    fx('flash', '#ff2d55', 0.18);
    sfx('duelTrap');
    endRound(winner, 'dTrapped');
  }

  function tick() {
    const s0 = snakes[0];
    const s1 = snakes[1];
    takeTurn(s0);
    takeTurn(s1);

    const t0 = targetOf(s0);
    const t1 = targetOf(s1);
    const wall = [false, false];
    if (t0.x < 0 || t0.x >= GW || t0.y < 0 || t0.y >= GH) wall[0] = true;
    if (t1.x < 0 || t1.x >= GW || t1.y < 0 || t1.y >= GH) wall[1] = true;
    if (wall[0] || wall[1]) {
      endRound(wall[0] && wall[1] ? -1 : (wall[0] ? 1 : 0), 'dCrash');
      return;
    }

    /* head-on: same target cell, or a cell swap in one tick */
    const h0 = s0.segs[0].curr;
    const h1 = s1.segs[0].curr;
    const sameCell = t0.x === t1.x && t0.y === t1.y;
    const swap = t0.x === h1.x && t0.y === h1.y && t1.x === h0.x && t1.y === h0.y;
    if (sameCell || swap) {
      const l0 = s0.segs.length + s0.growth;
      const l1 = s1.segs.length + s1.growth;
      fx('glitch', 0.25);
      fx('shake', 8);
      endRound(l0 === l1 ? -1 : (l0 > l1 ? 0 : 1), 'dHead');
      return;
    }

    /* both move simultaneously, then the bodies resolve */
    moveSnake(s0, t0);
    moveSnake(s1, t1);

    const dead = [selfCrash(s0), selfCrash(s1)];
    let devoured = false;
    for (let i = 0; i < 2; i++) {
      if (dead[0] || dead[1]) break; // a crash already decided it
      const me = snakes[i];
      const foe = snakes[1 - i];
      const r = biteCheck(me, foe);
      if (r === 'devoured') {
        dead[1 - i] = true;
        devoured = true;
      }
    }
    if (!dead[0] && !dead[1]) {
      eatFood(s0);
      eatFood(s1);
      maintainFood();
    }
    if (dead[0] || dead[1]) {
      if (dead[0] && dead[1]) endRound(-1, 'dDraw');
      else {
        const winner = dead[0] ? 1 : 0;
        if (devoured) {
          events.eat++;
          sfx('duelWin'); // a round eaten is a small fanfare
        } else {
          fx('shake', 7);
        }
        endRound(winner, devoured ? 'dEat' : 'dCrash');
      }
      return;
    }

    const trap = trapCheck();
    if (trap !== null) trapWin(trap);
  }

  /* ---------- match flow ---------- */

  function startRound() {
    const y = Math.floor(GH / 2);
    const x0 = Math.max(START_LEN, Math.min(GW - START_LEN - 1, Math.round(GW * START_X0)));
    const x1 = Math.max(START_LEN, Math.min(GW - START_LEN - 1, Math.round(GW * START_X1)));
    snakes = [
      makeSnake(x0, y, DIR.right, START_LEN),
      makeSnake(x1, y, DIR.left, START_LEN)
    ];
    food = [];
    maintainFood();
    tickTimer = 0;
    slowmo = 0;
    roundWinner = null;
    phase = 'countdown';
    phaseTimer = COUNTDOWN_TIME;
    lastCount = -1;
  }

  function nextAfterRoundEnd() {
    if (score[0] >= MATCH_WINS || score[1] >= MATCH_WINS || round >= MATCH_ROUNDS) {
      matchEnd(score[0] === score[1] ? -1 : (score[0] > score[1] ? 0 : 1));
      return;
    }
    round++;
    startRound();
  }

  function matchEnd(winner) {
    phase = 'matchEnd';
    const result = winner === -1 ? 'draw' : (winner === myIndex ? 'win' : 'loss');
    setBanner(result === 'win' ? 'dWin' : (result === 'loss' ? 'dLose' : 'dDraw'), 999,
      result === 'win' ? '#00ff9d' : (result === 'loss' ? '#ff2d55' : '#ffe600'));
    sfx(result === 'win' ? 'duelWin' : 'duelLose');
    haptic(result === 'win' ? 'success' : 'error');
    if (result === 'win') fx('flash', '#00ff9d', 0.25);
    netSend('win', { side: winner, s: [score[0], score[1]] });
    finishMatch(result);
  }

  function finishMatch(result) {
    if (matchEnded) return;
    matchEnded = true;
    if (typeof onMatchEndCb === 'function') {
      try {
        onMatchEndCb({ result: result, score: [score[0], score[1]] });
      } catch (e) {
        /* the caller's callback is the caller's problem */
      }
    }
  }

  /* guest: no state snapshots for STATE_TIMEOUT seconds */
  function rivalLeft() {
    if (phase === 'matchEnd') return;
    phase = 'matchEnd';
    setBanner('dLeft', 999, '#ff2d55');
    sfx('duelLose');
    fx('glitch', 0.4);
    finishMatch('aborted');
  }

  function setBanner(key, t, color) {
    banner = { key: key, t: t, total: t, color: color || '#00f0ff' };
  }

  /* ---------- networking ---------- */

  function ensureNet() {
    if (netBound) return;
    netBound = true;
    try {
      if (CS.Net && typeof CS.Net.onMessage === 'function') {
        CS.Net.onMessage(onNetMsg);
      }
    } catch (e) {
      /* no transport: an offline host simulates alone */
    }
  }

  function onNetMsg(type, data) {
    if (!live) return;
    if (host) {
      if (type === 'turn') applyFoeTurn(data);
      return;
    }
    if (type === 'state') applySnapshot(data);
    else if (type === 'round') applyRoundMsg(data);
    else if (type === 'win') applyWinMsg(data);
  }

  function applyFoeTurn(data) {
    if (!data || typeof data !== 'object') return;
    const d = normDir(data.dir);
    if (d && snakes[foeIndex]) queueTurn(snakes[foeIndex], d);
  }

  function packSnake(s) {
    const out = [];
    for (let i = 0; i < s.segs.length; i++) {
      out.push(s.segs[i].curr.x, s.segs[i].curr.y);
    }
    return out;
  }

  function sendState() {
    if (!host) return;
    netSend('state', {
      ph: phase,
      r: round,
      s: [score[0], score[1]],
      pt: Math.max(0, phaseTimer),
      sn: [packSnake(snakes[0]), packSnake(snakes[1])],
      d: [dirIndex(snakes[0].dir), dirIndex(snakes[1].dir)],
      f: food.map(function (c) { return [c.x, c.y]; }),
      w: roundWinner,
      k: banner ? banner.key : null,
      kt: banner ? Math.max(0, banner.t) : 0,
      kc: banner ? banner.color : null,
      ev: [events.bite, events.trap, events.eat, events.round]
    });
  }

  function unpackSnake(flat, prevHead) {
    const segs = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const x = flat[i];
      const y = flat[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      segs.push({
        prev: { x: x, y: y },
        curr: { x: x, y: y }
      });
    }
    if (!segs.length) return null;
    if (prevHead) {
      segs[0].prev.x = prevHead.x; // head lerp anchor
      segs[0].prev.y = prevHead.y;
    }
    return { segs: segs, dir: DIR.right, queue: [], growth: 0, pass: 0 };
  }

  function applySnapshot(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.sn)) return;
    netStateAge = 0;
    snapAge = 0;
    const prevPhase = phase;
    for (let i = 0; i < 2; i++) {
      const prevHead = snakes[i] && snakes[i].segs.length
        ? { x: snakes[i].segs[0].curr.x, y: snakes[i].segs[0].curr.y }
        : null;
      const s = unpackSnake(d.sn[i], prevHead);
      if (s) {
        s.dir = DIR_LIST[(d.d && Number.isFinite(d.d[i])) ? Math.max(0, Math.min(3, d.d[i])) : 0];
        s.pass = snakes[i] ? snakes[i].pass : 0;
        snakes[i] = s;
      }
    }
    food = [];
    if (Array.isArray(d.f)) {
      for (let i = 0; i < d.f.length; i++) {
        const c = d.f[i];
        if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
          food.push({ x: c[0], y: c[1] });
        }
      }
    }
    if (Array.isArray(d.s) && Number.isFinite(d.s[0]) && Number.isFinite(d.s[1])) {
      score = [d.s[0], d.s[1]];
    }
    if (Number.isFinite(d.r)) round = d.r;
    roundWinner = Number.isFinite(d.w) ? d.w : null;
    phase = typeof d.ph === 'string' ? d.ph : phase;
    if (Number.isFinite(d.pt)) phaseTimer = d.pt;

    /* local countdown beeps + the fight tone */
    if (phase === 'countdown') {
      const n = Math.max(0, Math.ceil(phaseTimer));
      if (n !== guestLastCount) {
        guestLastCount = n;
        if (n > 0) sfx('duelCount');
      }
    } else {
      guestLastCount = -1;
    }
    if (phase === 'fight' && prevPhase !== 'fight') {
      setBanner('dReady', 0.8, '#00ff9d');
      sfx('duelGo');
    }

    /* banner mirror */
    if (typeof d.k === 'string' && d.k) {
      const t = Number.isFinite(d.kt) ? d.kt : 1;
      if (!banner || banner.key !== d.k || banner.t < t) {
        setBanner(d.k, Math.max(t, 0.3), typeof d.kc === 'string' ? d.kc : '#00f0ff');
      }
    }

    /* event mirrors: fire local fx/sfx once per counter bump */
    if (Array.isArray(d.ev)) {
      const ev = {
        bite: d.ev[0] | 0,
        trap: d.ev[1] | 0,
        eat: d.ev[2] | 0,
        round: d.ev[3] | 0
      };
      if (ev.bite > guestEvents.bite) {
        guestEvents.bite = ev.bite;
        fx('glitch', 0.2);
        fx('shake', 5);
        sfx('duelBite');
      }
      if (ev.trap > guestEvents.trap) {
        guestEvents.trap = ev.trap;
        slowmo = TRAP_SLOWMO;
        fx('flash', '#ff2d55', 0.18);
        sfx('duelTrap');
      }
      if (ev.round > guestEvents.round) guestEvents.round = ev.round;
      if (ev.eat > guestEvents.eat) guestEvents.eat = ev.eat;
    }
  }

  function applyRoundMsg(d) {
    if (!d || typeof d !== 'object') return;
    if (Array.isArray(d.s) && Number.isFinite(d.s[0]) && Number.isFinite(d.s[1])) {
      score = [d.s[0], d.s[1]];
    }
    roundWinner = Number.isFinite(d.w) ? d.w : null;
    phase = 'roundEnd';
    if (typeof d.k === 'string' && d.k) {
      setBanner(d.k, ROUNDEND_TIME + 0.6,
        d.w === -1 || d.w === null || d.w === undefined ? '#ffe600' : sideColor(d.w, 0, 1));
    }
  }

  function applyWinMsg(d) {
    if (!d || typeof d !== 'object' || matchEnded) return;
    if (Array.isArray(d.s) && Number.isFinite(d.s[0]) && Number.isFinite(d.s[1])) {
      score = [d.s[0], d.s[1]];
    }
    const winner = Number.isFinite(d.side) ? d.side : -1;
    phase = 'matchEnd';
    const result = winner === -1 ? 'draw' : (winner === myIndex ? 'win' : 'loss');
    setBanner(result === 'win' ? 'dWin' : (result === 'loss' ? 'dLose' : 'dDraw'), 999,
      result === 'win' ? '#00ff9d' : (result === 'loss' ? '#ff2d55' : '#ffe600'));
    sfx(result === 'win' ? 'duelWin' : 'duelLose');
    finishMatch(result);
  }

  /* ---------- update ---------- */

  function update(dt) {
    animTime += dt;
    if (banner) {
      banner.t -= dt;
      if (banner.t <= 0) banner = null;
    }
    for (let i = 0; i < 2; i++) {
      if (snakes[i] && snakes[i].pass > 0) {
        snakes[i].pass = Math.max(0, snakes[i].pass - dt);
      }
    }
    const slow = slowmo > 0 ? TRAP_SLOW_FACTOR : 1;
    if (slowmo > 0) slowmo = Math.max(0, slowmo - dt);
    snapAge += dt;

    /* guest: a silent transport for STATE_TIMEOUT seconds = the
       rival is gone (presence itself is the T24 ui's job) */
    if (!host && phase !== 'matchEnd') {
      netStateAge += dt;
      if (netStateAge > STATE_TIMEOUT) rivalLeft();
    }

    if (phase === 'countdown') {
      phaseTimer -= dt;
      const n = Math.ceil(phaseTimer);
      if (n !== lastCount) {
        lastCount = n;
        if (n > 0) sfx('duelCount');
      }
      if (phaseTimer <= 0) {
        phase = 'fight';
        phaseTimer = 0;
        tickTimer = 0;
        setBanner('dReady', 0.8, '#00ff9d');
        sfx('duelGo');
      }
    } else if (phase === 'fight') {
      if (host) {
        tickTimer += dt * slow;
        const step = 1 / TICK_RATE;
        let guard = TICK_GUARD;
        while (tickTimer >= step && guard-- > 0 && phase === 'fight') {
          tickTimer -= step;
          tick();
        }
      }
    } else if (phase === 'roundEnd') {
      phaseTimer -= dt * slow;
      if (host && phaseTimer <= 0) nextAfterRoundEnd();
    }

    if (host && live) {
      stateTimer += dt;
      if (stateTimer >= STATE_INTERVAL) {
        stateTimer = 0;
        sendState();
      }
    }
  }

  /* ---------- drawing ---------- */

  function drawArena(g) {
    const W = GW * CELL;
    const H = GH * CELL;
    g.strokeStyle = GRID_LINE;
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 1; x < GW; x++) {
      g.moveTo(x * CELL + 0.5, 0);
      g.lineTo(x * CELL + 0.5, H);
    }
    for (let y = 1; y < GH; y++) {
      g.moveTo(0, y * CELL + 0.5);
      g.lineTo(W, y * CELL + 0.5);
    }
    g.stroke();
    /* the arena frame: my color vs the rival's orange */
    g.save();
    g.lineWidth = 2;
    g.shadowBlur = 14;
    g.strokeStyle = MY_GLOW;
    g.shadowColor = MY_GLOW;
    g.beginPath();
    g.moveTo(1, 1);
    g.lineTo(W - 1, 1);
    g.stroke();
    g.strokeStyle = RIVAL_GLOW;
    g.shadowColor = RIVAL_GLOW;
    g.beginPath();
    g.moveTo(W - 1, 1);
    g.lineTo(W - 1, H - 1);
    g.lineTo(1, H - 1);
    g.stroke();
    g.restore();
  }

  function drawFoodCells(g) {
    for (let i = 0; i < food.length; i++) {
      const pulse = 0.5 + 0.5 * Math.sin(animTime * 6 + i * 1.9);
      const cx = food[i].x * CELL + CELL / 2;
      const cy = food[i].y * CELL + CELL / 2;
      const s = CELL * (0.5 + 0.1 * pulse);
      g.save();
      g.translate(cx, cy);
      g.rotate(Math.PI / 4);
      g.shadowColor = '#ff2bd6';
      g.shadowBlur = 8 + 10 * pulse;
      g.fillStyle = '#ff2bd6';
      roundRect(g, -s / 2, -s / 2, s, s, 3);
      g.fill();
      g.shadowBlur = 0;
      g.fillStyle = '#ffffff';
      g.fillRect(-s * 0.12, -s * 0.12, s * 0.24, s * 0.24);
      g.restore();
    }
  }

  function drawSnake(g, side) {
    const s = snakes[side];
    if (!s || !s.segs.length) return;
    const n = s.segs.length;
    const mine = side === myIndex;
    let t;
    if (host) {
      t = Math.min(1, tickTimer * TICK_RATE);
    } else if (phase === 'fight') {
      t = Math.min(1, snapAge / SNAP_LERP); // guest: head lerp only
    } else {
      t = 1;
    }
    let skinAlpha = 1;
    if (mine) {
      try {
        if (CS.Skins && typeof CS.Skins.alpha === 'function') skinAlpha = CS.Skins.alpha();
      } catch (e) { skinAlpha = 1; }
    }
    for (let i = n - 1; i >= 0; i--) {
      const sg = s.segs[i];
      const x = (sg.prev.x + (sg.curr.x - sg.prev.x) * t) * CELL;
      const y = (sg.prev.y + (sg.curr.y - sg.prev.y) * t) * CELL;
      const isHead = i === 0;
      const pad = isHead ? CELL * 0.06 : CELL * 0.07;
      g.save();
      g.fillStyle = sideColor(side, i, n);
      if (s.pass > 0 && isHead) {
        /* riding through the rival's body: blink like a shield */
        g.globalAlpha = Math.max(0.15, 0.45 + 0.55 * Math.sin(animTime * 14));
      } else if (skinAlpha < 1 && mine) {
        g.globalAlpha = skinAlpha;
      }
      if (isHead) {
        g.shadowColor = mine ? (CS.Skins && typeof CS.Skins.headGlow === 'function'
          ? CS.Skins.headGlow(animTime) : MY_GLOW) : RIVAL_GLOW;
        g.shadowBlur = 16;
      }
      roundRect(g, x + pad, y + pad, CELL - pad * 2, CELL - pad * 2, isHead ? 8 : 6);
      g.fill();
      if (isHead) {
        g.shadowBlur = 0;
        g.fillStyle = BG;
        const fxp = x + CELL / 2 + s.dir.x * CELL * 0.16;
        const fyp = y + CELL / 2 + s.dir.y * CELL * 0.16;
        const px = -s.dir.y;
        const py = s.dir.x;
        const off = CELL * 0.15;
        const r = Math.max(2, CELL * 0.08);
        g.beginPath();
        g.arc(fxp + px * off, fyp + py * off, r, 0, Math.PI * 2);
        g.arc(fxp - px * off, fyp - py * off, r, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }
  }

  function bigFont(g, px) {
    g.font = 'bold ' + px + 'px "Cascadia Mono", Consolas, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
  }

  function drawHud(g) {
    const W = GW * CELL;
    g.save();
    bigFont(g, Math.max(18, Math.round(CELL * 0.85)));
    g.shadowColor = '#00f0ff';
    g.shadowBlur = 12;
    g.fillStyle = '#eafcff';
    g.fillText(tr('dRoundScore', score[myIndex], score[foeIndex]), W / 2, CELL * 0.9);
    g.restore();
  }

  function drawBanner(g) {
    const W = GW * CELL;
    const H = GH * CELL;
    if (phase === 'countdown') {
      const n = Math.max(1, Math.ceil(phaseTimer));
      const frac = Math.max(0, Math.min(1, phaseTimer - Math.floor(phaseTimer)));
      g.save();
      bigFont(g, Math.round(CELL * 3));
      g.globalAlpha = 0.35 + 0.65 * frac;
      g.shadowColor = '#00f0ff';
      g.shadowBlur = 24;
      g.fillStyle = '#eafcff';
      g.fillText(String(n), W / 2, H / 2);
      g.restore();
      return;
    }
    if (!banner) return;
    g.save();
    const k = Math.min(1, banner.t / 0.4);   // fade only at the very end
    const pop = banner.total > 10 ? 1 : Math.min(1, (banner.total - banner.t) / 0.12 + 0.4);
    g.globalAlpha = k;
    bigFont(g, Math.round(CELL * 1.4 * pop));
    g.shadowColor = banner.color;
    g.shadowBlur = 18;
    g.fillStyle = banner.color;
    g.fillText(tr(banner.key), W / 2, H / 2);
    g.restore();
  }

  function draw(g) {
    if (!g || !live) return;
    const W = GW * CELL;
    const H = GH * CELL;
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    drawArena(g);
    drawFoodCells(g);
    drawSnake(g, 0);
    drawSnake(g, 1);
    drawHud(g);
    drawBanner(g);
  }

  /* ---------- public API ---------- */

  CS.Duel = {
    /* game.js injection: {cell, grid() -> {w,h}, hooks{resize(w,h)}} */
    init: function (options) {
      cfg = options && typeof options === 'object' ? options : null;
      if (cfg && Number.isFinite(cfg.cell) && cfg.cell > 0) CELL = cfg.cell;
    },

    /* {host:bool, myIndex:0|1, onMatchEnd(result,score)} */
    begin: function (opts) {
      const o = opts || {};
      host = o.host !== false;
      myIndex = (o.myIndex === 0 || o.myIndex === 1) ? o.myIndex : (host ? 0 : 1);
      foeIndex = 1 - myIndex;
      onMatchEndCb = typeof o.onMatchEnd === 'function' ? o.onMatchEnd : null;

      const grid = (cfg && typeof cfg.grid === 'function') ? cfg.grid() : null;
      if (grid && Number.isFinite(grid.w) && Number.isFinite(grid.h)) {
        GW = Math.max(10, Math.min(60, Math.round(grid.w)));
        GH = Math.max(10, Math.min(60, Math.round(grid.h)));
      }
      if (cfg && cfg.hooks && typeof cfg.hooks.resize === 'function') {
        try { cfg.hooks.resize(GW * CELL, GH * CELL); } catch (e) { /* canvasless */ }
      }
      allocFlood();

      score = [0, 0];
      round = 1;
      matchEnded = false;
      banner = null;
      slowmo = 0;
      stateTimer = 0;
      netStateAge = 0;
      snapAge = 0;
      guestLastCount = -1;
      events = { bite: 0, trap: 0, eat: 0, round: 0 };
      guestEvents = { bite: 0, trap: 0, eat: 0, round: 0 };
      snakes = [makeSnake(3, 3, DIR.right, 1), makeSnake(6, 3, DIR.left, 1)];
      live = true;
      ensureNet();
      startRound();
    },

    stop: function () {
      live = false;
      phase = 'idle';
      phaseTimer = 0;
      snakes = [];
      food = [];
      banner = null;
      slowmo = 0;
      onMatchEndCb = null;
    },

    active: function () {
      return live;
    },

    /* feature T24 (SPEC §22): the lobby ui saw the rival's presence
       drop — end the live match as 'aborted' right now (the same
       path as the guest's transport-silence timeout); after a match
       end this is a safe no-op */
    abort: function () {
      if (live) rivalLeft();
    },

    /* steer MY snake: host queues directly, guest broadcasts */
    input: function (d) {
      if (!live) return;
      const v = normDir(d);
      if (!v) return;
      if (host) {
        if (snakes[myIndex]) queueTurn(snakes[myIndex], v);
      } else {
        netSend('turn', { dir: dirName(v) });
      }
    },

    update: update,

    draw: draw,

    /* live debug/QA view (test.html + headless tests) */
    state: function () {
      return {
        live: live,
        host: host,
        myIndex: myIndex,
        phase: phase,
        phaseTimer: phaseTimer,
        round: round,
        score: score,
        roundWinner: roundWinner,
        snakes: snakes,
        food: food,
        banner: banner,
        slowmo: slowmo,
        tickTimer: tickTimer,
        events: events,
        grid: { w: GW, h: GH, cell: CELL }
      };
    }
  };
})();
