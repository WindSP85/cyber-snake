/* ============================================================
   NEON://SNAKE — game orchestrator (SPEC §2, §3, §4, §7)
   CS.Game owns the state machine, the snake core, food/bonus,
   levels & speed, boss integration, the death sequence, input
   (keyboard + touch), the main rAF loop and the best score.

   States: 'menu' | 'playing' | 'boss' | 'paused' | 'gameover'
   plus the internal 'dying' (1 s freeze before the game over).
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  /* ---------- tuning constants ---------- */

  const GRID_W = 30;
  const GRID_H = 20;
  const CELL = 30;                  // canvas: GRID_W*CELL x GRID_H*CELL
  const MAX_DT = 0.05;              // main loop dt clamp, seconds

  const BASE_TPS = 7.5;             // snake ticks per second at level 1
  const TPS_STEP = 0.5;             // added per level
  const MAX_TPS = 14;

  const START_LEN = 4;
  const FOOD_PER_LEVEL = 5;         // normal food per level-up
  const FOOD_SCORE = 10;            // x level
  const BONUS_EVERY = 5;            // normal food between bonus spawns
  const BONUS_TIME = 7;             // bonus lifetime, seconds
  const BONUS_BLINK = 2;            // blink during the last seconds
  const BONUS_SCORE = 250;
  const BONUS_GROW = 2;
  const CHARGE_SCORE = 25;
  const BOSS_EVERY = 3;             // every 3rd level
  const BOSS_SCORE = 250;           // x bossIndex
  const INPUT_BUFFER = 3;
  const DIE_TIME = 1;               // death sequence length
  const BANNER_TIME = 2;            // boss warning banner on screen
  const SWIPE_MIN = 24;             // touch swipe threshold, px

  const PALETTE = ['#00f0ff', '#ff2bd6', '#ffe600', '#00ff9d', '#ff7a00'];
  const BG = '#04050c';
  const GRID_LINE = 'rgba(0,240,255,.07)';
  const HEAD_HSL = [186, 50];       // hue / lightness of #00f0ff
  const TAIL_HSL = [311, 58];       // hue / lightness of #ff2bd6

  const DIR = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };

  /* ---------- state ---------- */

  let canvas = null;
  let g = null;

  let state = 'menu';               // 'menu'|'playing'|'boss'|'paused'|'gameover'|'dying'
  let resumeState = 'playing';      // where a pause returns to
  let snake = [];                   // [{prev:{x,y}, curr:{x,y}}], head first
  let dir = DIR.right;
  let dirQueue = [];                // input buffer, max INPUT_BUFFER
  let growth = 0;                   // segments still to append
  let food = null;                  // {x,y}
  let bonus = null;                 // {x,y,timer}
  let score = 0;
  let best = loadBest();
  let level = 1;
  let eaten = 0;                    // normal food eaten in total
  let stepInterval = 1 / BASE_TPS;
  let stepTimer = 0;                // time accumulated since the last tick
  let animTime = 0;                 // clock for pulses and blinking
  let dieTimer = 0;
  let bannerTimer = 0;
  let fight = null;                 // live CS.BossFight instance
  let pendingBoss = 0;              // boss index waiting for the current fight
  let lastBossHp = -1;

  let running = false;
  let lastTs = 0;
  let touchStart = null;
  let gestured = false;

  /* ---------- helpers ---------- */

  function key(x, y) { return x + ',' + y; }

  /* i18n translate (i18n.js always loads before this file) */
  function tr(key, arg) {
    return CS.I18N && CS.I18N.t ? CS.I18N.t(key, arg) : key;
  }

  function loadBest() {
    try {
      const v = parseInt(window.localStorage.getItem('cs_best'), 10);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (e) {
      return 0;
    }
  }

  function saveBest() {
    try {
      window.localStorage.setItem('cs_best', String(best));
    } catch (e) {
      /* storage unavailable: keep going without persistence */
    }
  }

  function segColor(i, n) {
    const t = n <= 1 ? 0 : i / (n - 1);
    const h = HEAD_HSL[0] + (TAIL_HSL[0] - HEAD_HSL[0]) * t;
    const l = HEAD_HSL[1] + (TAIL_HSL[1] - HEAD_HSL[1]) * t;
    return 'hsl(' + Math.round(h) + ',100%,' + Math.round(l) + '%)';
  }

  function roundRect(g2, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g2.beginPath();
    g2.moveTo(x + r, y);
    g2.arcTo(x + w, y, x + w, y + h, r);
    g2.arcTo(x + w, y + h, x, y + h, r);
    g2.arcTo(x, y + h, x, y, r);
    g2.arcTo(x, y, x + w, y, r);
    g2.closePath();
  }

  function snakeCells() {
    const cells = [];
    for (let i = 0; i < snake.length; i++) {
      cells.push({ x: snake[i].curr.x, y: snake[i].curr.y });
    }
    return cells;
  }

  /* ---------- score ---------- */

  function addScore(n) {
    score += n;
    if (score > best) {
      best = score;
      saveBest();
      CS.UI.hud({ best: best });
    }
    CS.UI.hud({ score: score });
  }

  /* ---------- food / bonus ---------- */

  function occupiedKeys() {
    const occ = new Set();
    for (let i = 0; i < snake.length; i++) {
      occ.add(key(snake[i].curr.x, snake[i].curr.y));
    }
    if (food) occ.add(key(food.x, food.y));
    if (bonus) occ.add(key(bonus.x, bonus.y));
    if (fight && fight.active) {
      const haz = fight.hazardCells();
      if (haz && haz.forEach) haz.forEach(function (k) { occ.add(k); });
      const charges = fight.chargeCells();
      if (charges) {
        for (let i = 0; i < charges.length; i++) {
          occ.add(key(charges[i].x, charges[i].y));
        }
      }
      if (Array.isArray(fight.firewalls)) {
        for (let i = 0; i < fight.firewalls.length; i++) {
          occ.add(key(fight.firewalls[i].x, fight.firewalls[i].y));
        }
      }
    }
    return occ;
  }

  function randomFreeCell(occ) {
    const free = [];
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        if (!occ.has(key(x, y))) free.push({ x: x, y: y });
      }
    }
    if (!free.length) return null;
    return free[Math.floor(Math.random() * free.length)];
  }

  function spawnFood() {
    food = randomFreeCell(occupiedKeys());
  }

  function spawnBonus() {
    const c = randomFreeCell(occupiedKeys());
    if (c) bonus = { x: c.x, y: c.y, timer: BONUS_TIME };
  }

  /* ---------- levels / speed ---------- */

  function applySpeed() {
    const tps = Math.min(MAX_TPS, BASE_TPS + TPS_STEP * (level - 1));
    stepInterval = 1 / tps;
  }

  function levelUp() {
    level++;
    CS.UI.hud({ level: level });
    CS.UI.toast(tr('toastLevel', level));
    CS.Audio.sfx('levelup');
    if (state !== 'boss') applySpeed(); // tick speed is frozen during a fight
    if (level % BOSS_EVERY === 0) {
      const idx = level / BOSS_EVERY;
      if (fight && fight.active) pendingBoss = idx; // queue behind the live one
      else startBoss(idx);
    }
  }

  /* ---------- boss integration (SPEC §4, §7) ---------- */

  function bossEvents() {
    return {
      onDefeated: onBossDefeated,
      onWarn: function (text) {
        CS.UI.banner(text, true);
        bannerTimer = BANNER_TIME;
        CS.FX.glitch(0.25);
      },
      onSfx: function (name) {
        CS.Audio.sfx(name);
      }
    };
  }

  function startBoss(idx) {
    fight = new CS.BossFight(idx, GRID_W, GRID_H, bossEvents());
    state = 'boss';
    CS.Audio.music('boss');
    CS.UI.bossBar(fight.hp, fight.maxHp, true, fight.name);
    lastBossHp = fight.hp;
  }

  function onBossDefeated() {
    const idx = fight ? fight.bossIndex : 1;
    addScore(BOSS_SCORE * idx);
    if (fight) {
      // farewell burst at the boss core (2x2 block center)
      CS.FX.burst((fight.x + 1) * CELL, (fight.y + 1) * CELL, '#ff2d55', 40);
    }
    CS.FX.shake(8);
    CS.UI.toast(tr('toastBossDown'));
    CS.UI.bossBar(0, 0, false);
    CS.UI.banner(null, false);
    bannerTimer = 0;
    fight = null;
    state = 'playing';
    applySpeed(); // the speed was frozen for the whole fight, catch up now
    CS.Audio.music('game');
    if (pendingBoss) {
      const next = pendingBoss;
      pendingBoss = 0;
      startBoss(next);
    }
  }

  /* ---------- death sequence ---------- */

  function die() {
    if (state === 'dying' || state === 'gameover') return;
    state = 'dying';
    dieTimer = DIE_TIME;
    stepTimer = 0;
    CS.Audio.sfx('die');
    CS.Audio.music(null);
    CS.UI.banner(null, false);
    bannerTimer = 0;
    const n = snake.length;
    for (let i = 0; i < n; i++) {
      CS.FX.burst(
        snake[i].curr.x * CELL + CELL / 2,
        snake[i].curr.y * CELL + CELL / 2,
        segColor(i, n),
        12
      );
    }
    CS.FX.shake(12);
    CS.FX.glitch(0.6);
    CS.FX.flash('#ff2d55', 0.25);
  }

  function finishGameOver() {
    state = 'gameover';
    fight = null;
    pendingBoss = 0;
    if (score > best) {
      best = score;
      saveBest();
    }
    CS.UI.hud({ score: score, best: best });
    CS.UI.bossBar(0, 0, false);
    CS.UI.banner(null, false);
    CS.UI.show('gameover');
  }

  /* ---------- the snake tick ---------- */

  function step() {
    if (dirQueue.length) dir = dirQueue.shift();

    const head = snake[0];
    const nx = head.curr.x + dir.x;
    const ny = head.curr.y + dir.y;

    // walls
    if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) {
      die();
      return;
    }

    // self: the tail cell frees this tick unless the snake is growing
    const growing = growth > 0;
    const last = snake.length - 1;
    for (let i = 0; i < snake.length; i++) {
      if (!growing && i === last) continue;
      const c = snake[i].curr;
      if (c.x === nx && c.y === ny) {
        die();
        return;
      }
    }

    // boss data charge at the target cell
    if (fight && fight.active && fight.collectCharge(nx, ny)) {
      CS.FX.burst(nx * CELL + CELL / 2, ny * CELL + CELL / 2, '#00ff9d', 10);
      CS.FX.shake(4);
      addScore(CHARGE_SCORE); // the fight may be over now (onDefeated ran)
    }

    // every segment follows the one ahead of it
    const oldTailX = snake[last].curr.x;
    const oldTailY = snake[last].curr.y;
    for (let i = snake.length - 1; i > 0; i--) {
      const s = snake[i];
      const ahead = snake[i - 1].curr;
      s.prev.x = s.curr.x;
      s.prev.y = s.curr.y;
      s.curr.x = ahead.x;
      s.curr.y = ahead.y;
    }
    head.prev.x = head.curr.x;
    head.prev.y = head.curr.y;
    head.curr.x = nx;
    head.curr.y = ny;

    if (growing) {
      growth--;
      // the new tail segment holds the old tail cell: prev = curr
      snake.push({
        prev: { x: oldTailX, y: oldTailY },
        curr: { x: oldTailX, y: oldTailY }
      });
    }

    // normal food
    if (food && food.x === nx && food.y === ny) {
      addScore(FOOD_SCORE * level);
      eaten++;
      growth += 1;
      CS.Audio.sfx('eat');
      CS.FX.burst(nx * CELL + CELL / 2, ny * CELL + CELL / 2, '#ff2bd6', 7);
      food = null;
      spawnFood();
      if (eaten % FOOD_PER_LEVEL === 0) levelUp();
      if (eaten % BONUS_EVERY === 0 && !bonus) spawnBonus();
    }

    // bonus fragment
    if (bonus && bonus.x === nx && bonus.y === ny) {
      addScore(BONUS_SCORE);
      growth += BONUS_GROW;
      CS.FX.burst(nx * CELL + CELL / 2, ny * CELL + CELL / 2, '#ffe600', 14);
      bonus = null;
      CS.Audio.sfx('bonus');
    }

    // the field was too crowded for a spawn earlier: retry
    if (!food) spawnFood();
  }

  /* ---------- state transitions ---------- */

  function startGame() {
    snake = [];
    const cx = Math.floor(GRID_W / 2);
    const cy = Math.floor(GRID_H / 2);
    for (let i = 0; i < START_LEN; i++) {
      const x = cx - i;
      snake.push({ prev: { x: x, y: cy }, curr: { x: x, y: cy } });
    }
    dir = DIR.right;
    dirQueue = [];
    growth = 0;
    food = null;
    bonus = null;
    score = 0;
    level = 1;
    eaten = 0;
    fight = null;
    pendingBoss = 0;
    bannerTimer = 0;
    stepTimer = 0;
    applySpeed();
    state = 'playing';
    CS.UI.hud({ score: 0, best: best, level: 1 });
    CS.UI.bossBar(0, 0, false);
    CS.UI.banner(null, false);
    CS.UI.show('game');
    CS.UI.toast(tr('toastConnect'));
    spawnFood();
    CS.Audio.ensure();
    CS.Audio.sfx('start');
    CS.Audio.music('game');
  }

  function pauseGame() {
    if (state !== 'playing' && state !== 'boss') return;
    resumeState = state;
    state = 'paused';
    CS.Audio.sfx('pause');
    CS.Audio.music(null);
    CS.UI.show('pause');
  }

  function resumeGame() {
    if (state !== 'paused') return;
    state = resumeState;
    CS.Audio.music(resumeState === 'boss' ? 'boss' : 'game');
    CS.UI.show('game');
  }

  function goMenu() {
    state = 'menu';
    fight = null;
    pendingBoss = 0;
    bonus = null;
    CS.UI.bossBar(0, 0, false);
    CS.UI.banner(null, false);
    CS.UI.hud({ best: best });
    CS.UI.show('menu');
    CS.Audio.music('menu');
  }

  function toggleMute() {
    const muted = !CS.Audio.getMuted();
    CS.Audio.setMuted(muted);
    updateMuteButton(muted);
  }

  function updateMuteButton(muted) {
    const btn = document.getElementById('mute-btn');
    if (!btn) return;
    btn.textContent = muted ? tr('soundOff') : tr('soundOn');
    if (btn.classList && typeof btn.classList.toggle === 'function') {
      btn.classList.toggle('muted', muted);
    }
  }

  /* feature T7: reopen the language screen from the menu (🌐 button) */
  function showLangScreen() {
    CS.UI.show('lang');
  }

  /* the language choice must be made before Enter can start a game */
  function langScreenShown() {
    const el = document.getElementById('screen-lang');
    return !!el && !el.classList.contains('hidden');
  }

  /* ---------- input ---------- */

  function firstGesture() {
    if (gestured) return;
    gestured = true;
    CS.Audio.ensure();
    if (state === 'menu') CS.Audio.music('menu');
  }

  function queueDir(d) {
    if (state !== 'playing' && state !== 'boss') return;
    const last = dirQueue.length ? dirQueue[dirQueue.length - 1] : dir;
    if (d.x === last.x && d.y === last.y) return;      // repeat
    if (d.x === -last.x && d.y === -last.y) return;    // 180-degree reversal
    if (dirQueue.length >= INPUT_BUFFER) return;
    dirQueue.push(d);
  }

  function onKeyDown(e) {
    firstGesture();
    const code = e.code || '';
    if (code.indexOf('Arrow') === 0 || code === 'Space') {
      if (e.preventDefault) e.preventDefault();
    }
    let d = null;
    if (code === 'ArrowUp' || code === 'KeyW') d = DIR.up;
    else if (code === 'ArrowDown' || code === 'KeyS') d = DIR.down;
    else if (code === 'ArrowLeft' || code === 'KeyA') d = DIR.left;
    else if (code === 'ArrowRight' || code === 'KeyD') d = DIR.right;
    if (d) {
      queueDir(d);
      return;
    }
    if (code === 'Space' || code === 'Escape') {
      if (state === 'paused') resumeGame();
      else pauseGame();
      return;
    }
    if (code === 'Enter') {
      if (langScreenShown()) return; // language first, game later
      if (state === 'menu' || state === 'gameover') startGame();
      return;
    }
    if (code === 'KeyM') toggleMute();
  }

  function onTouchStart(e) {
    firstGesture();
    if (e.touches && e.touches.length) {
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY };
    }
    if (e.preventDefault) e.preventDefault();
  }

  function onTouchEnd(e) {
    if (e.preventDefault) e.preventDefault();
    if (!touchStart) return;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) {
      touchStart = null;
      return;
    }
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    touchStart = null;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (Math.max(adx, ady) < SWIPE_MIN) {
      // a tap on the canvas starts / restarts on the end screens
      if (state === 'menu' || state === 'gameover') startGame();
      return;
    }
    if (adx > ady) queueDir(dx > 0 ? DIR.right : DIR.left);
    else queueDir(dy > 0 ? DIR.down : DIR.up);
  }

  function onCanvasClick() {
    if (state === 'menu' || state === 'gameover') startGame();
  }

  function togglePauseButton() {
    if (state === 'paused') resumeGame();
    else pauseGame();
  }

  /* ---------- main loop ---------- */

  function frame(ts) {
    requestAnimationFrame(frame);
    const now = ts / 1000;
    let dt = 0;
    if (lastTs) dt = now - lastTs;
    lastTs = now;
    if (dt > MAX_DT) dt = MAX_DT;
    if (dt < 0) dt = 0;
    update(dt);
    render();
  }

  function update(dt) {
    animTime += dt;
    CS.FX.update(dt);

    if (bannerTimer > 0) {
      bannerTimer -= dt;
      if (bannerTimer <= 0) {
        bannerTimer = 0;
        CS.UI.banner(null, false);
      }
    }

    if (state === 'playing' || state === 'boss') {
      if (bonus) {
        bonus.timer -= dt;
        if (bonus.timer <= 0) bonus = null;
      }

      if (state === 'boss' && fight && fight.active) {
        fight.update(dt, snakeCells());
        if (fight && fight.hp !== lastBossHp) {
          lastBossHp = fight.hp;
          CS.UI.bossBar(fight.hp, fight.maxHp, true, fight.name);
        }
        if (fight && fight.active && checkHazards()) return;
      }

      stepTimer += dt;
      let guard = 8; // hard cap per frame
      while ((state === 'playing' || state === 'boss') && stepTimer >= stepInterval && guard-- > 0) {
        stepTimer -= stepInterval;
        step();
        if (state === 'dying') {
          stepTimer = 0;
          break;
        }
      }

      // the head may have stepped into a hazard cell this very tick
      if (state === 'boss' && fight && fight.active) checkHazards();
    } else if (state === 'dying') {
      dieTimer -= dt;
      if (dieTimer <= 0) finishGameOver();
    }
  }

  function checkHazards() {
    const haz = fight.hazardCells();
    if (!haz || !haz.size) return false;
    const head = snake[0].curr;
    if (haz.has(key(head.x, head.y))) {
      die();
      return true;
    }
    return false;
  }

  /* ---------- rendering ---------- */

  function render() {
    if (!g) return;
    const W = GRID_W * CELL;
    const H = GRID_H * CELL;

    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    drawGrid();

    if (state !== 'menu') {
      drawFood();
      drawBonus();
      if (fight && fight.active) fight.draw(g, CELL); // draws its charges itself
      drawSnake();
    }
    CS.FX.draw(g);
  }

  function drawGrid() {
    const W = GRID_W * CELL;
    const H = GRID_H * CELL;

    g.strokeStyle = GRID_LINE;
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 1; x < GRID_W; x++) {
      g.moveTo(x * CELL + 0.5, 0);
      g.lineTo(x * CELL + 0.5, H);
    }
    for (let y = 1; y < GRID_H; y++) {
      g.moveTo(0, y * CELL + 0.5);
      g.lineTo(W, y * CELL + 0.5);
    }
    g.stroke();

    // neon arena frame in the level accent color (palette cycle)
    const accent = PALETTE[(level - 1) % PALETTE.length];
    g.save();
    g.strokeStyle = accent;
    g.lineWidth = 2;
    g.shadowColor = accent;
    g.shadowBlur = 14;
    g.strokeRect(1, 1, W - 2, H - 2);
    g.restore();
  }

  function drawFood() {
    if (!food) return;
    const pulse = 0.5 + 0.5 * Math.sin(animTime * 6);
    const cx = food.x * CELL + CELL / 2;
    const cy = food.y * CELL + CELL / 2;
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

  function drawBonus() {
    if (!bonus) return;
    if (bonus.timer <= BONUS_BLINK && Math.floor(animTime * 8) % 2 === 0) return;
    const cx = bonus.x * CELL + CELL / 2;
    const cy = bonus.y * CELL + CELL / 2;
    const bob = Math.sin(animTime * 3) * 2;
    g.save();
    g.translate(cx + bob, cy);
    g.strokeStyle = '#ffe600';
    g.shadowColor = '#ffe600';
    g.shadowBlur = 10;
    g.lineWidth = 3;
    g.lineCap = 'round';
    g.beginPath();
    // '< >' — a code fragment
    g.moveTo(-3, -7);
    g.lineTo(-10, 0);
    g.lineTo(-3, 7);
    g.moveTo(3, -7);
    g.lineTo(10, 0);
    g.lineTo(3, 7);
    g.stroke();
    g.restore();
  }

  function drawSnake() {
    const n = snake.length;
    const t = (state === 'playing' || state === 'boss' || state === 'paused')
      ? Math.min(1, stepTimer / stepInterval)
      : 1; // dying / gameover: freeze at the current cells
    // tail first, head last: the head renders on top
    for (let i = n - 1; i >= 1; i--) drawSegment(i, n, t, false);
    drawSegment(0, n, t, true);
  }

  function drawSegment(i, n, t, isHead) {
    const s = snake[i];
    const x = (s.prev.x + (s.curr.x - s.prev.x) * t) * CELL;
    const y = (s.prev.y + (s.curr.y - s.prev.y) * t) * CELL;
    const color = segColor(i, n);
    const pad = isHead ? CELL * 0.06 : CELL * 0.07; // ~0.86..0.88 of a cell
    g.save();
    g.fillStyle = color;
    if (isHead) {
      g.shadowColor = color;
      g.shadowBlur = 16;
    }
    roundRect(g, x + pad, y + pad, CELL - pad * 2, CELL - pad * 2, isHead ? 8 : 6);
    g.fill();
    if (isHead) {
      // eyes look along the movement direction
      g.shadowBlur = 0;
      g.fillStyle = BG;
      const fx = x + CELL / 2 + dir.x * CELL * 0.16;
      const fy = y + CELL / 2 + dir.y * CELL * 0.16;
      const px = -dir.y;
      const py = dir.x;
      const off = CELL * 0.15;
      const r = Math.max(2, CELL * 0.08);
      g.beginPath();
      g.arc(fx + px * off, fy + py * off, r, 0, Math.PI * 2);
      g.arc(fx - px * off, fy - py * off, r, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  /* ---------- boot ---------- */

  function boot() {
    if (running) return;
    running = true;

    canvas = document.getElementById('game-canvas');
    if (canvas) {
      g = canvas.getContext('2d');
      // HiDPI: the backstore is scaled by devicePixelRatio, all modules
      // keep drawing in logical 900x600 coordinates via setTransform
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      canvas.width = Math.round(GRID_W * CELL * dpr);
      canvas.height = Math.round(GRID_H * CELL * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvas.addEventListener('touchstart', onTouchStart, { passive: false });
      canvas.addEventListener('touchend', onTouchEnd, { passive: false });
      canvas.addEventListener('click', onCanvasClick);
    }

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', function () { firstGesture(); });

    // every button click gives a UI tick sound
    document.addEventListener('click', function (e) {
      const t = e.target;
      if (t && t.closest && t.closest('button')) CS.Audio.sfx('click');
    });

    // screen buttons (start / resume / restart / menu / mute / lang)
    CS.UI.on({
      start: startGame,
      restart: startGame,
      resume: resumeGame,
      menu: goMenu,
      mute: toggleMute,
      lang: showLangScreen
    });

    // #btn-pause is not part of the CS.UI.on contract — wire it directly
    const pauseBtn = document.getElementById('btn-pause');
    if (pauseBtn) pauseBtn.addEventListener('click', togglePauseButton);

    // a language switch re-renders the sound button caption
    if (CS.I18N && typeof CS.I18N.onChange === 'function') {
      CS.I18N.onChange(function () {
        updateMuteButton(CS.Audio.getMuted());
      });
    }

    updateMuteButton(CS.Audio.getMuted());
    CS.UI.hud({ score: 0, best: best, level: 1 });
    CS.UI.show('lang'); // language selection on every entry (feature T7)
    state = 'menu';
    CS.Audio.music('menu'); // silently ignored until the first gesture

    lastTs = 0;
    requestAnimationFrame(frame);
  }

  CS.Game = { boot: boot };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
