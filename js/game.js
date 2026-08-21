/* ============================================================
   NEON://SNAKE — game orchestrator (SPEC §2, §3, §4, §7)
   CS.Game owns the state machine, the snake core, food/bonus,
   levels & speed, boss integration, the death sequence, input
   (keyboard + touch), the main rAF loop and the best score.

   States: 'menu' | 'playing' | 'boss' | 'paused' | 'gameover'
   plus the internal 'dying' (1 s freeze before the game over) and
   'respawning' (feature T8: a spent life reboots the snake).
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
  const DMG_POP_TIME = 0.9;         // "-1" hit marker over the boss, seconds
  const SWIPE_MIN = 24;             // touch swipe threshold, px

  /* feature T8: pickups (SPEC §11) */
  const PICKUP_MIN = 8;             // spawn interval range, seconds
  const PICKUP_MAX = 14;
  const PICKUP_MAX_FIELD = 2;       // pickups on the field at once
  const PICKUP_LIFE = 9;            // pickup lifetime, seconds
  const PICKUP_BLINK = 2;           // blink during the last seconds
  const VIRUS_PENALTY = 50;         // score, floor 0
  const GOLDEN_SCORE = 150;
  const SURGE_TIME = 5;             // speed x1.6, score x2
  const SURGE_SPEED = 1.6;
  const SURGE_SCORE = 2;
  const SLOW_TIME = 5;              // tick x0.7
  const SLOW_FACTOR = 0.7;
  const MAGNET_TIME = 6;            // auto-collect radius 3
  const MAGNET_RADIUS = 3;          // manhattan cells from the head
  const MAX_LIVES = 3;
  const RESPAWN_TIME = 1.2;         // 'respawning' state length, seconds
  const RESPAWN_LEN = 3;            // snake length after a respawn
  const RESPAWN_INVULN = 2;         // invulnerability after a respawn
  const FX_HUD_INTERVAL = 0.2;      // effects DOM refresh, seconds

  /* feature T9: new boss events (SPEC §12) */
  const DEBRIS_LIFE = 5;            // cut segments stay on the field, seconds
  const DEBRIS_SCORE = 50;          // per segment reabsorbed by the head
  const DEBRIS_PENALTY = 25;        // per segment lost when debris expires
  const BITE_MAX = 3;               // tail segments lost per devourer bite
  const BITE_PENALTY = 25;          // score per bitten segment
  const FREEZE_FACTOR = 0.45;       // tick speed multiplier while frozen

  /* weighted pickup types; 'life' is excluded while lives are full */
  const PICKUP_TYPES = [
    { type: 'virus', weight: 30 },
    { type: 'golden', weight: 20 },
    { type: 'surge', weight: 15 },
    { type: 'slow', weight: 15 },
    { type: 'magnet', weight: 10 },
    { type: 'life', weight: 10 }
  ];

  const EFFECT_DUR = { surge: SURGE_TIME, slow: SLOW_TIME, magnet: MAGNET_TIME, freeze: 3 };
  const EFFECT_ICON = { surge: '⚡', slow: '❄', magnet: '🧲', freeze: '🧊' };
  const EFFECT_LABEL = { surge: 'pSurge', slow: 'pSlow', magnet: 'pMagnet', freeze: 'pFreeze' };

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

  let state = 'menu';               // 'menu'|'playing'|'boss'|'paused'|'gameover'|'dying'|'respawning'
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
  let dmgPops = [];                 // floating "-1" hit markers over the boss core

  /* feature T8: pickups, timed effects, lives, respawn */
  let pickups = [];                 // [{x,y,type,timer}]
  let pickupTimer = 0;              // countdown to the next spawn
  let effects = [];                 // [{type,timer,total}]
  let lives = 0;
  let respawnTimer = 0;
  let invulnTimer = 0;              // post-respawn invulnerability
  let fxHudTimer = 0;               // effects DOM refresh counter
  let fxHudSig = '';                // last rendered effect set signature

  /* feature T9: segments cut off by the decompiler beam */
  let debris = [];                  // [{x,y,t}] — pulsing cyan, 5 s to live

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
    const mult = hasEffect('surge') ? SURGE_SCORE : 1; // feature T8: surge doubles gains
    score += n * mult;
    if (score > best) {
      best = score;
      saveBest();
      CS.UI.hud({ best: best });
    }
    CS.UI.hud({ score: score });
  }

  /* feature T8: a virus drops the score, never below zero (SPEC §11) */
  function penalizeScore(n) {
    score = Math.max(0, score - n);
    CS.UI.hud({ score: score });
  }

  /* ---------- timed effects (feature T8) ---------- */

  function hasEffect(type) {
    for (let i = 0; i < effects.length; i++) {
      if (effects[i].type === type) return true;
    }
    return false;
  }

  /* dur overrides the table default (feature T9: onFreeze carries one) */
  function addEffect(type, dur) {
    let d = EFFECT_DUR[type];
    if (typeof dur === 'number' && Number.isFinite(dur) && dur > 0) d = dur;
    if (!d) return;
    for (let i = 0; i < effects.length; i++) {
      if (effects[i].type === type) {
        effects[i].timer = d; // refresh an already running effect
        effects[i].total = d;
        if (type === 'surge' || type === 'slow' || type === 'freeze') applySpeed();
        return;
      }
    }
    effects.push({ type: type, timer: d, total: d });
    if (type === 'surge' || type === 'slow' || type === 'freeze') applySpeed();
  }

  function updateEffects(dt) {
    let speedDirty = false;
    for (let i = effects.length - 1; i >= 0; i--) {
      effects[i].timer -= dt;
      if (effects[i].timer <= 0) {
        if (effects[i].type === 'surge' || effects[i].type === 'slow' ||
            effects[i].type === 'freeze') speedDirty = true;
        effects.splice(i, 1);
      }
    }
    // surge / slow / freeze stack multiplicatively; recompute on expiry
    if (speedDirty) applySpeed();
  }

  /* ---------- food / bonus ---------- */

  function occupiedKeys() {
    const occ = new Set();
    for (let i = 0; i < snake.length; i++) {
      occ.add(key(snake[i].curr.x, snake[i].curr.y));
    }
    if (food) occ.add(key(food.x, food.y));
    if (bonus) occ.add(key(bonus.x, bonus.y));
    for (let i = 0; i < pickups.length; i++) { // feature T8
      occ.add(key(pickups[i].x, pickups[i].y));
    }
    for (let i = 0; i < debris.length; i++) { // feature T9
      occ.add(key(debris[i].x, debris[i].y));
    }
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

  /* ---------- pickups (feature T8, SPEC §11) ---------- */

  function manhattan(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  /* weighted random type; 'life' never spawns while the stock is full */
  function pickPickupType() {
    const pool = [];
    let total = 0;
    for (let i = 0; i < PICKUP_TYPES.length; i++) {
      const p = PICKUP_TYPES[i];
      if (p.type === 'life' && lives >= MAX_LIVES) continue;
      pool.push(p);
      total += p.weight;
    }
    let roll = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      roll -= pool[i].weight;
      if (roll <= 0) return pool[i].type;
    }
    return pool.length ? pool[pool.length - 1].type : 'golden';
  }

  function spawnPickup() {
    if (pickups.length >= PICKUP_MAX_FIELD) return false;
    const c = randomFreeCell(occupiedKeys());
    if (!c) return false;
    pickups.push({ x: c.x, y: c.y, type: pickPickupType(), timer: PICKUP_LIFE });
    return true;
  }

  /* lifetimes tick down; the spawn timer holds while the field is full
     or a boss intro is playing (no pickups during the intro) */
  function updatePickups(dt) {
    for (let i = pickups.length - 1; i >= 0; i--) {
      pickups[i].timer -= dt;
      if (pickups[i].timer <= 0) pickups.splice(i, 1);
    }
    pickupTimer -= dt;
    if (pickupTimer > 0) return;
    if (pickups.length >= PICKUP_MAX_FIELD) return;
    if (fight && fight.active && fight.phase === 'intro') return;
    if (spawnPickup()) {
      pickupTimer = PICKUP_MIN + Math.random() * (PICKUP_MAX - PICKUP_MIN);
    } else {
      pickupTimer = 1; // the field was too crowded: retry in a second
    }
  }

  function applyPickup(p) {
    const px = p.x * CELL + CELL / 2;
    const py = p.y * CELL + CELL / 2;
    if (p.type === 'virus') {
      penalizeScore(VIRUS_PENALTY);
      CS.FX.glitch(0.3);
      CS.FX.burst(px, py, '#ff7a00', 12);
      CS.UI.toast(tr('pVirus'));
      CS.Audio.sfx('pickupBad');
    } else if (p.type === 'golden') {
      addScore(GOLDEN_SCORE);
      CS.FX.burst(px, py, '#ffe600', 14);
      CS.UI.toast(tr('pGolden'));
      CS.Audio.sfx('pickup');
    } else if (p.type === 'surge' || p.type === 'slow' || p.type === 'magnet') {
      addEffect(p.type);
      CS.FX.burst(px, py, p.type === 'surge' ? '#ffe600' : (p.type === 'slow' ? '#7de3ff' : '#00f0ff'), 12);
      CS.UI.toast(tr('p' + p.type.charAt(0).toUpperCase() + p.type.slice(1)));
      CS.Audio.sfx('pickup');
    } else if (p.type === 'life') {
      if (lives < MAX_LIVES) lives++;
      updateLivesHud();
      CS.FX.burst(px, py, '#ff2d55', 14);
      CS.UI.toast(tr('pLife'));
      CS.Audio.sfx('life');
    }
  }

  /* ---------- levels / speed ---------- */

  function applySpeed() {
    let tps = Math.min(MAX_TPS, BASE_TPS + TPS_STEP * (level - 1));
    // feature T8: surge and slow stack multiplicatively on top of the
    // level-based base (which stays frozen during a boss fight)
    if (hasEffect('surge')) tps *= SURGE_SPEED;
    if (hasEffect('slow')) tps *= SLOW_FACTOR;
    // feature T9: the cryogen freeze multiplies on top of everything
    if (hasEffect('freeze')) tps *= FREEZE_FACTOR;
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
      },
      /* feature T9 (SPEC §12): all optional on the boss side, but the
         game always provides them */
      onCut: onBossCut,
      onTailBite: onBossTailBite,
      onFreeze: onBossFreeze
    };
  }

  /* ---------- feature T9: boss event handlers (SPEC §12) ---------- */

  /* decompiler beam: everything from the cut index to the tail drops
     off as debris; the snake keeps at least 3 segments */
  function onBossCut(segmentIndex) {
    if (!snake.length) return;
    let cut = Math.floor(Number(segmentIndex));
    if (!Number.isFinite(cut)) return;
    cut = Math.max(3, Math.min(cut, snake.length));
    if (cut >= snake.length) return; // shorter than the minimum — no drop
    for (let i = cut; i < snake.length; i++) {
      const c = snake[i].curr;
      debris.push({ x: c.x, y: c.y, t: DEBRIS_LIFE });
      CS.FX.burst(c.x * CELL + CELL / 2, c.y * CELL + CELL / 2, '#00f0ff', 8);
    }
    snake.length = cut;
    CS.FX.shake(6);
  }

  /* debris lifetimes: 5 s to reabsorb, then -25 per lost segment */
  function updateDebris(dt) {
    if (!debris.length) return;
    let expired = 0;
    for (let i = debris.length - 1; i >= 0; i--) {
      debris[i].t -= dt;
      if (debris[i].t <= 0) {
        CS.FX.burst(
          debris[i].x * CELL + CELL / 2,
          debris[i].y * CELL + CELL / 2,
          '#3a5a6a', 4
        );
        debris.splice(i, 1);
        expired++;
      }
    }
    if (expired) penalizeScore(DEBRIS_PENALTY * expired);
  }

  /* devourer bite: up to 3 tail segments, min length 3, -25 each */
  function onBossTailBite() {
    CS.Audio.sfx('gulp');
    CS.FX.shake(5);
    if (snake.length <= 3) return; // nothing edible left
    const n = Math.min(BITE_MAX, snake.length - 3);
    for (let i = 0; i < n; i++) {
      const tail = snake.pop();
      CS.FX.burst(
        tail.curr.x * CELL + CELL / 2,
        tail.curr.y * CELL + CELL / 2,
        '#ff2d55', 8
      );
      penalizeScore(BITE_PENALTY);
    }
  }

  /* cryogen wave: tick speed x0.45 for d seconds (stacks with surge/slow) */
  function onBossFreeze(d) {
    const dur = Number(d);
    if (!Number.isFinite(dur) || dur <= 0) return;
    addEffect('freeze', Math.min(dur, 10));
    CS.FX.flash('#7de3ff', 0.18);
  }

  function startBoss(idx) {
    fight = new CS.BossFight(idx, GRID_W, GRID_H, bossEvents());
    state = 'boss';
    CS.Audio.music('boss');
    CS.UI.bossBar(fight.hp, fight.maxHp, true, fight.name);
    lastBossHp = fight.hp;
    CS.UI.toast(tr('hintBoss')); // how to damage the boss — right when it matters
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
    if (state === 'dying' || state === 'gameover' || state === 'respawning') return;
    if (lives > 0) { // feature T8: a spare life reboots the snake
      startRespawn();
      return;
    }
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

  /* feature T8: spend a life, reboot, come back 3 segments strong */
  function startRespawn() {
    lives--;
    updateLivesHud();
    state = 'respawning';
    respawnTimer = RESPAWN_TIME;
    stepTimer = 0;
    dirQueue = [];
    CS.Audio.sfx('respawn');
    CS.UI.toast(tr('respawnToast'));
    const n = snake.length;
    for (let i = 0; i < n; i++) {
      CS.FX.burst(
        snake[i].curr.x * CELL + CELL / 2,
        snake[i].curr.y * CELL + CELL / 2,
        segColor(i, n),
        10
      );
    }
    snake = []; // nothing to steer until the reboot lands
    CS.FX.shake(10);
    CS.FX.glitch(0.4);
    CS.FX.flash('#ff2d55', 0.2);
  }

  function finishRespawn() {
    const cx = Math.floor(GRID_W / 2);
    const cy = Math.floor(GRID_H / 2);
    snake = [];
    for (let i = 0; i < RESPAWN_LEN; i++) {
      const x = cx - i;
      snake.push({ prev: { x: x, y: cy }, curr: { x: x, y: cy } });
    }
    dir = DIR.right;
    dirQueue = [];
    growth = 0;
    stepTimer = 0;
    invulnTimer = RESPAWN_INVULN;
    // score / level / the live boss fight all survive the reboot
    state = fight && fight.active ? 'boss' : 'playing';
    if (state === 'boss') CS.Audio.music('boss');
    else CS.Audio.music('game');
  }

  function finishGameOver() {
    state = 'gameover';
    fight = null;
    pendingBoss = 0;
    pickups = [];      // feature T8
    effects = [];
    debris = [];       // feature T9
    invulnTimer = 0;
    applySpeed();      // drop surge/slow multipliers from stepInterval
    renderEffectsHud();
    if (score > best) {
      best = score;
      saveBest();
    }
    CS.UI.hud({ score: score, best: best });
    CS.UI.bossBar(0, 0, false);
    CS.UI.banner(null, false);
    CS.UI.show('gameover');
    offerScoreSave(); // feature T10: top-10 name save
  }

  /* ---------- feature T10: leaderboard save (SPEC §13) ---------- */

  function loadPlayerName() {
    try {
      return window.localStorage.getItem('cs_name') || '';
    } catch (e) {
      return '';
    }
  }

  function savePlayerName(name) {
    try {
      window.localStorage.setItem('cs_name', name);
    } catch (e) {
      /* storage unavailable: skip persistence */
    }
  }

  function hideScoreSave() {
    const box = document.getElementById('score-save');
    if (box) box.classList.add('hidden');
  }

  /* a qualifying score reveals the name input with the last used name */
  function offerScoreSave() {
    const box = document.getElementById('score-save');
    if (!box) return;
    const ok = CS.Leaderboard &&
      typeof CS.Leaderboard.qualifies === 'function' &&
      CS.Leaderboard.qualifies(score);
    if (!ok) {
      box.classList.add('hidden');
      return;
    }
    const input = document.getElementById('player-name');
    if (input) input.value = loadPlayerName();
    box.classList.remove('hidden');
    if (input && typeof input.focus === 'function') input.focus();
  }

  /* "Save" button / Enter in the name field: submit, then show the board */
  function submitScore() {
    const input = document.getElementById('player-name');
    const name = input ? String(input.value || '').trim() : '';
    if (name && CS.Leaderboard && typeof CS.Leaderboard.submit === 'function') {
      if (CS.Leaderboard.submit({ name: name, score: score, level: level })) {
        savePlayerName(name);
      }
    }
    hideScoreSave();
    CS.Audio.sfx('levelup');
    if (CS.UI && typeof CS.UI.renderBoard === 'function') CS.UI.renderBoard();
    CS.UI.show('board');
  }

  /* ---------- shared pickup code (also used by the T8 magnet) ---------- */

  function eatFoodAt(x, y) {
    addScore(FOOD_SCORE * level);
    eaten++;
    growth += 1;
    CS.Audio.sfx('eat');
    CS.FX.burst(x * CELL + CELL / 2, y * CELL + CELL / 2, '#ff2bd6', 7);
    food = null;
    spawnFood();
    if (eaten % FOOD_PER_LEVEL === 0) levelUp();
    if (eaten % BONUS_EVERY === 0 && !bonus) spawnBonus();
  }

  function eatBonusAt(x, y) {
    addScore(BONUS_SCORE);
    growth += BONUS_GROW;
    CS.FX.burst(x * CELL + CELL / 2, y * CELL + CELL / 2, '#ffe600', 14);
    bonus = null;
    CS.Audio.sfx('bonus');
  }

  function collectChargeAt(x, y) {
    if (!fight || !fight.active) return;
    if (!fight.collectCharge(x, y)) return;
    CS.FX.burst(x * CELL + CELL / 2, y * CELL + CELL / 2, '#00ff9d', 10);
    CS.FX.shake(4);
    addScore(CHARGE_SCORE); // the fight may be over now (onDefeated ran)
    if (fight && fight.active) {
      dmgPops.push({ x: (fight.x + 1) * CELL, y: (fight.y + 1) * CELL, t: DMG_POP_TIME });
    }
  }

  /* feature T8: every tick the magnet vacuums food / bonus / boss
     charges within MAGNET_RADIUS (manhattan) of the head */
  function magnetCollect() {
    if (!hasEffect('magnet') || !snake.length) return;
    const head = snake[0].curr;
    if (food && manhattan(food, head) <= MAGNET_RADIUS) eatFoodAt(food.x, food.y);
    if (bonus && manhattan(bonus, head) <= MAGNET_RADIUS) eatBonusAt(bonus.x, bonus.y);
    if (fight && fight.active) {
      const charges = fight.chargeCells();
      if (charges) {
        for (let i = 0; i < charges.length; i++) {
          if (manhattan(charges[i], head) <= MAGNET_RADIUS) {
            collectChargeAt(charges[i].x, charges[i].y);
          }
        }
      }
    }
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

    // self: the tail cell frees this tick unless the snake is growing;
    // skipped while invulnerable after a respawn (feature T8)
    const invuln = invulnTimer > 0;
    if (!invuln) {
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
    }

    // boss data charge at the target cell
    if (fight && fight.active) collectChargeAt(nx, ny);

    // every segment follows the one ahead of it
    const last = snake.length - 1;
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

    if (growth > 0) {
      growth--;
      // the new tail segment holds the old tail cell: prev = curr
      snake.push({
        prev: { x: oldTailX, y: oldTailY },
        curr: { x: oldTailX, y: oldTailY }
      });
    }

    // normal food
    if (food && food.x === nx && food.y === ny) eatFoodAt(nx, ny);

    // bonus fragment
    if (bonus && bonus.x === nx && bonus.y === ny) eatBonusAt(nx, ny);

    // pickups (feature T8)
    for (let i = pickups.length - 1; i >= 0; i--) {
      if (pickups[i].x === nx && pickups[i].y === ny) {
        const p = pickups[i];
        pickups.splice(i, 1);
        applyPickup(p);
      }
    }

    // feature T9: the head passing a debris cell reabsorbs the segment
    for (let i = debris.length - 1; i >= 0; i--) {
      if (debris[i].x === nx && debris[i].y === ny) {
        debris.splice(i, 1);
        const tail = snake[snake.length - 1];
        snake.push({
          prev: { x: tail.curr.x, y: tail.curr.y },
          curr: { x: tail.curr.x, y: tail.curr.y }
        });
        addScore(DEBRIS_SCORE);
        CS.Audio.sfx('pickup');
        CS.FX.burst(nx * CELL + CELL / 2, ny * CELL + CELL / 2, '#00f0ff', 10);
      }
    }

    // the magnet sweeps around the fresh head position (feature T8)
    magnetCollect();

    // the field was too crowded for a spawn earlier: retry
    if (!food) spawnFood();
  }

  /* ---------- state transitions ---------- */

  function startGame() {
    hideScoreSave();   // feature T10: a fresh run drops the save block
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
    pickups = [];      // feature T8
    effects = [];
    debris = [];       // feature T9
    lives = 0;
    respawnTimer = 0;
    invulnTimer = 0;
    pickupTimer = PICKUP_MIN + Math.random() * (PICKUP_MAX - PICKUP_MIN);
    applySpeed();
    updateLivesHud();
    renderEffectsHud();
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
    pickups = [];      // feature T8
    effects = [];
    debris = [];       // feature T9
    invulnTimer = 0;
    applySpeed();      // drop surge/slow multipliers from stepInterval
    renderEffectsHud();
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
    const key = muted ? 'soundOff' : 'soundOn';
    btn.textContent = muted ? '🔇' : '🔊';
    btn.title = tr(key);
    btn.setAttribute('data-i18n-title', key);
    if (btn.classList && typeof btn.classList.toggle === 'function') {
      btn.classList.toggle('muted', muted);
    }
  }

  /* ---------- feature T8: lives + active effects in the HUD ---------- */

  function updateLivesHud() {
    const el = document.getElementById('lives');
    if (el) el.textContent = '❤×' + lives;
  }

  /* Chips are rebuilt only when the active set changes; the timer
     strips are updated on the coarse FX_HUD_INTERVAL (DOM, not canvas) */
  function renderEffectsHud() {
    const box = document.getElementById('effects');
    if (!box) return;
    let sig = '';
    for (let i = 0; i < effects.length; i++) sig += effects[i].type + ',';
    if (sig !== fxHudSig) {
      fxHudSig = sig;
      box.innerHTML = '';
      for (let i = 0; i < effects.length; i++) {
        const e = effects[i];
        const chip = document.createElement('span');
        chip.className = 'fx-chip fx-' + e.type;
        chip.title = tr(EFFECT_LABEL[e.type]);
        const bar = document.createElement('i');
        bar.className = 'fx-bar';
        chip.appendChild(document.createTextNode(EFFECT_ICON[e.type]));
        chip.appendChild(bar);
        box.appendChild(chip);
      }
    }
    for (let i = 0; i < box.children.length && i < effects.length; i++) {
      const bar = box.children[i].querySelector('.fx-bar');
      if (!bar || !bar.style) continue;
      const k = Math.max(0, Math.min(1, effects[i].timer / effects[i].total));
      bar.style.width = (k * 100).toFixed(1) + '%';
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

    // feature T8: the effects DOM is refreshed on a coarse timer
    fxHudTimer -= dt;
    if (fxHudTimer <= 0) {
      fxHudTimer = FX_HUD_INTERVAL;
      renderEffectsHud();
    }

    if (bannerTimer > 0) {
      bannerTimer -= dt;
      if (bannerTimer <= 0) {
        bannerTimer = 0;
        CS.UI.banner(null, false);
      }
    }

    for (let i = dmgPops.length - 1; i >= 0; i--) {
      dmgPops[i].t -= dt;
      if (dmgPops[i].t <= 0) dmgPops.splice(i, 1);
    }

    if (state === 'playing' || state === 'boss' || state === 'respawning') {
      if (bonus) {
        bonus.timer -= dt;
        if (bonus.timer <= 0) bonus = null;
      }
      updatePickups(dt);   // feature T8
      updateEffects(dt);   // feature T8
      updateDebris(dt);    // feature T9

      if (invulnTimer > 0) invulnTimer = Math.max(0, invulnTimer - dt);

      // feature T8: reboot pause — the world (and a live boss fight)
      // keeps running, the snake comes back afterwards
      if (state === 'respawning') {
        if (fight && fight.active) fight.update(dt, snakeCells());
        respawnTimer -= dt;
        if (respawnTimer <= 0) finishRespawn();
        return;
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
        if (state === 'dying' || state === 'respawning') {
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
    if (invulnTimer > 0 || !snake.length) return false; // feature T8: respawn shield
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
      drawPickups(); // feature T8
      drawDebris();  // feature T9
      if (fight && fight.active) fight.draw(g, CELL); // draws its charges itself
      drawSnake();
    }
    CS.FX.draw(g);
    drawDmgPops();
  }

  function drawDmgPops() {
    for (let i = 0; i < dmgPops.length; i++) {
      const p = dmgPops[i];
      const k = p.t / DMG_POP_TIME;   // 1 → 0
      const rise = (1 - k) * 26;      // floats 26 px up while fading
      g.save();
      g.globalAlpha = Math.max(0, Math.min(1, k * 1.4));
      g.font = 'bold 22px "Cascadia Mono", Consolas, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.shadowColor = '#ff2d55';
      g.shadowBlur = 10;
      g.fillStyle = '#ff2d55';
      g.fillText('-1', p.x, p.y - rise);
      g.restore();
    }
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

  /* ---------- pickup shapes (feature T8): forms, not squares ---------- */

  function drawHeartShape(s) {
    const r = s * 0.27; // lobe radius
    g.beginPath();
    g.arc(-s * 0.26, -s * 0.16, r, Math.PI * 0.8, Math.PI * 1.95);
    g.arc(s * 0.26, -s * 0.16, r, Math.PI * 1.05, Math.PI * 0.2);
    g.lineTo(0, s * 0.5); // the triangle tip
    g.closePath();
    g.fill();
  }

  function drawBoltShape(s) {
    g.beginPath();
    g.moveTo(s * 0.12, -s * 0.5);
    g.lineTo(-s * 0.28, s * 0.08);
    g.lineTo(-s * 0.02, s * 0.08);
    g.lineTo(-s * 0.12, s * 0.5);
    g.lineTo(s * 0.28, -s * 0.08);
    g.lineTo(s * 0.02, -s * 0.08);
    g.closePath();
    g.fill();
  }

  function drawMagnetShape(s) {
    const r = s * 0.3;
    const y = s * 0.08;
    g.lineCap = 'butt';
    g.lineWidth = s * 0.3;
    g.strokeStyle = '#00f0ff';
    g.beginPath();
    g.arc(0, y, r, Math.PI, Math.PI * 2); // horseshoe opening down
    g.stroke();
    g.fillStyle = '#eafcff'; // pale pole tips
    g.fillRect(-r - s * 0.15, y, s * 0.3, s * 0.2);
    g.fillRect(r - s * 0.15, y, s * 0.3, s * 0.2);
  }

  function drawSnowflakeShape(s) {
    g.strokeStyle = '#7de3ff';
    g.lineWidth = 2;
    g.lineCap = 'round';
    for (let k = 0; k < 6; k++) {
      const a = k * Math.PI / 3;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(dx * s * 0.5, dy * s * 0.5);
      g.stroke();
      // a little barb pair on each ray
      g.beginPath();
      g.moveTo(dx * s * 0.28 - dy * s * 0.13, dy * s * 0.28 + dx * s * 0.13);
      g.lineTo(dx * s * 0.4, dy * s * 0.4);
      g.lineTo(dx * s * 0.28 + dy * s * 0.13, dy * s * 0.28 - dx * s * 0.13);
      g.stroke();
    }
  }

  function drawSkullShape(s) {
    g.fillStyle = '#ff7a00';
    g.beginPath(); // cranium
    g.arc(0, -s * 0.1, s * 0.38, 0, Math.PI * 2);
    g.fill();
    g.fillRect(-s * 0.22, s * 0.14, s * 0.44, s * 0.24); // jaw
    g.fillStyle = BG;
    g.beginPath(); // eye sockets
    g.arc(-s * 0.15, -s * 0.14, s * 0.11, 0, Math.PI * 2);
    g.arc(s * 0.15, -s * 0.14, s * 0.11, 0, Math.PI * 2);
    g.fill();
    g.fillRect(-s * 0.045, s * 0.14, s * 0.09, s * 0.24); // tooth gap
  }

  function drawGoldenShape(s) {
    g.beginPath(); // diamond
    g.moveTo(0, -s * 0.5);
    g.lineTo(s * 0.38, 0);
    g.lineTo(0, s * 0.5);
    g.lineTo(-s * 0.38, 0);
    g.closePath();
    g.fill();
    g.fillStyle = '#ffffff'; // inner spark
    g.beginPath();
    g.moveTo(0, -s * 0.22);
    g.lineTo(s * 0.16, 0);
    g.lineTo(0, s * 0.22);
    g.lineTo(-s * 0.16, 0);
    g.closePath();
    g.fill();
  }

  function drawPickups() {
    for (let i = 0; i < pickups.length; i++) {
      const p = pickups[i];
      if (p.timer <= PICKUP_BLINK && Math.floor(animTime * 8) % 2 === 0) continue;
      const cx = p.x * CELL + CELL / 2;
      const cy = p.y * CELL + CELL / 2;
      const pulse = 0.5 + 0.5 * Math.sin(animTime * 5 + i * 1.7);
      const s = CELL * 0.7 * (0.92 + 0.08 * pulse); // light pulsation
      const color = p.type === 'life' ? '#ff2d55'
        : p.type === 'surge' ? '#ffe600'
        : p.type === 'magnet' ? '#00f0ff'
        : p.type === 'slow' ? '#7de3ff'
        : p.type === 'virus' ? '#ff7a00'
        : '#ffe600';
      g.save();
      g.translate(cx, cy);
      g.shadowColor = color;
      g.shadowBlur = 8 + 10 * pulse; // glow like the food
      g.fillStyle = color;
      if (p.type === 'life') drawHeartShape(s);
      else if (p.type === 'surge') drawBoltShape(s);
      else if (p.type === 'magnet') drawMagnetShape(s);
      else if (p.type === 'slow') drawSnowflakeShape(s);
      else if (p.type === 'virus') drawSkullShape(s);
      else drawGoldenShape(s);
      g.restore();
    }
  }

  /* feature T9: cut-off segments pulse in cyan on their cells,
     blinking during the last two seconds */
  function drawDebris() {
    for (let i = 0; i < debris.length; i++) {
      const d = debris[i];
      if (d.t <= 2 && Math.floor(animTime * 8) % 2 === 0) continue;
      const pulse = 0.5 + 0.5 * Math.sin(animTime * 6 + i * 1.3);
      const x = d.x * CELL;
      const y = d.y * CELL;
      g.save();
      g.shadowColor = '#00f0ff';
      g.shadowBlur = 6 + 10 * pulse;
      g.fillStyle = 'rgba(0,240,255,' + (0.3 + 0.4 * pulse).toFixed(3) + ')';
      roundRect(g, x + 4, y + 4, CELL - 8, CELL - 8, 4);
      g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = '#bffcff';
      g.lineWidth = 1.5;
      g.strokeRect(x + 7.5, y + 7.5, CELL - 15, CELL - 15);
      g.restore();
    }
  }

  function drawSnake() {
    const n = snake.length;
    if (!n) return; // feature T8: empty during the 'respawning' reboot
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
    if (invulnTimer > 0) {
      // feature T8: the respawn shield blinks the whole snake
      g.globalAlpha = Math.max(0.08, 0.35 + 0.65 * Math.sin(animTime * 12));
    }
    if (isHead) {
      g.shadowColor = color;
      g.shadowBlur = 16;
    }
    roundRect(g, x + pad, y + pad, CELL - pad * 2, CELL - pad * 2, isHead ? 8 : 6);
    g.fill();
    if (hasEffect('freeze')) {
      // feature T9: pale ice shell while the cryogen freeze holds
      g.shadowBlur = 0;
      g.strokeStyle = 'rgba(125,227,255,0.75)';
      g.lineWidth = 1.5;
      roundRect(g, x + pad + 1, y + pad + 1, CELL - pad * 2 - 2, CELL - pad * 2 - 2, 5);
      g.stroke();
    }
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
      if (hasEffect('freeze')) {
        // feature T9: little ice crystals sprouting on the frozen head
        g.fillStyle = '#eafaff';
        g.strokeStyle = '#7de3ff';
        g.lineWidth = 1;
        for (let k = 0; k < 3; k++) {
          const ang = -Math.PI / 2 + (k - 1) * 0.7;
          const cr = CELL * 0.14;
          const cxx = x + CELL / 2 + Math.cos(ang) * CELL * 0.28;
          const cyy = y + CELL / 2 + Math.sin(ang) * CELL * 0.28;
          g.beginPath();
          g.moveTo(cxx, cyy - cr);
          g.lineTo(cxx + cr * 0.5, cyy);
          g.lineTo(cxx, cyy + cr);
          g.lineTo(cxx - cr * 0.5, cyy);
          g.closePath();
          g.fill();
          g.stroke();
        }
      }
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

    // screen buttons (start / resume / restart / menu / mute / lang / save)
    CS.UI.on({
      start: startGame,
      restart: startGame,
      resume: resumeGame,
      menu: goMenu,
      mute: toggleMute,
      lang: showLangScreen,
      save: submitScore // feature T10
    });

    // #btn-pause is not part of the CS.UI.on contract — wire it directly
    const pauseBtn = document.getElementById('btn-pause');
    if (pauseBtn) pauseBtn.addEventListener('click', togglePauseButton);

    // feature T10: Enter inside the name field saves the score and must
    // not leak to the global Enter restart
    const nameInput = document.getElementById('player-name');
    if (nameInput) {
      nameInput.addEventListener('keydown', function (e) {
        if ((e.key || '') !== 'Enter') return;
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        submitScore();
      });
    }

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
