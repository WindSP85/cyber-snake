/* ============================================================
   NEON://SNAKE — game orchestrator (SPEC §2, §3, §4, §7, §11–§14, §20, §21)
   CS.Game owns the state machine, the snake core, food/bonus,
   pickups, mystery containers and the tail bank, levels & speed,
   boss integration, the death sequence, input (keyboard + touch),
   the main rAF loop and the best score.

   States: 'menu' | 'playing' | 'boss' | 'paused' | 'gameover' | 'duel'
   plus the internal 'dying' (1 s freeze before the game over) and
   'respawning' (feature T8: a spent life reboots the snake).
   'duel' (feature T23) delegates the whole world to CS.Duel
   (js/duel.js) — the solo states never run alongside it.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  /* ---------- tuning constants ---------- */

  /* feature T13: adaptive arena — the defaults are the classic desktop
     grid; computeGrid() re-derives both from the screen proportions */
  let GRID_W = 30;
  let GRID_H = 20;
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
  const INPUT_BUFFER = 2;             // 2 + axis-replacement = spam-proof responsiveness
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

  /* feature T11: mystery containers + the tail bank (SPEC §14) */
  const MYSTERY_JACKPOT = 500;      // instant score payout
  const DOUBLE_TIME = 10;           // score x2 effect, seconds
  const DOUBLE_SCORE = 2;           // score multiplier while 'double' runs
  const TURBO_TIME = 6;             // speed x2 effect, seconds
  const TURBO_SPEED = 2.0;          // multiplies with surge / slow / freeze
  const REVERSE_TIME = 7;           // inverted controls, seconds
  const SPLIT_KEEP = 3;             // head segments kept by the split
  const SPLIT_MIN_LEN = 5;          // the split needs a longer snake
  const ESCAPED_LIFE = 8;           // escaped core lifetime, seconds
  const ESCAPED_BLINK = 2;          // blink during the last seconds
  const ESCAPED_SCORE = 100;        // per core caught by the head
  const BANK_MIN = 22;              // spawn interval range: 30±8 seconds
  const BANK_MAX = 38;
  const BANK_LIFE = 10;             // bank lifetime, seconds
  const BANK_BLINK = 2;             // blink during the last seconds
  const BANK_ZONE = { x0: 2, y0: 2, x1: 27, y1: 17 }; // 2 cells off the walls
  const BANK_KEEP = 4;              // segments kept after the conversion
  const BANK_SEGMENT_SCORE = 15;    // x level per converted segment
  const BANK_INTEREST = 50;         // flat payout at length <= 4

  /* feature T20: daily challenge modifiers (SPEC §20) — the day pick
     and the active flag live in CS.Daily (js/daily.js); these are the
     tuning numbers applied at each decision point below */
  const DAILY_ICE_SPEED = 0.6;      // 'ice': whole-run tick multiplier
  const DAILY_CREAM_SCORE = 2;      // 'cream': food score multiplier
  const DAILY_CREAM_GROW = 2;       // 'cream': growth per food (base 1)
  const DAILY_DARK_R0 = 4;          // 'dark': fully visible radius, cells
  const DAILY_DARK_R1 = 7;          // 'dark': almost black by here, cells

  /* feature T21: first-runs tutorial (SPEC §21) */
  const TUT_RUNS = 2;               // hints live in the first 2 runs only
  const TUT_MOVE_DELAY = 1;         // move hint after the run start, s
  const TUT_FOOD_DELAY = 2.5;       // food hint after the move one, s
  const TUT_DANGER_DELAY = 1.5;     // flash hint after the boss one, s
  const IS_TOUCH = 'ontouchstart' in window; // swipe vs arrows wording

  /* weighted pickup types (SPEC §14 weights); 'life' is excluded
     while lives are full */
  const PICKUP_TYPES = [
    { type: 'virus', weight: 25 },
    { type: 'golden', weight: 15 },
    { type: 'surge', weight: 12 },
    { type: 'slow', weight: 12 },
    { type: 'magnet', weight: 8 },
    { type: 'life', weight: 8 },
    { type: 'mystery', weight: 20 }
  ];

  /* feature T11: weighted mystery outcomes; 'life' is rerolled into
     'jackpot' while the life stock is full */
  const MYSTERY_EFFECTS = [
    { type: 'jackpot', weight: 15 },
    { type: 'double', weight: 15 },
    { type: 'turbo', weight: 12 },
    { type: 'life', weight: 8 },
    { type: 'reverse', weight: 15 },
    { type: 'split', weight: 15 },
    { type: 'death', weight: 10 }
  ];

  const EFFECT_DUR = {
    surge: SURGE_TIME,
    slow: SLOW_TIME,
    magnet: MAGNET_TIME,
    freeze: 3,
    double: DOUBLE_TIME,   // feature T11
    turbo: TURBO_TIME,     // feature T11
    reverse: REVERSE_TIME  // feature T11
  };
  const EFFECT_ICON = {
    surge: '⚡',
    slow: '❄',
    magnet: '🧲',
    freeze: '🧊',
    double: '×2',          // feature T11
    turbo: '⚡⚡',          // feature T11
    reverse: '⇄'           // feature T11
  };
  const EFFECT_LABEL = {
    surge: 'pSurge',
    slow: 'pSlow',
    magnet: 'pMagnet',
    freeze: 'pFreeze',
    double: 'mDouble',     // feature T11
    turbo: 'mTurbo',       // feature T11
    reverse: 'mReverse'    // feature T11
  };

  const PALETTE = ['#00f0ff', '#ff2bd6', '#ffe600', '#00ff9d', '#ff7a00'];
  const BG = '#04050c';
  const GRID_LINE = 'rgba(0,240,255,.07)';
  /* feature T17: the head/tail HSL pair moved to the 'neon' skin in
     js/skins.js — every segment color now comes from CS.Skins */

  const DIR = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };
  const DIRS4 = [DIR.up, DIR.down, DIR.left, DIR.right]; // feature T11: core roaming

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

  /* feature T11: mystery containers + the tail bank (SPEC §14) */
  let escaped = [];                 // [{x,y,t}] — cores shed by the split
  let bank = null;                  // {x,y,t} — tail bank portal or null
  let bankTimer = 0;                // countdown to the next bank spawn

  let running = false;
  let lastTs = 0;
  let touchStart = null;
  let gestured = false;

  /* feature T21: run counter + pending tutorial toasts (SPEC §21) */
  let runs = loadRuns();             // started runs, persisted as cs_runs
  let tutTimers = [];                // [{text, t}] — toasts pending in game time
  let tutLifeShown = false;          // the ❤ hint fires once per run
  let tutDangerShown = false;        // the flash hint fires once per run

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

  /* ---------- feature T21: run counter + tutorial queue ---------- */

  function loadRuns() {
    try {
      const v = parseInt(window.localStorage.getItem('cs_runs'), 10);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (e) {
      return 0;
    }
  }

  /* every started run counts; the tutorial window is runs <= TUT_RUNS */
  function bumpRuns() {
    runs++;
    try {
      window.localStorage.setItem('cs_runs', String(runs));
    } catch (e) {
      /* storage unavailable: the counter lives until reload */
    }
  }

  /* a tutorial toast fires after `delay` seconds of game time — a
     pause holds the queue, leaving the run drops it */
  function queueTut(text, delay) {
    tutTimers.push({ text: text, t: delay });
  }

  /* feature T19: an upgrade value from CS.Upg (js/upgrades.js);
     the neutral fallback keeps the game playable even when the
     module is somehow missing */
  function upgVal(id, fallback) {
    if (CS.Upg && typeof CS.Upg.val === 'function') {
      const v = CS.Upg.val(id);
      if (Number.isFinite(v)) return v;
    }
    return fallback;
  }

  /* feature T20: true while the live run carries the given daily
     modifier — CS.Daily owns the flag, startGame() sets it */
  function dailyOn(id) {
    return !!(CS.Daily && typeof CS.Daily.active === 'function' &&
      CS.Daily.active() === id);
  }

  /* feature T17: every segment color comes from the active skin
     (js/skins.js); the death / respawn / split / bank bursts and
     drawSegment all reuse this single path */
  function segColor(i, n) {
    return CS.Skins.colors(i, n, animTime);
  }

  /* feature T11: linear blend of two rgb triples, k = 0..1 */
  function mixRgb(a, b, k) {
    const r = Math.round(a[0] + (b[0] - a[0]) * k);
    const g2 = Math.round(a[1] + (b[1] - a[1]) * k);
    const b2 = Math.round(a[2] + (b[2] - a[2]) * k);
    return 'rgb(' + r + ',' + g2 + ',' + b2 + ')';
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

  /* every score multiplier in one place: surge x2 (T8) and the
     mystery 'double' x2 (T11) stack multiplicatively */
  function scoreMult() {
    let m = 1;
    if (hasEffect('surge')) m *= SURGE_SCORE;
    if (hasEffect('double')) m *= DOUBLE_SCORE;
    return m;
  }

  /* returns the amount actually awarded (multipliers included) */
  function addScore(n) {
    const gained = n * scoreMult();
    score += gained;
    if (score > best) {
      best = score;
      saveBest();
      CS.UI.hud({ best: best });
    }
    CS.UI.hud({ score: score });
    CS.Ach.event('score', score); // feature T16: the current score
    return gained;
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

  /* effects that change the tick speed must recompute stepInterval */
  function isSpeedEffect(type) {
    return type === 'surge' || type === 'slow' || type === 'freeze' ||
      type === 'turbo'; // feature T11
  }

  /* dur overrides the table default (feature T9: onFreeze carries one) */
  function addEffect(type, dur) {
    let d = EFFECT_DUR[type];
    if (typeof dur === 'number' && Number.isFinite(dur) && dur > 0) d = dur;
    if (!d) return;
    // feature T19: the 'duration' upgrade stretches every timed effect
    // but the boss freeze (the cryogen brings its own timer)
    if (type !== 'freeze') d *= upgVal('duration', 1);
    for (let i = 0; i < effects.length; i++) {
      if (effects[i].type === type) {
        effects[i].timer = d; // refresh an already running effect
        effects[i].total = d;
        if (isSpeedEffect(type)) applySpeed();
        return;
      }
    }
    effects.push({ type: type, timer: d, total: d });
    if (isSpeedEffect(type)) applySpeed();
  }

  function updateEffects(dt) {
    let speedDirty = false;
    for (let i = effects.length - 1; i >= 0; i--) {
      effects[i].timer -= dt;
      if (effects[i].timer <= 0) {
        if (isSpeedEffect(effects[i].type)) speedDirty = true;
        effects.splice(i, 1);
      }
    }
    // surge / slow / freeze / turbo stack multiplicatively; recompute
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
    for (let i = 0; i < escaped.length; i++) { // feature T11
      occ.add(key(escaped[i].x, escaped[i].y));
    }
    if (bank) occ.add(key(bank.x, bank.y)); // feature T11
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
      let w = p.weight;
      // feature T20: the daily 'hunt' doubles the mystery and virus
      // weights — more containers, meaner viruses
      if (dailyOn('hunt') && (p.type === 'mystery' || p.type === 'virus')) {
        w *= 2;
      }
      pool.push({ type: p.type, weight: w });
      total += w;
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

  /* feature T19: the 'luck' upgrade shortens the spawn interval
     (x0.8 per bought level: 1 / .8 / .64 / .512) */
  function pickupInterval() {
    return (PICKUP_MIN + Math.random() * (PICKUP_MAX - PICKUP_MIN)) *
      upgVal('luck', 1);
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
      pickupTimer = pickupInterval(); // feature T19: the luck multiplier
    } else {
      pickupTimer = 1; // the field was too crowded: retry in a second
    }
  }

  function applyPickup(p) {
    const px = p.x * CELL + CELL / 2;
    const py = p.y * CELL + CELL / 2;
    CS.TG.haptic('click'); // feature T15: every pickup ticks
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
      // feature T21: the first life pickup of the tutorial runs
      // explains the stock instead of the plain "+1 LIFE"
      if (runs <= TUT_RUNS && !tutLifeShown) {
        tutLifeShown = true;
        CS.UI.toast(tr('tutLife'));
      } else {
        CS.UI.toast(tr('pLife'));
      }
      CS.Audio.sfx('life');
    } else if (p.type === 'mystery') { // feature T11
      applyMystery(px, py);
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
    // feature T11: the mystery turbo multiplies on top of everything
    if (hasEffect('turbo')) tps *= TURBO_SPEED;
    // feature T20: the daily 'ice' slows the entire run
    if (dailyOn('ice')) tps *= DAILY_ICE_SPEED;
    stepInterval = 1 / tps;
  }

  function levelUp() {
    level++;
    CS.UI.hud({ level: level });
    CS.Ach.event('level', level); // feature T16
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
    // feature T21: in the tutorial runs the white-flash warning
    // follows the boss hint (the only boss-specific danger cue)
    if (runs <= TUT_RUNS && !tutDangerShown) {
      tutDangerShown = true;
      queueTut(tr('tutDanger'), TUT_DANGER_DELAY);
    }
  }

  function onBossDefeated() {
    const idx = fight ? fight.bossIndex : 1;
    addScore(BOSS_SCORE * idx);
    CS.Ach.event('bossDown'); // feature T16: all-time kill counter
    CS.TG.haptic('success'); // feature T15: victory pulse
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
    CS.TG.haptic('error'); // feature T15: the death buzz
    if (lives > 0) { // feature T8: a spare life reboots the snake
      CS.Ach.event('respawn'); // feature T16: a spent life counts
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
    escaped = [];      // feature T11
    bank = null;       // feature T11
    tutTimers = [];    // feature T21: no hints past the game over
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
    // feature T19: bank floor(score/100) data chips for the shop
    const earned = (CS.Upg && typeof CS.Upg.earnRun === 'function')
      ? CS.Upg.earnRun(score)
      : 0;
    if (earned > 0) CS.UI.toast(tr('chipsEarn', earned));
    // feature T20: the day challenge is over — keep the day best and
    // announce the record (the toast lands after the chips one on
    // purpose: the day record is the headline of a challenge run)
    if (CS.Daily.active()) {
      if (score > CS.Daily.best()) {
        CS.Daily.setBest(score);
        CS.UI.toast(tr('dailyRecord', score));
      }
      CS.Daily.stop();
    }
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

  /* inside Telegram the account username becomes the default nickname */
  function telegramName() {
    try {
      const wa = window.Telegram && window.Telegram.WebApp;
      const u = wa && wa.initDataUnsafe && wa.initDataUnsafe.user;
      if (!u) return '';
      return String(u.username || u.first_name || '').trim().slice(0, 20);
    } catch (e) {
      return '';
    }
  }

  /* a qualifying score reveals the name input with the last used name
     (fallback: the Telegram account name) */
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
    if (input) input.value = loadPlayerName() || telegramName();
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
    // feature T20: the daily 'cream' doubles the food payout
    addScore(FOOD_SCORE * level * (dailyOn('cream') ? DAILY_CREAM_SCORE : 1));
    CS.Ach.event('meal'); // feature T16
    eaten++;
    // feature T20: 'cream' grows the snake twice as fast
    growth += dailyOn('cream') ? DAILY_CREAM_GROW : 1;
    CS.Audio.sfx('eat');
    CS.TG.haptic('click'); // feature T15
    CS.FX.burst(x * CELL + CELL / 2, y * CELL + CELL / 2, '#ff2bd6', 7);
    food = null;
    spawnFood();
    if (eaten % FOOD_PER_LEVEL === 0) levelUp();
    if (eaten % BONUS_EVERY === 0 && !bonus) spawnBonus();
  }

  function eatBonusAt(x, y) {
    addScore(BONUS_SCORE);
    growth += BONUS_GROW;
    CS.TG.haptic('click'); // feature T15
    CS.FX.burst(x * CELL + CELL / 2, y * CELL + CELL / 2, '#ffe600', 14);
    bonus = null;
    CS.Audio.sfx('bonus');
  }

  function collectChargeAt(x, y) {
    if (!fight || !fight.active) return;
    if (!fight.collectCharge(x, y)) return;
    CS.TG.haptic('click'); // feature T15: the boss took a hit
    CS.FX.burst(x * CELL + CELL / 2, y * CELL + CELL / 2, '#00ff9d', 10);
    CS.FX.shake(4);
    addScore(CHARGE_SCORE); // the fight may be over now (onDefeated ran)
    if (fight && fight.active) {
      dmgPops.push({ x: (fight.x + 1) * CELL, y: (fight.y + 1) * CELL, t: DMG_POP_TIME });
    }
  }

  /* feature T19: the base radius plus the bought 'magnet' bonus */
  function magnetRadius() {
    return MAGNET_RADIUS + upgVal('magnet', 0);
  }

  /* feature T8: every tick the magnet vacuums food / bonus / boss
     charges within the magnet radius (manhattan) of the head */
  function magnetCollect() {
    if (!hasEffect('magnet') || !snake.length) return;
    const head = snake[0].curr;
    const r = magnetRadius();
    if (food && manhattan(food, head) <= r) eatFoodAt(food.x, food.y);
    if (bonus && manhattan(bonus, head) <= r) eatBonusAt(bonus.x, bonus.y);
    if (fight && fight.active) {
      const charges = fight.chargeCells();
      if (charges) {
        for (let i = 0; i < charges.length; i++) {
          if (manhattan(charges[i], head) <= r) {
            collectChargeAt(charges[i].x, charges[i].y);
          }
        }
      }
    }
  }

  /* ---------- feature T11: mystery containers (SPEC §14) ---------- */

  /* weighted roll over the mystery table; a full life stock rerolls
     'life' into the jackpot */
  function rollMystery() {
    let total = 0;
    for (let i = 0; i < MYSTERY_EFFECTS.length; i++) total += MYSTERY_EFFECTS[i].weight;
    let roll = Math.random() * total;
    let type = MYSTERY_EFFECTS[MYSTERY_EFFECTS.length - 1].type;
    for (let i = 0; i < MYSTERY_EFFECTS.length; i++) {
      roll -= MYSTERY_EFFECTS[i].weight;
      if (roll <= 0) {
        type = MYSTERY_EFFECTS[i].type;
        break;
      }
    }
    if (type === 'life' && lives >= MAX_LIVES) return 'jackpot';
    return type;
  }

  function applyMystery(px, py, forced) {
    CS.Audio.sfx('mystery');
    CS.FX.flash('#ffffff', 0.15);
    CS.FX.burst(px, py, '#ff2bd6', 14);
    const kind = forced || rollMystery();
    CS.Ach.event('mystery'); // feature T16: every container counts
    if (kind === 'jackpot') {
      addScore(MYSTERY_JACKPOT);
      CS.Ach.event('jackpot'); // feature T16
      CS.TG.haptic('heavy'); // feature T15: the jackpot slams
      CS.UI.toast(tr('mJackpot'));
    } else if (kind === 'double') {
      addEffect('double');
      CS.UI.toast(tr('mDouble'));
    } else if (kind === 'turbo') {
      addEffect('turbo');
      CS.UI.toast(tr('mTurbo'));
    } else if (kind === 'life') {
      if (lives < MAX_LIVES) lives++;
      updateLivesHud();
      CS.FX.burst(px, py, '#ff2d55', 14);
      CS.Audio.sfx('life');
      CS.UI.toast(tr('mLifeRe'));
    } else if (kind === 'reverse') {
      addEffect('reverse');
      CS.Audio.sfx('reverse');
      CS.UI.toast(tr('mReverse'));
    } else if (kind === 'split') {
      CS.Audio.sfx('split');
      splitSnake();
      CS.UI.toast(tr('mSplit'));
    } else if (kind === 'death') {
      CS.UI.toast(tr('mDeath'));
      die(); // spare lives still save, as everywhere else (T8)
    }
  }

  /* the mystery 'split': the snake sheds everything past 3 segments;
     the first and the last shed cells hatch exactly two escaped cores */
  function splitSnake() {
    if (snake.length <= SPLIT_MIN_LEN) return; // too short to shed
    const shed = [];
    for (let i = SPLIT_KEEP; i < snake.length; i++) {
      shed.push({ x: snake[i].curr.x, y: snake[i].curr.y });
      CS.FX.burst(
        snake[i].curr.x * CELL + CELL / 2,
        snake[i].curr.y * CELL + CELL / 2,
        segColor(i, snake.length),
        8
      );
    }
    snake.length = SPLIT_KEEP;
    const occ = occupiedKeys();
    const first = escapedSpot(shed[0], occ);
    if (first) {
      escaped.push(first);
      occ.add(key(first.x, first.y));
    }
    const last = escapedSpot(shed[shed.length - 1], occ);
    if (last) escaped.push(last);
    CS.FX.shake(6);
  }

  /* a shed cell, or a free neighbour when it is taken */
  function escapedSpot(cell, occ) {
    if (!occ.has(key(cell.x, cell.y))) return { x: cell.x, y: cell.y, t: ESCAPED_LIFE };
    for (let k = 0; k < DIRS4.length; k++) {
      const nx = cell.x + DIRS4[k].x;
      const ny = cell.y + DIRS4[k].y;
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
      if (!occ.has(key(nx, ny))) return { x: nx, y: ny, t: ESCAPED_LIFE };
    }
    return null;
  }

  /* one cell away from the head per tick: pick the neighbour that
     grows the manhattan distance the most, avoiding walls, the snake
     and the other core; a cornered core stands still */
  function moveEscapedCores() {
    if (!escaped.length || !snake.length) return;
    const head = snake[0].curr;
    const blocked = new Set();
    for (let i = 0; i < snake.length; i++) {
      blocked.add(key(snake[i].curr.x, snake[i].curr.y));
    }
    for (let i = 0; i < escaped.length; i++) {
      blocked.add(key(escaped[i].x, escaped[i].y)); // cores block each other
    }
    for (let i = 0; i < escaped.length; i++) {
      const c = escaped[i];
      const dist = manhattan(c, head);
      let best = null;
      let bestDist = dist;
      for (let k = 0; k < DIRS4.length; k++) {
        const nx = c.x + DIRS4[k].x;
        const ny = c.y + DIRS4[k].y;
        if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
        if (blocked.has(key(nx, ny))) continue;
        const nd = manhattan({ x: nx, y: ny }, head);
        if (nd > bestDist) {
          bestDist = nd;
          best = { x: nx, y: ny };
        }
      }
      if (best) {
        blocked.delete(key(c.x, c.y));
        c.x = best.x;
        c.y = best.y;
        blocked.add(key(c.x, c.y));
      }
    }
  }

  /* escaped cores dissolve when their time runs out */
  function updateEscaped(dt) {
    for (let i = escaped.length - 1; i >= 0; i--) {
      escaped[i].t -= dt;
      if (escaped[i].t <= 0) {
        CS.FX.burst(
          escaped[i].x * CELL + CELL / 2,
          escaped[i].y * CELL + CELL / 2,
          '#ff2bd6', 6
        );
        escaped.splice(i, 1);
      }
    }
  }

  /* ---------- feature T11: the tail bank (SPEC §14) ---------- */

  function scheduleBankTimer() {
    bankTimer = BANK_MIN + Math.random() * (BANK_MAX - BANK_MIN); // 30±8 s
  }

  function spawnBank() {
    const occ = occupiedKeys();
    const free = [];
    // feature T13: the zone keeps its 2-cell wall margin on any grid
    // (identical to the 30x20 defaults on the classic desktop field)
    const zx1 = Math.min(BANK_ZONE.x1, GRID_W - 3);
    const zy1 = Math.min(BANK_ZONE.y1, GRID_H - 3);
    for (let y = BANK_ZONE.y0; y <= zy1; y++) {
      for (let x = BANK_ZONE.x0; x <= zx1; x++) {
        if (!occ.has(key(x, y))) free.push({ x: x, y: y });
      }
    }
    if (!free.length) return false;
    const c = free[Math.floor(Math.random() * free.length)];
    bank = { x: c.x, y: c.y, t: BANK_LIFE };
    return true;
  }

  /* the bank lives on its own schedule; it also runs during a boss
     fight (SPEC §14). An expired portal dissolves and the next one
     is planned */
  function updateBank(dt) {
    if (bank) {
      bank.t -= dt;
      if (bank.t <= 0) {
        CS.FX.burst(bank.x * CELL + CELL / 2, bank.y * CELL + CELL / 2, '#00ff9d', 8);
        bank = null;
        scheduleBankTimer();
      }
      return;
    }
    bankTimer -= dt;
    if (bankTimer > 0) return;
    if (spawnBank()) scheduleBankTimer();
    else bankTimer = 1; // the inner zone was full: retry in a second
  }

  /* the head entering the portal converts every segment past 4 into
     points (x15 x level, with the double/surge multipliers), or pays
     a flat 50 "deposit interest" when the snake is already short */
  function collectBank() {
    bank = null;
    scheduleBankTimer();
    CS.Audio.sfx('bank');
    CS.FX.shake(4);
    if (snake.length > BANK_KEEP) {
      const n = snake.length - BANK_KEEP;
      CS.Ach.event('bankConverted', n); // feature T16: segments banked
      for (let i = snake.length - 1; i >= BANK_KEEP; i--) {
        CS.FX.burst(
          snake[i].curr.x * CELL + CELL / 2,
          snake[i].curr.y * CELL + CELL / 2,
          segColor(i, snake.length),
          8
        );
      }
      snake.length = BANK_KEEP;
      CS.UI.toast(tr('bankToast', addScore(n * BANK_SEGMENT_SCORE * level)));
    } else {
      addScore(BANK_INTEREST);
      CS.UI.toast(tr('bankInterest'));
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

    // feature T11: a mystery death emptied the snake — nothing left to do
    if (!snake.length) return;

    // feature T11: the head catching an escaped core
    for (let i = escaped.length - 1; i >= 0; i--) {
      if (escaped[i].x === nx && escaped[i].y === ny) {
        escaped.splice(i, 1);
        addScore(ESCAPED_SCORE);
        CS.Ach.event('coresCaught'); // feature T16
        CS.Audio.sfx('pickup');
        CS.FX.burst(nx * CELL + CELL / 2, ny * CELL + CELL / 2, '#ff2bd6', 12);
      }
    }

    // feature T11: the head entering the tail bank portal
    if (bank && bank.x === nx && bank.y === ny) collectBank();

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

    // feature T11: the escaped cores flee one cell from the fresh head
    moveEscapedCores();

    // the field was too crowded for a spawn earlier: retry
    if (!food) spawnFood();
  }

  /* ---------- state transitions ---------- */

  /* feature T23 (SPEC §22): duel lifecycle. CS.Game.startDuel(opts)
     is the T24 ui entry point: opts pass straight into
     CS.Duel.begin({host, myIndex, onMatchEnd}); endDuel() returns
     to the menu. A duel can never be paused (SPEC §22). */
  function stopDuelIfActive() {
    if (CS.Duel && typeof CS.Duel.active === 'function' && CS.Duel.active()) {
      CS.Duel.stop();
      restoreSoloCanvas();
    }
  }

  function startDuel(opts) {
    if (!CS.Duel || typeof CS.Duel.begin !== 'function') return false;
    stopDuelIfActive();
    hideScoreSave();
    fight = null;
    pendingBoss = 0;
    bannerTimer = 0;
    pickups = [];
    effects = [];
    debris = [];
    escaped = [];
    bank = null;
    tutTimers = [];
    invulnTimer = 0;
    applySpeed();
    renderEffectsHud();
    CS.UI.bossBar(0, 0, false);
    CS.UI.banner(null, false);
    state = 'duel';
    CS.Duel.begin(opts);
    return true;
  }

  function endDuel() {
    stopDuelIfActive();
    goMenu();
  }

  function startGame(opts) {
    stopDuelIfActive(); // feature T23: a solo run always leaves the duel
    // feature T20: {daily:true} runs the day challenge — the modifier
    // flag lives in CS.Daily from here until the run ends (death or
    // leaving to the menu); every other start is a normal run
    const daily = !!(opts && opts.daily);
    if (daily) CS.Daily.start();
    else CS.Daily.stop();
    applyGridChange(); // feature T13: the field follows the current screen
    hideScoreSave();   // feature T10: a fresh run drops the save block
    CS.Ach.resetRun(); // feature T16: per-run achievement counters
    // feature T21: count the run; the tutorial window is the first
    // TUT_RUNS ones and every queued hint dies with the run
    bumpRuns();
    tutTimers = [];
    tutLifeShown = false;
    tutDangerShown = false;
    if (runs === 1) {
      // the very first run opens with the controls + food hints
      queueTut(tr(IS_TOUCH ? 'tutMoveTouch' : 'tutMove'), TUT_MOVE_DELAY);
      queueTut(tr('tutFood'), TUT_MOVE_DELAY + TUT_FOOD_DELAY);
    }
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
    escaped = [];      // feature T11
    bank = null;       // feature T11
    scheduleBankTimer();
    lives = upgVal('life', 0); // feature T19: bought start lives (0..3)
    respawnTimer = 0;
    invulnTimer = 0;
    pickupTimer = pickupInterval();
    applySpeed();
    updateLivesHud();
    renderEffectsHud();
    state = 'playing';
    CS.UI.hud({ score: 0, best: best, level: 1 });
    CS.UI.bossBar(0, 0, false);
    CS.UI.banner(null, false);
    CS.UI.show('game');
    CS.UI.toast(tr('toastConnect'));
    // feature T20: announce the day modifier (overrules the toast)
    if (daily) CS.UI.toast(tr(CS.Daily.today().descKey));
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
    stopDuelIfActive(); // feature T23: leaving through the menu ends the duel
    // feature T24 (SPEC §22): the menu also drops the duel room and
    // resets the lobby — every path out of a duel cleans the channel
    if (CS.Net && typeof CS.Net.leave === 'function') CS.Net.leave();
    if (CS.DuelUI && typeof CS.DuelUI.reset === 'function') CS.DuelUI.reset();
    state = 'menu';
    fight = null;
    pendingBoss = 0;
    bonus = null;
    pickups = [];      // feature T8
    effects = [];
    debris = [];       // feature T9
    escaped = [];      // feature T11
    bank = null;       // feature T11
    tutTimers = [];    // feature T21: leftover hints die with the run
    CS.Daily.stop();   // feature T20: leaving the field ends the challenge
    invulnTimer = 0;
    applySpeed();      // drop surge/slow multipliers from stepInterval
    renderEffectsHud();
    CS.UI.bossBar(0, 0, false);
    CS.UI.banner(null, false);
    CS.UI.hud({ best: best });
    CS.UI.show('menu');
    updateDailyLine(); // feature T20: the modifier name / day best may have changed
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

  /* feature T20: "ЧЕЛЛЕНДЖ ДНЯ: <название> · Сегодня: N" under the
     menu buttons — rebuilt on every menu visit, language switch and
     after a challenge run (the day best may have moved) */
  function updateDailyLine() {
    const el = document.getElementById('daily-line');
    if (!el || !CS.Daily || typeof CS.Daily.today !== 'function') return;
    const info = CS.Daily.today();
    el.textContent = tr('daily').toUpperCase() + ': ' + tr(info.nameKey) +
      ' · ' + tr('dailyBest', CS.Daily.best());
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
    // feature T11: 'reverse' inverts the incoming vector only — the
    // buffer rules, the reversal ban and the magnet autopilot are
    // untouched (the magnet is not a direction); feature T20: the
    // daily 'mirror' holds the same inversion for the whole run (both
    // at once simply cancel out)
    if (hasEffect('reverse') !== dailyOn('mirror')) d = { x: -d.x, y: -d.y };
    // not-yet-applied turns on the same axis are stale: the fresh press
    // replaces them (spamming the D-pad never queues up a delayed turn)
    while (dirQueue.length) {
      const q = dirQueue[dirQueue.length - 1];
      const sameAxis = (d.y === 0) === (q.y === 0);
      if (sameAxis) dirQueue.pop();
      else break;
    }
    const last = dirQueue.length ? dirQueue[dirQueue.length - 1] : dir;
    if (d.x === last.x && d.y === last.y) return;      // repeat
    if (d.x === -last.x && d.y === -last.y) return;    // 180-degree reversal
    if (dirQueue.length >= INPUT_BUFFER) return;
    dirQueue.push(d);
  }

  /* feature T23: direction input goes either to the solo queue or
     to the live duel (CS.Duel validates/buffers it on its side) */
  function steer(d) {
    if (state === 'duel') {
      if (CS.Duel && CS.Duel.active()) CS.Duel.input(d);
      return;
    }
    queueDir(d);
  }

  function onKeyDown(e) {
    firstGesture();
    // feature T21: a focused INPUT (the menu volume sliders, the name
    // field) keeps its keystrokes — arrows/space steer the widget,
    // not the snake; the page-scroll guard does not apply either
    const target = e.target;
    if (target && target.tagName === 'INPUT') return;
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
      steer(d); // feature T23: duel input branches here
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
    if (adx > ady) steer(dx > 0 ? DIR.right : DIR.left); // feature T23: duel too
    else steer(dy > 0 ? DIR.down : DIR.up);
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

    /* feature T23: the duel owns the world in this state — the solo
       state machine below stays completely untouched */
    if (state === 'duel') {
      if (CS.Duel && CS.Duel.active()) CS.Duel.update(dt);
      return;
    }

    if (state === 'playing' || state === 'boss' || state === 'respawning') {
      // feature T21: tutorial toasts tick in game time (a pause holds them)
      for (let i = tutTimers.length - 1; i >= 0; i--) {
        tutTimers[i].t -= dt;
        if (tutTimers[i].t <= 0) {
          CS.UI.toast(tutTimers[i].text);
          tutTimers.splice(i, 1);
        }
      }

      if (bonus) {
        bonus.timer -= dt;
        if (bonus.timer <= 0) bonus = null;
      }
      updatePickups(dt);   // feature T8
      updateEffects(dt);   // feature T8
      updateDebris(dt);    // feature T9
      updateEscaped(dt);   // feature T11
      updateBank(dt);      // feature T11

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
    /* feature T23: the duel paints its own arena on the same canvas;
       the FX layer stays on top of it like everywhere else */
    if (state === 'duel') {
      if (CS.Duel && CS.Duel.active()) CS.Duel.draw(g);
      CS.FX.draw(g);
      return;
    }
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
      drawEscaped(); // feature T11
      drawBank();    // feature T11
      if (fight && fight.active) fight.draw(g, CELL); // draws its charges itself
      drawSnake();
    }
    drawDarkMask(); // feature T20: the 'dark' vignette over the scene
    CS.FX.draw(g);
    drawDmgPops();
  }

  /* feature T20: the daily 'dark' modifier — a radial mask centered
     on the interpolated head: fully transparent within DAILY_DARK_R0
     cells, almost black by DAILY_DARK_R1; the canvas extends the last
     color stop, so everything farther away stays dark. A missing head
     (the respawn reboot) simply skips the mask for a moment. */
  function drawDarkMask() {
    if (!dailyOn('dark') || !snake.length) return;
    const head = snake[0];
    const t = (state === 'playing' || state === 'boss' || state === 'paused')
      ? Math.min(1, stepTimer / stepInterval)
      : 1; // dying / gameover: freeze at the current cells
    const hx = (head.prev.x + (head.curr.x - head.prev.x) * t) * CELL + CELL / 2;
    const hy = (head.prev.y + (head.curr.y - head.prev.y) * t) * CELL + CELL / 2;
    const grad = g.createRadialGradient(
      hx, hy, DAILY_DARK_R0 * CELL,
      hx, hy, DAILY_DARK_R1 * CELL
    );
    grad.addColorStop(0, 'rgba(4,5,12,0)');
    grad.addColorStop(1, 'rgba(4,5,12,0.96)');
    g.save();
    g.fillStyle = grad;
    g.fillRect(0, 0, GRID_W * CELL, GRID_H * CELL);
    g.restore();
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

  /* ---------- PERF: baked arena background ----------
     The grid (50+ strokes) and the neon accent frame used to be
     redrawn with shadowBlur every frame. The whole background is
     now baked once into an offscreen canvas at device resolution
     and blitted with a single drawImage. The cache is invalidated
     by signature: any change of the grid, the devicePixelRatio or
     the level accent (once per level) re-bakes it — cheap. */
  let bgCache = null;               // offscreen grid + accent frame
  let bgCacheKey = '';              // GRID_W|GRID_H|dpr|accent signature

  function drawGrid() {
    const W = GRID_W * CELL;
    const H = GRID_H * CELL;
    // neon arena frame in the level accent color (palette cycle)
    const accent = PALETTE[(level - 1) % PALETTE.length];
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const sig = GRID_W + '|' + GRID_H + '|' + dpr + '|' + accent;
    if (sig !== bgCacheKey) {
      bgCache = null;
      bgCacheKey = '';
      if (typeof document !== 'undefined' && document.createElement) {
        const cv = document.createElement('canvas');
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
        const c = cv.getContext('2d');
        if (c) {
          c.setTransform(dpr, 0, 0, dpr, 0, 0);
          c.strokeStyle = GRID_LINE;
          c.lineWidth = 1;
          c.beginPath();
          for (let x = 1; x < GRID_W; x++) {
            c.moveTo(x * CELL + 0.5, 0);
            c.lineTo(x * CELL + 0.5, H);
          }
          for (let y = 1; y < GRID_H; y++) {
            c.moveTo(0, y * CELL + 0.5);
            c.lineTo(W, y * CELL + 0.5);
          }
          c.stroke();
          c.save();
          c.strokeStyle = accent;
          c.lineWidth = 2;
          c.shadowColor = accent;
          c.shadowBlur = 14;
          c.strokeRect(1, 1, W - 2, H - 2);
          c.restore();
          bgCache = cv;
          bgCacheKey = sig;
        }
      }
    }
    if (bgCache) {
      // full-source blit into W x H logical px == 1:1 device pixels
      g.drawImage(bgCache, 0, 0, W, H);
      return;
    }
    // canvasless fallback: the original direct strokes
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
    // PERF: the pulsing glow is a baked sprite stretched over the
    // old 8+10*pulse blur envelope (no shadowBlur in this frame)
    const b = 8 + 10 * pulse;
    const gw = 2 * (s / 2 + 1.6 * b);
    CS.FX.drawGlow(g, cx, cy, gw, gw, '#ff2bd6', 13);
    g.save();
    g.translate(cx, cy);
    g.rotate(Math.PI / 4);
    g.fillStyle = '#ff2bd6';
    roundRect(g, -s / 2, -s / 2, s, s, 3);
    g.fill();
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
    // PERF: baked glow sprite instead of a per-frame shadowBlur
    CS.FX.drawGlow(g, cx + bob, cy, 2 * (10 + 1.6 * 10), 2 * (7 + 1.6 * 10), '#ffe600', 10);
    g.save();
    g.translate(cx + bob, cy);
    g.strokeStyle = '#ffe600';
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

  /* feature T11: a pulsating frame cube with a bold '?' — the content
     is unknown until the pickup; the glow blinks cyan <-> magenta */
  function drawMysteryShape(s, color) {
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.strokeRect(-s / 2, -s / 2, s, s);
    g.shadowBlur = 0; // the '?' stays crisp inside the glowing frame
    g.fillStyle = color;
    g.font = 'bold ' + Math.round(s * 0.72) + 'px "Cascadia Mono", Consolas, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('?', 0, s * 0.06);
  }

  function drawPickups() {
    for (let i = 0; i < pickups.length; i++) {
      const p = pickups[i];
      if (p.timer <= PICKUP_BLINK && Math.floor(animTime * 8) % 2 === 0) continue;
      const cx = p.x * CELL + CELL / 2;
      const cy = p.y * CELL + CELL / 2;
      const pulse = 0.5 + 0.5 * Math.sin(animTime * 5 + i * 1.7);
      const s = CELL * 0.7 * (0.92 + 0.08 * pulse); // light pulsation
      /* PERF: the mystery color keeps flowing cyan <-> magenta, but
         quantized to 1/8 steps so the glow sprite cache stays small */
      const color = p.type === 'life' ? '#ff2d55'
        : p.type === 'surge' ? '#ffe600'
        : p.type === 'magnet' ? '#00f0ff'
        : p.type === 'slow' ? '#7de3ff'
        : p.type === 'virus' ? '#ff7a00'
        : p.type === 'mystery' ? mixRgb([0, 240, 255], [255, 43, 214], // feature T11
            Math.round((0.5 + 0.5 * Math.sin(animTime * 4 + i * 1.7)) * 8) / 8)
        : '#ffe600';
      // PERF: glow like the food, but baked + stretched, no shadowBlur
      const b = 8 + 10 * pulse;
      const gw = 2 * (s / 2 + 1.6 * b);
      CS.FX.drawGlow(g, cx, cy, gw, gw, color, 13);
      g.save();
      g.translate(cx, cy);
      g.fillStyle = color;
      if (p.type === 'life') drawHeartShape(s);
      else if (p.type === 'surge') drawBoltShape(s);
      else if (p.type === 'magnet') drawMagnetShape(s);
      else if (p.type === 'slow') drawSnowflakeShape(s);
      else if (p.type === 'virus') drawSkullShape(s);
      else if (p.type === 'mystery') drawMysteryShape(s, color); // feature T11
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
      // PERF: baked glow sprite replaces the per-frame shadowBlur
      const b = 6 + 10 * pulse;
      const gw = 2 * ((CELL - 8) / 2 + 1.6 * b);
      CS.FX.drawGlow(g, x + CELL / 2, y + CELL / 2, gw, gw, '#00f0ff', 11);
      g.fillStyle = 'rgba(0,240,255,' + (0.3 + 0.4 * pulse).toFixed(3) + ')';
      roundRect(g, x + 4, y + 4, CELL - 8, CELL - 8, 4);
      g.fill();
      g.strokeStyle = '#bffcff';
      g.lineWidth = 1.5;
      g.strokeRect(x + 7.5, y + 7.5, CELL - 15, CELL - 15);
      g.restore();
    }
  }

  /* feature T11: escaped cores — frantic purple spheres with a panic
     jitter, blinking away during the last two seconds */
  function drawEscaped() {
    for (let i = 0; i < escaped.length; i++) {
      const c = escaped[i];
      if (c.t <= ESCAPED_BLINK && Math.floor(animTime * 8) % 2 === 0) continue;
      const jx = (Math.random() - 0.5) * 5; // panic jitter
      const jy = (Math.random() - 0.5) * 5;
      const pulse = 0.5 + 0.5 * Math.sin(animTime * 10 + i * 2.3);
      const px = c.x * CELL + CELL / 2 + jx;
      const py = c.y * CELL + CELL / 2 + jy;
      const r = CELL * 0.26 + pulse * 2.5;
      g.save();
      g.translate(px, py);
      // PERF: baked glow sprite replaces the per-frame shadowBlur
      const b = 8 + 12 * pulse;
      const gw = 2 * (r + 1.6 * b);
      CS.FX.drawGlow(g, 0, 0, gw, gw, '#ff2bd6', 14);
      g.fillStyle = 'rgba(255,43,214,' + (0.55 + 0.4 * pulse).toFixed(3) + ')';
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffd7f6'; // inner glint
      g.beginPath();
      g.arc(-CELL * 0.07, -CELL * 0.07, CELL * 0.07, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }

  /* feature T11: flat-top hexagon path of radius r around (0,0) */
  function hexPath(r) {
    g.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + k * Math.PI / 3;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
  }

  /* feature T11: the tail bank — a hexagon with a double pulsing
     green->cyan frame and a diamond token inside; blinks during the
     last two seconds */
  function drawBank() {
    if (!bank) return;
    if (bank.t <= BANK_BLINK && Math.floor(animTime * 8) % 2 === 0) return;
    const cx = bank.x * CELL + CELL / 2;
    const cy = bank.y * CELL + CELL / 2;
    /* green <-> cyan, quantized to 1/8 steps so the glow sprite cache
       stays small (PERF: the glow itself is a baked sprite) */
    const k = Math.round((0.5 + 0.5 * Math.sin(animTime * 2.6)) * 8) / 8;
    const pulse = 0.5 + 0.5 * Math.sin(animTime * 5);  // frame pulsation
    const color = mixRgb([0, 255, 157], [0, 240, 255], k);
    g.save();
    g.translate(cx, cy);
    const b = 8 + 10 * pulse;
    const gw = 2 * (CELL * 0.46 + 1.6 * b);
    CS.FX.drawGlow(g, 0, 0, gw, gw, color, 13);
    g.strokeStyle = color;
    g.lineWidth = 2.5;
    hexPath(CELL * 0.46);
    g.stroke();
    g.lineWidth = 1.5;
    hexPath(CELL * (0.3 + 0.05 * pulse)); // the inner ring breathes
    g.stroke();
    g.fillStyle = color;
    g.beginPath(); // the deposit diamond token
    g.moveTo(0, -CELL * 0.16);
    g.lineTo(CELL * 0.11, 0);
    g.lineTo(0, CELL * 0.16);
    g.lineTo(-CELL * 0.11, 0);
    g.closePath();
    g.fill();
    g.fillStyle = BG; // a dark slot across the diamond
    g.fillRect(-CELL * 0.015, -CELL * 0.1, CELL * 0.03, CELL * 0.2);
    g.restore();
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
    const skinAlpha = CS.Skins.alpha(); // feature T17: ghost transparency
    const pad = isHead ? CELL * 0.06 : CELL * 0.07; // ~0.86..0.88 of a cell
    g.save();
    g.fillStyle = color;
    if (invulnTimer > 0) {
      // feature T8: the respawn shield blinks the whole snake
      g.globalAlpha = Math.max(0.08, 0.35 + 0.65 * Math.sin(animTime * 12));
    } else if (skinAlpha < 1) {
      g.globalAlpha = skinAlpha; // feature T17: the ghost skin
    }
    if (isHead) {
      // feature T17: the head glow follows the active skin (rainbow flows)
      g.shadowColor = CS.Skins.headGlow(animTime);
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

  /* ---------- feature T13: adaptive arena ---------- */

  /* The arena keeps the classic ~600-cell density but takes its
     proportions from the screen: desktop / landscape clamps the aspect
     at 1.5, which yields exactly the canonical 30x20; portrait and
     intermediate screens get their own field. */
  function computeGrid() {
    const portrait = window.innerHeight > window.innerWidth * 1.15;
    const reserve = portrait ? 360 : 90; // hud+dpad in portrait, hud in landscape
    const availH = Math.max(200, window.innerHeight - reserve);
    const aspect = Math.max(0.55, Math.min(1.5, window.innerWidth / availH));
    const CELLS = 600;
    let w = Math.round(Math.sqrt(CELLS * aspect));
    let h = Math.round(Math.sqrt(CELLS / aspect));
    w = Math.max(14, Math.min(38, w));
    h = Math.max(14, Math.min(38, h));
    return { w: w, h: h };
  }

  /* Recompute the grid; true only when the values actually changed */
  function applyGrid() {
    const next = computeGrid();
    if (next.w === GRID_W && next.h === GRID_H) return false;
    GRID_W = next.w;
    GRID_H = next.h;
    return true;
  }

  /* ---------- feature T23 (SPEC §22): the duel arena ---------- */

  /* The duel field keeps the computeGrid proportions but doubles
     the area (~42x28 on desktop, ~x1.6 on phones): the same aspect
     clamp and screen reserve, CELLS = 1200 instead of 600. */
  function computeDuelGrid() {
    const portrait = window.innerHeight > window.innerWidth * 1.15;
    const reserve = portrait ? 360 : 90;
    const availH = Math.max(200, window.innerHeight - reserve);
    const aspect = Math.max(0.55, Math.min(1.5, window.innerWidth / availH));
    const CELLS = 1200;
    let w = Math.round(Math.sqrt(CELLS * aspect));
    let h = Math.round(Math.sqrt(CELLS / aspect));
    w = Math.max(18, Math.min(46, w));
    h = Math.max(18, Math.min(46, h));
    return { w: w, h: h };
  }

  /* The duel canvas swap: the same backing-store rules as the solo
     field, applied to the duel dimensions CS.Duel asked for. */
  function resizeDuelCanvas(w, h) {
    if (!canvas || !g) return;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    CS.FX.setSize(w, h);
    cssVars(w / CELL, h / CELL);
  }

  /* Leaving a duel: force the solo canvas back — GRID_W/GRID_H did
     not change, so applyGridChange() alone would be a no-op here */
  function restoreSoloCanvas() {
    resizeCanvas();
    CS.FX.setSize(GRID_W * CELL, GRID_H * CELL);
    cssVars();
  }

  /* Canvas backing store for the current grid. HiDPI: the backstore is
     scaled by devicePixelRatio, all modules keep drawing in logical
     GRID_W*CELL x GRID_H*CELL coordinates via setTransform */
  function resizeCanvas() {
    if (!canvas || !g) return;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(GRID_W * CELL * dpr);
    canvas.height = Math.round(GRID_H * CELL * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* The stage ratio follows the live grid (css sizes .layout/.stage);
     feature T23: the duel passes its own dimensions while it owns
     the canvas, every other caller keeps the solo grid */
  function cssVars(w, h) {
    if (!document.documentElement || !document.documentElement.style) return;
    const fw = Number.isFinite(w) ? w : GRID_W;
    const fh = Number.isFinite(h) ? h : GRID_H;
    document.documentElement.style.setProperty('--field-ratio', fw + ' / ' + fh);
    document.documentElement.style.setProperty('--field-aspect', String(fw / fh));
  }

  /* One grid change = canvas + fx + css all in sync */
  function applyGridChange() {
    if (!applyGrid()) return false;
    resizeCanvas();
    CS.FX.setSize(GRID_W * CELL, GRID_H * CELL);
    cssVars();
    return true;
  }

  /* Orientation flips wait for the resize storm to settle; the grid
     never changes mid-run — the next startGame picks it up */
  let resizeDebounce = 0;
  function onWindowResize() {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(function () {
      if (state !== 'menu' && state !== 'gameover' && state !== 'lang') return;
      applyGridChange();
    }, 300);
  }

  /* ---------- boot ---------- */

  function boot() {
    if (running) return;
    running = true;

    // feature T15: Telegram Mini App bootstrap (ready + expand + the
    // 'in-telegram' body tag) lives in CS.TG; outside Telegram no-op
    CS.TG.init();

    canvas = document.getElementById('game-canvas');
    if (canvas) {
      g = canvas.getContext('2d');
      canvas.addEventListener('touchstart', onTouchStart, { passive: false });
      canvas.addEventListener('touchend', onTouchEnd, { passive: false });
      canvas.addEventListener('click', onCanvasClick);
    }

    // feature T13: grid, canvas, fx and css sizing for this screen
    applyGrid();
    resizeCanvas();
    CS.FX.setSize(GRID_W * CELL, GRID_H * CELL);
    cssVars();
    window.addEventListener('resize', onWindowResize);

    // feature T23 (SPEC §22): duel core injection — the arena size
    // provider (x2 area) and the canvas swap hook; without js/duel.js
    // everything below runs exactly as before
    if (CS.Duel && typeof CS.Duel.init === 'function') {
      CS.Duel.init({
        cell: CELL,
        grid: computeDuelGrid,
        hooks: { resize: resizeDuelCanvas }
      });
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

    // feature T20: the daily challenge button in the menu — a run
    // under the day modifier (startGame hides the menu itself, the
    // same way every other start does)
    const dailyBtn = document.getElementById('btn-daily');
    if (dailyBtn) {
      dailyBtn.addEventListener('click', function () {
        startGame({ daily: true });
      });
    }

    // feature T15: the gameover 📤 share button (Telegram only, .tg-only)
    const shareBtn = document.getElementById('btn-share');
    if (shareBtn) {
      shareBtn.addEventListener('click', function () {
        CS.TG.shareScore(score);
      });
    }

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
        updateDailyLine(); // feature T20: the line is bilingual
      });
    }

    updateMuteButton(CS.Audio.getMuted());
    updateDailyLine(); // feature T20: the day challenge line
    CS.UI.hud({ score: 0, best: best, level: 1 });
    // feature T7 v2: the picker only shows on the very first visit; repeat
    // players go straight to the menu (the 🌐 button re-opens the picker)
    let savedLang = false;
    try {
      savedLang = !!window.localStorage.getItem('cs_lang');
    } catch (e) {
      /* storage unavailable — show the picker */
    }
    CS.UI.show(savedLang ? 'menu' : 'lang');
    state = 'menu';
    // feature T24 (SPEC §22): a room-XXXX Telegram deep link opens the
    // duel lobby (the code pre-filled + an auto-join) instead of the
    // language picker — the rival is already waiting in that room
    if (CS.DuelUI && typeof CS.DuelUI.bootDeepLink === 'function') {
      CS.DuelUI.bootDeepLink();
    }
    CS.Audio.music('menu'); // silently ignored until the first gesture

    lastTs = 0;
    requestAnimationFrame(frame);
  }

  /* ---------- deterministic QA hooks: active only with ?debug=1 ---------- */

  const DEBUG = (function () {
    try { return /(^|[?&])debug=1/.test(window.location.search); } catch (e) { return false; }
  })();

  if (DEBUG) {
    const cellAhead = function (d) {
      const h = snake[0] && snake[0].curr;
      if (!h) return null;
      const x = Math.max(0, Math.min(GRID_W - 1, h.x + dir.x * (d || 2)));
      const y = Math.max(0, Math.min(GRID_H - 1, h.y + dir.y * (d || 2)));
      return { x: x, y: y };
    };
    CS.Debug = {
      /* full state snapshot for the QA panel */
      state: function () {
        return {
          state: state, score: score, level: level, lives: lives,
          len: snake.length,
          head: snake.length ? snake[0].curr.x + ',' + snake[0].curr.y : null,
          effects: effects.map(function (e) { return e.type + ':' + Math.ceil(e.timer); }),
          pickups: pickups.map(function (p) { return p.type; }),
          bank: bank ? bank.x + ',' + bank.y : null,
          boss: fight && fight.active ? fight.name + ' hp' + fight.hp : null,
          escaped: escaped.length
        };
      },
      /* PERF QA: the baked arena background signature — changes when
         the grid / dpr / level accent re-bakes the cache */
      bgInfo: function () {
        return bgCacheKey;
      },
      feed: function () { const c = cellAhead(2); if (c) food = { x: c.x, y: c.y }; },
      grow: function (n) { growth += n || 5; },
      setScore: function (n) { score = n || 0; CS.UI.hud({ score: score }); },
      spawnPickup: function (type) {
        const c = cellAhead(2);
        if (c) pickups.push({ x: c.x, y: c.y, type: type, timer: PICKUP_LIFE });
      },
      spawnBank: function () {
        const c = cellAhead(2);
        if (c) { bank = { x: c.x, y: c.y, t: 10 }; bankTimer = 30; }
      },
      forceMystery: function (kind) {
        if (!snake.length) return;
        applyMystery(snake[0].curr.x * CELL + CELL / 2, snake[0].curr.y * CELL + CELL / 2, kind);
      },
      spawnBoss: function (idx) {
        if (state === 'playing' || state === 'boss') startBoss(idx || 1);
      },
      clear: function () {
        pickups = []; bank = null; escaped = []; effects = [];
        applySpeed();
      }
    };
  }

  /* feature T23 (SPEC §22): the duel entries the T24 ui calls */
  CS.Game = { boot: boot, startDuel: startDuel, endDuel: endDuel };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
