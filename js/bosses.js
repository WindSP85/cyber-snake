/* ============================================================
   NEON://SNAKE — boss fight system (SPEC §4, §6, §7, §12)
   CS.BossFight: 2x2-cell boss, laser / firewall / dash attacks,
   data charges, HP, smooth cell-based movement, canvas render.
   Feature T9 adds boss types 4-8 (SPEC §12): decompiler beam
   (onCut), hunter turret (projectiles + mines), the devourer
   (chases the head, bites the tail — onTailBite), cryogen
   (freeze wave — onFreeze) and sys admin (laser + snipe + drones).
   No dependencies beyond the events callbacks.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  /* ---------- tuning (seconds unless noted) ---------- */
  const INTRO_TIME      = 2.0;   // boss descends, no attacks yet
  const LASER_TELEGRAPH = 0.9;
  const LASER_ACTIVE    = 0.5;
  const FIREWALL_WARM   = 0.6;   // blocks blink, not lethal yet
  const FIREWALL_FLARE  = 0.2;   // ignition flare, already lethal
  const FIREWALL_CAP    = 18;    // max blocks on the field at once
  const DASH_TELEGRAPH  = 0.9;
  const DASH_SPEED      = 12;    // cells per second
  const MOVE_INTERVAL   = 1.2;   // idle: pick a neighbour cell
  const MOVE_DURATION   = 0.4;   // one-cell visual slide
  const CHARGE_RESPAWN  = 2.2;
  const MIN_PAUSE       = 1.6;

  /* feature T9 (SPEC §12): tuning for boss types 4-8 */
  const RIPPER_TELEGRAPH = 1.0;  // type 4: beam warning, sfx laser_charge
  const RIPPER_ACTIVE    = 0.6;  // type 4: the beam burns across the arena
  const SNIPER_TELEGRAPH = 0.7;  // type 5/8: aim line before the burst
  const SHOT_SPEED       = 9;    // cells per second
  const SHOT_INTERVAL    = 0.25; // burst cadence, seconds
  const MINE_ARM         = 0.8;  // blinking, not lethal yet
  const MINE_LIFE        = 6.8;  // total lifetime: arm + 6 s lethal
  const MINE_CAP         = 9;    // max mines on the field at once
  const FREEZE_EVERY     = 6;    // type 7: wave cadence
  const FREEZE_DUR       = 3;    // seconds handed to the game via onFreeze
  const FREEZE_TELEGRAPH = 1.0;  // blue flash before the wave
  const FREEZE_WAVE_TIME = 0.7;  // visual ring expansion, seconds
  const DRONE_EVERY      = 8;    // type 8: drone pair cadence
  const DRONE_LIFE       = 7;
  const DRONE_SPEED      = 2.5;  // cells per second
  const CHASE_STEP       = 0.45; // type 6: step cadence toward the head
  const BITE_COOLDOWN    = 1.2;  // type 6: min seconds between bites
  const CHEW_TIME        = 0.5;  // type 6: "chewing" pause after a bite
  const TURRET_MOVE      = 2.6;  // type 5: lazy drift along the edges

  /* ---------- small helpers ---------- */
  function key(x, y) { return x + ',' + y; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function randInt(n) { return Math.floor(Math.random() * n); }
  function manhattan(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); }

  /* i18n translate — boss names live in the dictionary (js/i18n.js) */
  function tr(key, arg) {
    return CS.I18N && CS.I18N.t ? CS.I18N.t(key, arg) : key;
  }

  /* feature T9 (SPEC §12): type = ((idx-1) mod 8)+1; repeats past the
     first cycle earn an ' mk.N' suffix */
  function bossTypeOf(bossIndex) {
    return ((bossIndex - 1) % 8) + 1;
  }

  function bossName(bossIndex) {
    const type = bossTypeOf(bossIndex);
    const cycle = Math.floor((bossIndex - 1) / 8);
    let name = tr('boss' + type);
    if (cycle > 0) name += ' mk.' + cycle;
    return name;
  }

  function roundRectPath(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* diagonal "construction tape" stripes inside a band, running with time */
  function hatchBand(g, x, y, w, h, time, color, spacing, speed) {
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.strokeStyle = color;
    g.lineWidth = 3;
    const off = (time * speed) % spacing;
    for (let s = -h - spacing; s < w + h; s += spacing) {
      g.beginPath();
      g.moveTo(x + s + off, y + h + 2);
      g.lineTo(x + s + off + h, y - 2);
      g.stroke();
    }
    g.restore();
  }

  /* ---------- BossFight ---------- */
  class BossFight {
    constructor(bossIndex, gridW, gridH, events) {
      this.bossIndex = Math.max(1, bossIndex || 1);
      this.gridW = gridW || 30;
      this.gridH = gridH || 20;
      this.events = events || {};

      // feature T9 (SPEC §12): type cycles over 8 kits, HP is capped at 10
      this.bossType = bossTypeOf(this.bossIndex);
      this.bossCycle = Math.floor((this.bossIndex - 1) / 8);
      this.maxHp = Math.min(10, 3 + this.bossIndex);
      this.hp = this.maxHp;
      this.name = bossName(this.bossIndex); // frozen at construction time

      this.active = true;
      this.phase = 'intro';   // 'intro' | 'idle' | 'telegraph' | 'attack' | 'dead'
      this.time = 0;

      // intro: boss visually descends, body is already lethal
      this.introTimer = INTRO_TIME;

      // body: logical top-left anchor of a 2x2 block of cells
      this.x = clamp(Math.round(this.gridW / 2) - 1, 0, this.gridW - 2);
      this.y = clamp(1, 0, this.gridH - 2);
      this.moveFrom = { x: this.x, y: this.y };
      this.moveTo = { x: this.x, y: this.y };
      this.moveT = 1;             // 0..1 progress of the current slide
      this.moveTimer = MOVE_INTERVAL;

      // attack cycle
      this.cooldown = 0;
      this.lastAttack = null;
      this.attackKind = null;     // 'laser' | 'firewall' | 'dash'
      this.telegraphTimer = 0;
      this.attackTimer = 0;
      this.laser = null;          // { axis: 'row' | 'col', index } — fixed at telegraph start
      this.firewalls = [];        // { x, y, warm }
      this.dashDir = 0;
      this.dashX = this.x;

      // data charge: always exactly 1 on the field (respawn gap aside)
      this.charge = null;
      this.chargeRespawn = 0;
      this.chargeRetry = 0;

      // last known snake state (aiming / placement checks)
      this.head = null;
      this.snakeKeys = new Set();
      this.snakeCells = [];        // raw array copy, cut scan / bite checks

      // feature T9: type-specific attack state
      this.ripper = null;          // type 4: {axis,index} — non-lethal, cuts
      this.snipe = null;           // type 5/8: {tx,ty} locked aim cell
      this.shotsLeft = 0;
      this.shotTimer = 0;
      this.projectiles = [];       // {x,y,vx,vy} — flying 1x1 bolts
      this.mines = [];             // {x,y,t} — arm 0.8 s, lethal 6 s, gone at 6.8
      this.drones = [];            // {x,y,vx,vy,life} — homing 1x1
      this.freezeTimer = FREEZE_EVERY;  // type 7 cadence
      this.freezeWave = 0;         // 1 -> 0 expanding ring, pure visual
      this.droneTimer = DRONE_EVERY;    // type 8 cadence
      this.chaseTimer = 0;         // type 6 step clock
      this.biteCooldown = 0;       // type 6: rate limit for onTailBite
      this.chewTimer = 0;          // type 6: munching pause after a bite

      this.emit('onWarn', tr('bossWarn') + this.name);
      this.emit('onSfx', 'warn');
    }

    /* ---------- events (never throw into the game loop) ---------- */
    emit(name, arg) {
      const fn = this.events && this.events[name];
      if (typeof fn !== 'function') return;
      try { fn(arg); } catch (e) { /* a broken listener must not break the fight */ }
    }

    /* ============================================================
       UPDATE — main state machine
       ============================================================ */
    update(dt, snakeCells) {
      if (!this.active || this.phase === 'dead') return;
      this.time += dt;

      const cells = Array.isArray(snakeCells) ? snakeCells : [];
      this.snakeCells = cells;
      this.snakeKeys = new Set();
      for (let i = 0; i < cells.length; i++) {
        this.snakeKeys.add(key(cells[i].x, cells[i].y));
      }
      if (cells.length) this.head = { x: cells[0].x, y: cells[0].y };

      this.updateCharge(dt);

      if (this.phase === 'intro') {
        this.introTimer -= dt;
        if (this.introTimer <= 0) {
          this.phase = 'idle';
          this.moveTimer = MOVE_INTERVAL;
          this.cooldown = this.pauseDuration();
        }
        return;
      }

      // feature T9: ambient subsystems tick in every live phase
      this.updateProjectiles(dt);
      this.updateMines(dt);
      this.updateDrones(dt);
      if (this.bossType === 7 && this.freezeTimer > 0) this.freezeTimer -= dt;
      if (this.freezeWave > 0) {
        this.freezeWave = Math.max(0, this.freezeWave - dt / FREEZE_WAVE_TIME);
      }
      if (this.biteCooldown > 0) this.biteCooldown -= dt;
      if (this.chewTimer > 0) this.chewTimer -= dt;

      // finish the current one-cell visual slide in any live phase
      if (this.moveT < 1) {
        this.moveT = Math.min(1, this.moveT + dt / MOVE_DURATION);
        if (this.moveT >= 1) {
          this.x = this.moveTo.x;
          this.y = this.moveTo.y;
          this.moveFrom.x = this.x; this.moveFrom.y = this.y;
        }
      }

      if (this.bossType === 6) {
        this.updateChase(dt);       // the devourer hunts instead of attacking
      } else if (this.phase === 'idle') {
        if (this.bossType === 5) this.updateTurretDrift(dt);
        else this.updateIdleMove(dt);
        this.cooldown -= dt;
        if (this.bossType === 7 && this.freezeTimer <= 0 && this.moveT >= 1) {
          this.startFreeze();       // the cryogen wave ignores the cooldown
        } else if (this.cooldown <= 0 && this.moveT >= 1) {
          this.chooseAttack();
        }
      } else if (this.phase === 'telegraph') {
        this.telegraphTimer -= dt;
        if (this.telegraphTimer <= 0) this.launchAttack();
      } else if (this.phase === 'attack') {
        if (this.attackKind === 'dash') {
          this.updateDash(dt);
        } else if (this.attackKind === 'snipe') {
          this.updateSnipe(dt);
        } else {
          this.attackTimer -= dt;
          if (this.attackTimer <= 0) this.endAttack();
        }
      }
    }

    pauseDuration() {
      const base = Math.max(MIN_PAUSE, 2.5 - 0.15 * this.bossIndex);
      // type 7 shoots its lasers noticeably more often (SPEC §12)
      return this.bossType === 7 ? Math.max(0.9, base * 0.55) : base;
    }

    /* ---------- idle drift: one-cell steps, never onto the snake ---------- */
    updateIdleMove(dt) {
      if (this.moveT < 1) return; // still sliding
      this.moveTimer -= dt;
      if (this.moveTimer > 0) return;
      this.moveTimer = MOVE_INTERVAL * (0.75 + Math.random() * 0.5);
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let i = dirs.length - 1; i > 0; i--) {
        const j = randInt(i + 1);
        const t = dirs[i]; dirs[i] = dirs[j]; dirs[j] = t;
      }
      for (let i = 0; i < dirs.length; i++) {
        if (this.tryStep(dirs[i][0], dirs[i][1])) return;
      }
    }

    tryStep(dx, dy) {
      const nx = this.x + dx;
      const ny = this.y + dy;
      if (nx < 0 || ny < 0 || nx > this.gridW - 2 || ny > this.gridH - 2) return false;
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          const cx = nx + i, cy = ny + j;
          if (this.snakeKeys.has(key(cx, cy))) return false;
          if (this.charge && this.charge.x === cx && this.charge.y === cy) return false;
          for (let m = 0; m < this.mines.length; m++) { // never sit on a mine
            if (this.mines[m].x === cx && this.mines[m].y === cy) return false;
          }
        }
      }
      this.moveFrom.x = this.x; this.moveFrom.y = this.y;
      this.moveTo.x = nx; this.moveTo.y = ny;
      this.moveT = 0;
      return true;
    }

    /* feature T9, type 5: the turret barely moves — a lazy drift that
       hugs the arena border ring (steps still avoid the snake/charge) */
    updateTurretDrift(dt) {
      if (this.moveT < 1) return;
      this.moveTimer -= dt;
      if (this.moveTimer > 0) return;
      this.moveTimer = TURRET_MOVE * (0.8 + Math.random() * 0.4);
      const self = this;
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let i = dirs.length - 1; i > 0; i--) {   // shuffle for random ties
        const j = randInt(i + 1);
        const t = dirs[i]; dirs[i] = dirs[j]; dirs[j] = t;
      }
      const affinity = function (d) {
        const nx = self.x + d[0];
        const ny = self.y + d[1];
        const edge = Math.min(nx, ny, self.gridW - 2 - nx, self.gridH - 2 - ny);
        return edge <= 1 ? 1 : 0;
      };
      dirs.sort(function (a, b) { return affinity(b) - affinity(a); });
      for (let i = 0; i < dirs.length; i++) {
        if (this.tryStep(dirs[i][0], dirs[i][1])) return;
      }
    }

    /* ---------- attack selection ---------- */
    attackPool() {
      switch (this.bossType) {
        case 4: return ['ripper', 'ripper', 'firewall'];   // mostly the beam
        case 5: return ['snipe', 'mines'];
        case 7: return ['laser', 'laser', 'firewall'];     // lasers, but faster
        case 8: return ['laser', 'snipe'];
        default: break;
      }
      const pool = ['laser', 'firewall'];
      if (this.bossType === 2 || this.bossType === 3) pool.push('dash');
      return pool;
    }

    chooseAttack() {
      let pool = this.attackPool();
      if (this.mines.length >= MINE_CAP) {
        pool = pool.filter(function (k) { return k !== 'mines'; });
      }
      if (this.firewalls.length >= FIREWALL_CAP) {
        pool = pool.filter(function (k) { return k !== 'firewall'; }); // cap reached
      }
      if (!pool.length) pool = ['laser'];
      let kind = pool[randInt(pool.length)];
      if (kind === this.lastAttack) {
        const rest = pool.filter(function (k) { return k !== kind; });
        if (rest.length) kind = rest[randInt(rest.length)];
      }
      this.lastAttack = kind;
      this.attackKind = kind;

      if (kind === 'laser') {
        const head = this.head || { x: this.gridW >> 1, y: this.gridH >> 1 };
        const axis = Math.random() < 0.5 ? 'row' : 'col';
        const index = axis === 'row'
          ? clamp(head.y, 0, this.gridH - 1)
          : clamp(head.x, 0, this.gridW - 1);
        this.laser = { axis: axis, index: index }; // locked, no re-aiming
        this.phase = 'telegraph';
        this.telegraphTimer = LASER_TELEGRAPH;
        this.emit('onSfx', 'laser_charge');
      } else if (kind === 'firewall') {
        this.placeFirewalls();
        this.phase = 'telegraph';
        this.telegraphTimer = FIREWALL_WARM;
        this.emit('onSfx', 'warn');
      } else if (kind === 'dash') {
        if (this.moveT < 1) { // snap any residual slide (defensive)
          this.x = this.moveTo.x; this.y = this.moveTo.y;
          this.moveFrom.x = this.x; this.moveFrom.y = this.y;
          this.moveT = 1;
        }
        const spaceLeft = this.x;
        const spaceRight = this.gridW - (this.x + 2);
        this.dashDir = spaceRight > spaceLeft ? 1
          : (spaceLeft > spaceRight ? -1 : (Math.random() < 0.5 ? 1 : -1));
        this.phase = 'telegraph';
        this.telegraphTimer = DASH_TELEGRAPH;
        this.emit('onSfx', 'laser_charge');
      } else if (kind === 'ripper') {
        // feature T9, type 4: a full-arena cutting beam aimed at the head line
        const head = this.head || { x: this.gridW >> 1, y: this.gridH >> 1 };
        const axis = Math.random() < 0.5 ? 'row' : 'col';
        const index = axis === 'row'
          ? clamp(head.y, 0, this.gridH - 1)
          : clamp(head.x, 0, this.gridW - 1);
        this.ripper = { axis: axis, index: index }; // locked at telegraph start
        this.phase = 'telegraph';
        this.telegraphTimer = RIPPER_TELEGRAPH;
        this.emit('onSfx', 'laser_charge');
      } else if (kind === 'snipe') {
        // feature T9, types 5/8: aim at the current head cell, locked
        const head = this.head || { x: this.gridW >> 1, y: this.gridH >> 1 };
        this.snipe = {
          tx: clamp(head.x, 0, this.gridW - 1),
          ty: clamp(head.y, 0, this.gridH - 1)
        };
        this.phase = 'telegraph';
        this.telegraphTimer = SNIPER_TELEGRAPH;
        this.emit('onSfx', 'laser_charge');
      } else if (kind === 'mines') {
        // feature T9, type 5: mines live on their own timers — no phase
        this.placeMines();
        this.emit('onSfx', 'warn');
        this.attackKind = null;
        this.cooldown = this.pauseDuration();
      }
    }

    /* feature T9, type 7: the freeze wave fires off-cooldown */
    startFreeze() {
      this.lastAttack = 'freeze';
      this.attackKind = 'freeze';
      this.phase = 'telegraph';
      this.telegraphTimer = FREEZE_TELEGRAPH;
      this.emit('onSfx', 'laser_charge');
    }

    /* telegraph is over — the attack itself begins */
    launchAttack() {
      if (this.attackKind === 'laser') {
        this.phase = 'attack';
        this.attackTimer = LASER_ACTIVE;
        this.emit('onSfx', 'laser_fire');
      } else if (this.attackKind === 'firewall') {
        for (let i = 0; i < this.firewalls.length; i++) this.firewalls[i].warm = false;
        this.phase = 'attack';
        this.attackTimer = FIREWALL_FLARE;
      } else if (this.attackKind === 'dash') {
        this.dashX = this.x;
        this.phase = 'attack';
      } else if (this.attackKind === 'ripper') {
        // feature T9, type 4: beam ignition + the one-time cut scan
        this.phase = 'attack';
        this.attackTimer = RIPPER_ACTIVE;
        this.emit('onSfx', 'laser_fire');
        this.applyRipperCut();
      } else if (this.attackKind === 'snipe') {
        // feature T9, types 5/8: burst of shots on a fixed cadence
        this.phase = 'attack';
        this.shotsLeft = this.bossType === 8 ? 2 : 3;
        this.shotTimer = 0;
        this.attackTimer = SHOT_INTERVAL * (this.shotsLeft - 1) + 0.2;
      } else if (this.attackKind === 'freeze') {
        // feature T9, type 7: the wave itself — game-side slow + visuals
        this.phase = 'attack';
        this.attackTimer = 0.2;
        this.freezeTimer = FREEZE_EVERY;
        this.freezeWave = 1;
        this.emit('onFreeze', FREEZE_DUR);
        this.emit('onSfx', 'freeze');
      }
    }

    updateDash(dt) {
      this.dashX += this.dashDir * DASH_SPEED * dt;
      if (this.dashDir > 0 && this.dashX >= this.gridW - 2) {
        this.dashX = this.gridW - 2;
        this.endAttack();
      } else if (this.dashDir < 0 && this.dashX <= 0) {
        this.dashX = 0;
        this.endAttack();
      }
    }

    /* ---------- feature T9: projectiles (types 5 / 8) ---------- */

    updateSnipe(dt) {
      this.shotTimer -= dt;
      while (this.shotsLeft > 0 && this.shotTimer <= 0) {
        this.fireProjectile();
        this.shotsLeft--;
        this.shotTimer += SHOT_INTERVAL;
      }
      this.attackTimer -= dt;
      if (this.attackTimer <= 0) this.endAttack();
    }

    fireProjectile() {
      if (!this.snipe) return;
      const ox = this.x + 1;             // boss 2x2 center, cell units
      const oy = this.y + 1;
      let dx = this.snipe.tx + 0.5 - ox;
      let dy = this.snipe.ty + 0.5 - oy;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.001) {
        dx = 1; dy = 0;
      } else {
        dx /= len; dy /= len;
      }
      this.projectiles.push({
        x: ox, y: oy,
        vx: dx * SHOT_SPEED, vy: dy * SHOT_SPEED
      });
      this.emit('onSfx', 'shoot');
    }

    updateProjectiles(dt) {
      for (let i = this.projectiles.length - 1; i >= 0; i--) {
        const p = this.projectiles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < -1 || p.x > this.gridW + 1 || p.y < -1 || p.y > this.gridH + 1) {
          this.projectiles.splice(i, 1); // flew off the field
        }
      }
    }

    /* ---------- feature T9: mines (type 5) ---------- */

    placeMines() {
      const occupied = new Set(this.snakeKeys);
      this.addBodyKeys(occupied, this.x, this.y);
      if (this.moveT < 1) this.addBodyKeys(occupied, this.moveTo.x, this.moveTo.y);
      if (this.charge) occupied.add(key(this.charge.x, this.charge.y));
      for (let i = 0; i < this.firewalls.length; i++) {
        occupied.add(key(this.firewalls[i].x, this.firewalls[i].y));
      }
      for (let i = 0; i < this.mines.length; i++) {
        occupied.add(key(this.mines[i].x, this.mines[i].y));
      }
      const head = this.head;
      const candidates = [];
      for (let cy = 0; cy < this.gridH; cy++) {
        for (let cx = 0; cx < this.gridW; cx++) {
          const k = key(cx, cy);
          if (occupied.has(k)) continue;
          if (head && manhattan(cx, cy, head.x, head.y) < 2) continue;
          candidates.push({ x: cx, y: cy });
        }
      }
      const n = Math.min(3, MINE_CAP - this.mines.length, candidates.length);
      for (let i = 0; i < n; i++) {
        const c = candidates.splice(randInt(candidates.length), 1)[0];
        this.mines.push({ x: c.x, y: c.y, t: MINE_LIFE });
      }
    }

    updateMines(dt) {
      for (let i = this.mines.length - 1; i >= 0; i--) {
        this.mines[i].t -= dt;
        if (this.mines[i].t <= 0) this.mines.splice(i, 1);
      }
    }

    /* ---------- feature T9: drones (type 8) ---------- */

    updateDrones(dt) {
      if (this.bossType === 8) {
        this.droneTimer -= dt;
        if (this.droneTimer <= 0) {
          this.droneTimer = DRONE_EVERY;
          if (this.drones.length <= 1) { // room for the pair
            this.drones.push({
              x: clamp(this.x - 1, 0, this.gridW - 1),
              y: clamp(this.y, 0, this.gridH - 1),
              vx: 0, vy: 0, life: DRONE_LIFE
            });
            this.drones.push({
              x: clamp(this.x + 2, 0, this.gridW - 1),
              y: clamp(this.y + 1, 0, this.gridH - 1),
              vx: 0, vy: 0, life: DRONE_LIFE
            });
            this.emit('onSfx', 'drone');
          }
        }
      }
      const head = this.head;
      for (let i = this.drones.length - 1; i >= 0; i--) {
        const d = this.drones[i];
        d.life -= dt;
        if (d.life <= 0) {
          this.drones.splice(i, 1);
          continue;
        }
        if (head) {
          // smooth homing toward the head cell
          let dx = head.x - d.x;
          let dy = head.y - d.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len > 0.001) {
            d.vx = dx / len * DRONE_SPEED;
            d.vy = dy / len * DRONE_SPEED;
            d.x += d.vx * dt;
            d.y += d.vy * dt;
          } else {
            d.vx = 0; d.vy = 0;
          }
        }
        d.x = clamp(d.x, 0, this.gridW - 1);
        d.y = clamp(d.y, 0, this.gridH - 1);
      }
    }

    /* ---------- feature T9, type 6: chase + tail bite ---------- */

    updateChase(dt) {
      this.checkBite();
      if (this.chewTimer > 0) return;  // busy digesting the last bite
      // the cadence clock runs even mid-slide, so the effective step
      // rate stays one cell per CHASE_STEP seconds
      this.chaseTimer -= dt;
      if (this.chaseTimer > 0) return;
      if (this.moveT < 1) return;      // wait for the slide to land
      this.chaseTimer = CHASE_STEP;
      const head = this.head;
      if (!head) return;
      const dx = head.x - this.x;
      const dy = head.y - this.y;
      const sx = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
      const sy = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
      const xFirst = Math.abs(dx) >= Math.abs(dy);
      const first = xFirst ? [sx, 0] : [0, sy];
      const second = xFirst ? [0, sy] : [sx, 0];
      if ((first[0] || first[1]) && this.chaseStep(first[0], first[1])) return;
      if (second[0] || second[1]) this.chaseStep(second[0], second[1]);
    }

    /* a chase step may run over the snake body (that is the point);
       only the arena bounds and the data charge are respected */
    chaseStep(dx, dy) {
      const nx = clamp(this.x + dx, 0, this.gridW - 2);
      const ny = clamp(this.y + dy, 0, this.gridH - 2);
      if (nx === this.x && ny === this.y) return false;
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) {
          if (this.charge && this.charge.x === nx + i && this.charge.y === ny + j) {
            return false;
          }
        }
      }
      this.moveFrom.x = this.x; this.moveFrom.y = this.y;
      this.moveTo.x = nx; this.moveTo.y = ny;
      this.moveT = 0;
      return true;
    }

    bodyCovers(x, y, ax, ay) {
      return x >= ax && x <= ax + 1 && y >= ay && y <= ay + 1;
    }

    /* overlap of the (possibly sliding) 2x2 footprint with a cell */
    coversCell(x, y) {
      if (this.bodyCovers(x, y, this.x, this.y)) return true;
      return this.moveT < 1 && this.bodyCovers(x, y, this.moveTo.x, this.moveTo.y);
    }

    checkBite() {
      if (this.biteCooldown > 0) return;
      const cells = this.snakeCells;
      if (cells.length < 4) return;
      // the head touching the body is plain death (hazard cells);
      // only mid-body / tail contact (index >= 3) bites
      if (this.head && this.coversCell(this.head.x, this.head.y)) return;
      for (let i = 3; i < cells.length; i++) {
        if (this.coversCell(cells[i].x, cells[i].y)) {
          this.doBite();
          return;
        }
      }
    }

    doBite() {
      this.emit('onTailBite');
      this.biteCooldown = BITE_COOLDOWN;
      this.chewTimer = CHEW_TIME;
      // snap any running slide so the retreat starts from the landed cell
      if (this.moveT < 1) {
        this.x = this.moveTo.x;
        this.y = this.moveTo.y;
      }
      // spit 2 cells back, away from the head
      const head = this.head || { x: this.x, y: this.y - 2 };
      const dx = this.x - head.x;
      const dy = this.y - head.y;
      let bx = 0, by = 0;
      if (Math.abs(dx) >= Math.abs(dy)) bx = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
      else by = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
      if (!bx && !by) by = 1;
      const nx = clamp(this.x + bx * 2, 0, this.gridW - 2);
      const ny = clamp(this.y + by * 2, 0, this.gridH - 2);
      this.moveFrom.x = this.x; this.moveFrom.y = this.y;
      this.moveTo.x = nx; this.moveTo.y = ny;
      this.moveT = 0;                 // the slide IS the chew animation
    }

    /* ---------- feature T9, type 4: the cutting beam ---------- */

    /* one-time scan at beam ignition: the deepest segment on the line
       is cut off; the head on the line is a wound too (cut from 1) */
    applyRipperCut() {
      if (!this.ripper) return;
      const cells = this.snakeCells;
      let maxIdx = -1;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const onLine = this.ripper.axis === 'row'
          ? c.y === this.ripper.index
          : c.x === this.ripper.index;
        if (onLine) maxIdx = i;
      }
      if (maxIdx >= 0) {
        this.emit('onCut', Math.max(maxIdx, 1));
        this.emit('onSfx', 'cut');
      }
    }

    endAttack() {
      if (this.attackKind === 'dash') {
        this.x = Math.round(this.dashX);
        this.moveFrom.x = this.x; this.moveFrom.y = this.y;
        this.moveTo.x = this.x; this.moveTo.y = this.y;
        this.moveT = 1;
        this.dashDir = 0;
      }
      this.laser = null;
      this.ripper = null;   // feature T9
      this.snipe = null;
      this.shotsLeft = 0;
      this.attackKind = null;
      this.phase = 'idle';
      this.cooldown = this.pauseDuration();
      this.moveTimer = MOVE_INTERVAL;
    }

    /* ---------- firewall placement ---------- */
    placeFirewalls() {
      const taken = new Set();
      for (let i = 0; i < this.firewalls.length; i++) {
        taken.add(key(this.firewalls[i].x, this.firewalls[i].y));
      }
      for (let i = 0; i < this.mines.length; i++) { // feature T9: no stacking
        taken.add(key(this.mines[i].x, this.mines[i].y));
      }
      const occupied = new Set(this.snakeKeys);
      this.addBodyKeys(occupied, this.x, this.y);
      if (this.charge) occupied.add(key(this.charge.x, this.charge.y));
      const head = this.head;

      const candidates = [];
      for (let cy = 0; cy < this.gridH; cy++) {
        for (let cx = 0; cx < this.gridW; cx++) {
          const k = key(cx, cy);
          if (occupied.has(k) || taken.has(k)) continue;
          if (head && manhattan(cx, cy, head.x, head.y) < 2) continue;
          candidates.push({ x: cx, y: cy });
        }
      }
      const n = Math.min(3 + this.bossIndex, FIREWALL_CAP - this.firewalls.length, candidates.length);
      for (let i = 0; i < n; i++) {
        const c = candidates.splice(randInt(candidates.length), 1)[0];
        this.firewalls.push({ x: c.x, y: c.y, warm: true });
      }
    }

    /* ---------- data charge ---------- */
    updateCharge(dt) {
      if (this.charge) return;
      if (this.chargeRespawn > 0) {
        this.chargeRespawn -= dt;
        if (this.chargeRespawn > 0) return;
      }
      if (this.chargeRetry > 0) {
        this.chargeRetry -= dt;
        if (this.chargeRetry > 0) return;
      }
      if (!this.spawnCharge()) this.chargeRetry = 0.4; // field crowded, retry soon
    }

    spawnCharge() {
      const occupied = new Set(this.snakeKeys);
      for (let i = 0; i < this.firewalls.length; i++) {
        occupied.add(key(this.firewalls[i].x, this.firewalls[i].y));
      }
      this.addBodyKeys(occupied, this.x, this.y);
      if (this.moveT < 1) this.addBodyKeys(occupied, this.moveTo.x, this.moveTo.y);
      if (this.phase === 'attack' && this.attackKind === 'dash') {
        const x0 = clamp(Math.floor(this.dashX), 0, this.gridW - 1);
        const x1 = clamp(Math.ceil(this.dashX + 2) - 1, 0, this.gridW - 1);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cy = this.y; cy <= this.y + 1; cy++) occupied.add(key(cx, cy));
        }
      }
      const head = this.head;

      const candidates = [];
      for (let cy = 0; cy < this.gridH; cy++) {
        for (let cx = 0; cx < this.gridW; cx++) {
          if (occupied.has(key(cx, cy))) continue;
          if (head && manhattan(cx, cy, head.x, head.y) < 2) continue;
          candidates.push({ x: cx, y: cy });
        }
      }
      if (!candidates.length) return false;
      this.charge = candidates[randInt(candidates.length)];
      return true;
    }

    collectCharge(x, y) {
      if (!this.active) return false;
      if (!this.charge || this.charge.x !== x || this.charge.y !== y) return false;
      this.charge = null;
      this.chargeRespawn = CHARGE_RESPAWN;
      this.hp -= 1;
      this.emit('onSfx', 'hit');
      if (this.hp <= 0) this.die();
      return true;
    }

    chargeCells() {
      return this.charge ? [{ x: this.charge.x, y: this.charge.y }] : [];
    }

    die() {
      this.hp = 0;
      this.active = false;
      this.phase = 'dead';
      this.laser = null;
      this.firewalls = []; // all hazards cleared (particle burst belongs to the FX layer)
      this.charge = null;
      this.attackKind = null;
      this.ripper = null;       // feature T9
      this.snipe = null;
      this.shotsLeft = 0;
      this.projectiles = [];
      this.mines = [];
      this.drones = [];
      this.freezeWave = 0;
      this.emit('onSfx', 'boss_die');
      this.emit('onDefeated');
    }

    /* ============================================================
       HAZARDS — lethal cells of the current instant
       ============================================================ */
    addBodyKeys(set, x, y) {
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 2; j++) set.add(key(x + i, y + j));
      }
    }

    hazardCells() {
      const out = new Set();
      if (!this.active) return out;

      // boss body (all 4 cells; both footprints while sliding, dash covered below)
      if (this.phase === 'attack' && this.attackKind === 'dash') {
        const x0 = clamp(Math.floor(this.dashX), 0, this.gridW - 1);
        const x1 = clamp(Math.ceil(this.dashX + 2) - 1, 0, this.gridW - 1);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cy = this.y; cy <= this.y + 1; cy++) out.add(key(cx, cy));
        }
      } else {
        this.addBodyKeys(out, this.x, this.y);
        if (this.moveT < 1) this.addBodyKeys(out, this.moveTo.x, this.moveTo.y);
      }

      // active laser beam (telegraph is a warning only — NOT lethal)
      if (this.phase === 'attack' && this.attackKind === 'laser' && this.laser) {
        if (this.laser.axis === 'row') {
          for (let cx = 0; cx < this.gridW; cx++) out.add(key(cx, this.laser.index));
        } else {
          for (let cy = 0; cy < this.gridH; cy++) out.add(key(this.laser.index, cy));
        }
      }

      // firewalls past their warm-up stay lethal until the fight ends
      for (let i = 0; i < this.firewalls.length; i++) {
        const f = this.firewalls[i];
        if (!f.warm) out.add(key(f.x, f.y));
      }

      // feature T9: mines once armed (blink first 0.8 s, then lethal 6 s)
      for (let i = 0; i < this.mines.length; i++) {
        const m = this.mines[i];
        if (m.t <= MINE_LIFE - MINE_ARM) out.add(key(m.x, m.y));
      }

      // feature T9: flying projectiles occupy their current cell
      for (let i = 0; i < this.projectiles.length; i++) {
        const p = this.projectiles[i];
        const px = Math.round(p.x);
        const py = Math.round(p.y);
        if (px >= 0 && px < this.gridW && py >= 0 && py < this.gridH) {
          out.add(key(px, py));
        }
      }

      // feature T9: homing drones
      for (let i = 0; i < this.drones.length; i++) {
        const d = this.drones[i];
        const dx = Math.round(d.x);
        const dy = Math.round(d.y);
        if (dx >= 0 && dx < this.gridW && dy >= 0 && dy < this.gridH) {
          out.add(key(dx, dy));
        }
      }

      // NOTE (type 4): the decompiler beam is deliberately NOT here —
      // crossing it wounds (cuts segments), it never kills
      return out;
    }

    /* ============================================================
       DRAW — canvas pixels, cell size in px (grid is gridW x gridH cells)
       ============================================================ */
    draw(g, cell) {
      g.save();
      try {
        if (!this.active) return;
        this.drawDashTelegraph(g, cell);
        this.drawFirewalls(g, cell);
        this.drawMines(g, cell);        // feature T9
        this.drawLaser(g, cell);
        this.drawRipper(g, cell);       // feature T9
        this.drawSnipeAim(g, cell);     // feature T9
        this.drawProjectiles(g, cell);  // feature T9
        this.drawDrones(g, cell);       // feature T9
        this.drawFreeze(g, cell);       // feature T9
        this.drawCharge(g, cell);
        this.drawBoss(g, cell);
      } finally {
        g.restore(); // always pair the save above — no context leaks
      }
    }

    /* visual position of the 2x2 block origin, in fractional cells */
    renderPos() {
      if (this.phase === 'intro') {
        const t = clamp(1 - this.introTimer / INTRO_TIME, 0, 1);
        const e = 1 - Math.pow(1 - t, 3); // ease-out descent
        return { x: this.x, y: this.y - (1 - e) * 3.5 };
      }
      if (this.phase === 'attack' && this.attackKind === 'dash') {
        return { x: this.dashX, y: this.y };
      }
      const e = this.moveT >= 1 ? 1 : (1 - Math.cos(Math.PI * this.moveT)) / 2;
      return {
        x: lerp(this.moveFrom.x, this.moveTo.x, e),
        y: lerp(this.moveFrom.y, this.moveTo.y, e)
      };
    }

    /* feature T9: per-type palette (types 1-3 keep the classic red) */
    skin() {
      switch (this.bossType) {
        case 4: return { ring: '#00f0ff', c1: 'rgba(0,240,255,', c2: 'rgba(2,22,34,0.92)', pupil: '#eafdff' };
        case 5: return { ring: '#ff7a00', c1: 'rgba(255,122,0,', c2: 'rgba(40,22,4,0.92)', pupil: '#ffd9a8' };
        case 6: return { ring: '#ff2d55', c1: 'rgba(255,45,85,', c2: 'rgba(24,2,10,0.94)', pupil: '#ffd7de' };
        case 7: return { ring: '#7de3ff', c1: 'rgba(125,227,255,', c2: 'rgba(6,30,46,0.92)', pupil: '#eafaff' };
        case 8: return { ring: '#8a5cff', c1: 'rgba(138,92,255,', c2: 'rgba(16,10,38,0.92)', pupil: '#d9c8ff' };
        default: return { ring: '#ff2d55', c1: 'rgba(255,45,85,', c2: 'rgba(40,4,14,0.92)', pupil: '#ffd7de' };
      }
    }

    drawBoss(g, cell) {
      const p = this.renderPos();
      let px = p.x * cell;
      let py = p.y * cell;
      const size = cell * 2;
      if (this.phase === 'idle' && this.moveT >= 1) { // slight shiver in place
        px += Math.sin(this.time * 21) * 1.6;
        py += Math.cos(this.time * 17) * 1.6;
      }
      const cx = px + size / 2;
      const cy = py + size / 2;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);
      const isTele = this.phase === 'telegraph';
      const tele = isTele ? 0.5 + 0.5 * Math.sin(this.time * 20) : 0;
      const skin = this.skin();
      const chewing = this.chewTimer > 0 ? 1 - this.chewTimer / CHEW_TIME : 0;

      // rotating spikes around the core
      g.save();
      g.translate(cx, cy);
      g.rotate(this.time * 0.9);
      g.strokeStyle = skin.ring;
      g.lineWidth = 2;
      g.globalAlpha = 0.5 + pulse * 0.3 + tele * 0.2;
      const spikes = this.bossType === 7 ? 6 : 10;
      for (let i = 0; i < spikes; i++) {
        const a = (Math.PI * 2 * i) / spikes;
        const r1 = cell * (0.5 + pulse * 0.06);
        const r2 = cell * (0.9 + pulse * 0.12 + tele * 0.12);
        g.beginPath();
        g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
        g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
        g.stroke();
      }
      g.restore();

      // pulsing core block in the type palette
      g.shadowColor = skin.ring;
      g.shadowBlur = 16 + pulse * 10 + tele * 22;
      const grad = g.createRadialGradient(cx, cy, cell * 0.2, cx, cy, size * 0.75);
      grad.addColorStop(0, skin.c1 + (0.5 + tele * 0.4).toFixed(3) + ')');
      grad.addColorStop(1, skin.c2);
      g.fillStyle = grad;
      roundRectPath(g, px + 2, py + 2, size - 4, size - 4, 6);
      g.fill();
      g.shadowBlur = 0;
      g.lineWidth = 2;
      g.strokeStyle = skin.ring;
      g.stroke();

      // inner eye, pupil tracks the snake head
      const eyeR = cell * 0.34 * (1 + tele * 0.12);
      g.shadowColor = skin.ring;
      g.shadowBlur = 10 + tele * 14;
      g.fillStyle = '#0a0410';
      g.beginPath();
      g.arc(cx, cy, eyeR, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
      g.lineWidth = 2;
      g.strokeStyle = skin.ring;
      g.stroke();

      let dx = 0, dy = 1;
      if (this.head) {
        const hx = this.head.x * cell + cell / 2 - cx;
        const hy = this.head.y * cell + cell / 2 - cy;
        const len = Math.sqrt(hx * hx + hy * hy) || 1;
        dx = hx / len;
        dy = hy / len;
      }
      g.fillStyle = isTele ? skin.ring : skin.pupil;
      g.beginPath();
      g.arc(cx + dx * eyeR * 0.45, cy + dy * eyeR * 0.45, cell * 0.15 * (1 + tele * 0.3), 0, Math.PI * 2);
      g.fill();

      this.drawTypeMarks(g, cell, cx, cy, dx, dy, chewing, pulse);
    }

    /* feature T9: small signature details per boss type */
    drawTypeMarks(g, cell, cx, cy, dx, dy, chewing, pulse) {
      if (this.bossType === 5) {
        // turret barrel pointing at the aim / head
        g.save();
        g.strokeStyle = '#ff7a00';
        g.lineWidth = 4;
        g.lineCap = 'round';
        g.shadowColor = '#ff7a00';
        g.shadowBlur = 8;
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + dx * cell * 1.05, cy + dy * cell * 1.05);
        g.stroke();
        g.restore();
      } else if (this.bossType === 6) {
        // the maw: two rows of teeth opening while chewing
        const open = 0.15 + chewing * 0.85;
        const ang = Math.atan2(dy, dx);
        g.save();
        g.translate(cx, cy);
        g.rotate(ang);
        g.fillStyle = '#ffd7de';
        g.shadowColor = '#ff2d55';
        g.shadowBlur = 10;
        const tw = cell * 0.42;              // mouth depth
        const th = cell * 0.16 * open + 2;   // half the opening
        for (let s = -1; s <= 1; s += 2) {
          g.beginPath();
          g.moveTo(cell * 0.1, s * th * 0.2);
          g.lineTo(cell * 0.1 + tw, s * th);
          g.lineTo(cell * 0.1 + tw * 0.55, s * th * 0.25);
          g.closePath();
          g.fill();
        }
        g.restore();
      } else if (this.bossType === 7) {
        // ice crystals growing on the core
        g.save();
        g.fillStyle = '#eafaff';
        g.strokeStyle = '#7de3ff';
        g.lineWidth = 1.5;
        g.shadowColor = '#7de3ff';
        g.shadowBlur = 8;
        for (let k = 0; k < 3; k++) {
          const a = -Math.PI / 2 + (k - 1) * 0.7 + this.time * 0.3;
          const ox = Math.cos(a) * cell * 0.95;
          const oy = Math.sin(a) * cell * 0.95;
          const h = cell * (0.28 + pulse * 0.1);
          g.beginPath();
          g.moveTo(cx + ox, cy + oy - h);
          g.lineTo(cx + ox + h * 0.32, cy + oy);
          g.lineTo(cx + ox, cy + oy + h * 0.4);
          g.lineTo(cx + ox - h * 0.32, cy + oy);
          g.closePath();
          g.fill();
          g.stroke();
        }
        g.restore();
      } else if (this.bossType === 8) {
        // admin crown: three status diodes
        g.save();
        g.shadowBlur = 0;
        for (let k = -1; k <= 1; k++) {
          const blink = 0.4 + 0.6 * Math.abs(Math.sin(this.time * 4 + k));
          g.fillStyle = k === 0 ? '#00f0ff' : '#8a5cff';
          g.beginPath();
          g.arc(cx + k * cell * 0.42, cy - cell * 0.72, cell * 0.1 * blink + 1, 0, Math.PI * 2);
          g.fill();
        }
        g.restore();
      } else if (this.bossType === 4) {
        // decompiler: thin scanning ring, hint of the beam to come
        g.save();
        g.strokeStyle = 'rgba(0,240,255,0.5)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(cx, cy, cell * 1.15 + Math.sin(this.time * 5) * 2, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }
    }

    /* feature T9, type 4: the shredder beam — warning band, then a
       thick white beam with a cyan rim (never lethal) */
    drawRipper(g, cell) {
      if (!this.ripper) return;
      const isTele = this.phase === 'telegraph' && this.attackKind === 'ripper';
      const isActive = this.phase === 'attack' && this.attackKind === 'ripper';
      if (!isTele && !isActive) return;

      const W = this.gridW * cell;
      const H = this.gridH * cell;
      const row = this.ripper.axis === 'row';
      const blink = 0.5 + 0.5 * Math.sin(this.time * 14);

      g.save();
      if (isTele) {
        const x = row ? 0 : this.ripper.index * cell;
        const y = row ? this.ripper.index * cell : 0;
        const w = row ? W : cell;
        const h = row ? cell : H;
        g.fillStyle = 'rgba(0,240,255,' + (0.06 + 0.16 * blink).toFixed(3) + ')';
        g.fillRect(x, y, w, h);
        hatchBand(g, x, y, w, h, this.time, 'rgba(0,240,255,0.5)', 14, 120);
      } else {
        const flicker = 0.9 + 0.1 * Math.sin(this.time * 60);
        const th = cell * 0.9 * flicker;
        const inner = th * 0.62;
        // cyan rim
        g.shadowColor = '#00f0ff';
        g.shadowBlur = 24;
        g.fillStyle = 'rgba(0,240,255,0.85)';
        if (row) g.fillRect(0, this.ripper.index * cell + (cell - th) / 2, W, th);
        else g.fillRect(this.ripper.index * cell + (cell - th) / 2, 0, th, H);
        g.shadowBlur = 0;
        // white core
        g.fillStyle = '#ffffff';
        if (row) g.fillRect(0, this.ripper.index * cell + (cell - inner) / 2, W, inner);
        else g.fillRect(this.ripper.index * cell + (cell - inner) / 2, 0, inner, H);
      }
      g.restore();
    }

    /* feature T9, types 5/8: dashed aim line + pulsing reticle */
    drawSnipeAim(g, cell) {
      if (this.phase !== 'telegraph' || this.attackKind !== 'snipe' || !this.snipe) return;
      const p = this.renderPos();
      const ox = (p.x + 1) * cell;
      const oy = (p.y + 1) * cell;
      const tx = (this.snipe.tx + 0.5) * cell;
      const ty = (this.snipe.ty + 0.5) * cell;
      const blink = 0.5 + 0.5 * Math.sin(this.time * 24);
      g.save();
      g.strokeStyle = 'rgba(255,122,0,' + (0.35 + 0.5 * blink).toFixed(3) + ')';
      g.lineWidth = 2;
      g.setLineDash([10, 8]);
      g.lineDashOffset = -this.time * 160;
      g.beginPath();
      g.moveTo(ox, oy);
      g.lineTo(tx, ty);
      g.stroke();
      g.setLineDash([]);
      const r = cell * (0.45 + 0.2 * blink);
      g.strokeStyle = '#ff7a00';
      g.shadowColor = '#ff7a00';
      g.shadowBlur = 10;
      g.beginPath();
      g.arc(tx, ty, r, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(tx - r - 4, ty); g.lineTo(tx + r + 4, ty);
      g.moveTo(tx, ty - r - 4); g.lineTo(tx, ty + r + 4);
      g.stroke();
      g.restore();
    }

    /* feature T9: long narrow bolts flying along their velocity */
    drawProjectiles(g, cell) {
      for (let i = 0; i < this.projectiles.length; i++) {
        const p = this.projectiles[i];
        g.save();
        g.translate(p.x * cell, p.y * cell);
        g.rotate(Math.atan2(p.vy, p.vx));
        g.shadowColor = '#ffe600';
        g.shadowBlur = 10;
        g.fillStyle = '#ffe600';
        g.fillRect(-cell * 0.45, -cell * 0.11, cell * 0.9, cell * 0.22);
        g.shadowBlur = 0;
        g.fillStyle = '#ffffff';
        g.fillRect(-cell * 0.08, -cell * 0.05, cell * 0.45, cell * 0.1);
        g.restore();
      }
    }

    /* feature T9: mines — dashed blink while arming, spikes once live */
    drawMines(g, cell) {
      for (let i = 0; i < this.mines.length; i++) {
        const m = this.mines[i];
        const armed = m.t <= MINE_LIFE - MINE_ARM;
        const cx = m.x * cell + cell / 2;
        const cy = m.y * cell + cell / 2;
        const age = MINE_LIFE - m.t;
        g.save();
        if (!armed) {
          if (Math.floor(age / 0.13) % 2 === 0) {
            g.strokeStyle = '#ff7a00';
            g.lineWidth = 2;
            g.setLineDash([4, 3]);
            g.beginPath();
            g.arc(cx, cy, cell * 0.3, 0, Math.PI * 2);
            g.stroke();
            g.setLineDash([]);
          }
        } else {
          const pulse = 0.5 + 0.5 * Math.sin(this.time * 10);
          g.shadowColor = '#ff2d55';
          g.shadowBlur = 8 + pulse * 8;
          g.strokeStyle = '#ff2d55';
          g.lineWidth = 2;
          g.beginPath();
          g.arc(cx, cy, cell * 0.28, 0, Math.PI * 2);
          g.stroke();
          g.fillStyle = 'rgba(255,45,85,' + (0.35 + 0.4 * pulse).toFixed(3) + ')';
          g.beginPath();
          g.arc(cx, cy, cell * 0.15, 0, Math.PI * 2);
          g.fill();
          for (let k = 0; k < 4; k++) {
            const ang = k * Math.PI / 2 + this.time * 1.2;
            g.beginPath();
            g.moveTo(cx + Math.cos(ang) * cell * 0.28, cy + Math.sin(ang) * cell * 0.28);
            g.lineTo(cx + Math.cos(ang) * cell * 0.44, cy + Math.sin(ang) * cell * 0.44);
            g.stroke();
          }
        }
        g.restore();
      }
    }

    /* feature T9: small triangle drones with a cyan exhaust flame */
    drawDrones(g, cell) {
      for (let i = 0; i < this.drones.length; i++) {
        const d = this.drones[i];
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 30 + i * 2);
        g.save();
        g.translate(d.x * cell + cell / 2, d.y * cell + cell / 2);
        g.rotate(Math.atan2(d.vy || 0, d.vx || 1));
        g.shadowColor = '#8a5cff';
        g.shadowBlur = 10 + pulse * 6;
        g.fillStyle = '#8a5cff';
        g.beginPath();
        g.moveTo(cell * 0.32, 0);
        g.lineTo(-cell * 0.22, cell * 0.2);
        g.lineTo(-cell * 0.22, -cell * 0.2);
        g.closePath();
        g.fill();
        g.shadowColor = '#00f0ff';
        g.shadowBlur = 8;
        g.fillStyle = 'rgba(0,240,255,' + (0.5 + 0.5 * pulse).toFixed(3) + ')';
        g.beginPath();
        g.moveTo(-cell * 0.22, -cell * 0.08);
        g.lineTo(-cell * 0.22, cell * 0.08);
        g.lineTo(-cell * 0.45 - pulse * 3, 0);
        g.closePath();
        g.fill();
        g.restore();
      }
    }

    /* feature T9, type 7: charge-up ring while telegraphing, then the
       expanding wave circle (purely visual — the slow comes from the game) */
    drawFreeze(g, cell) {
      if (this.phase === 'telegraph' && this.attackKind === 'freeze') {
        const t = clamp(1 - this.telegraphTimer / FREEZE_TELEGRAPH, 0, 1);
        const blink = 0.5 + 0.5 * Math.sin(this.time * 18);
        const p = this.renderPos();
        const cx = (p.x + 1) * cell;
        const cy = (p.y + 1) * cell;
        const r = cell * (0.8 + t * 1.8);
        g.save();
        g.strokeStyle = 'rgba(125,227,255,' + (0.3 + 0.5 * blink).toFixed(3) + ')';
        g.lineWidth = 3;
        g.shadowColor = '#7de3ff';
        g.shadowBlur = 14;
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }
      if (this.freezeWave > 0) {
        const k = 1 - this.freezeWave; // 0 -> 1 expansion
        const cx = (this.x + 1) * cell;
        const cy = (this.y + 1) * cell;
        const maxR = Math.sqrt(
          Math.pow(this.gridW * cell, 2) + Math.pow(this.gridH * cell, 2)
        ) / 2;
        g.save();
        g.globalAlpha = this.freezeWave;
        g.strokeStyle = '#7de3ff';
        g.lineWidth = 6 * this.freezeWave + 2;
        g.shadowColor = '#7de3ff';
        g.shadowBlur = 18;
        g.beginPath();
        g.arc(cx, cy, k * maxR, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }
    }

    drawLaser(g, cell) {
      if (!this.laser) return;
      const isTele = this.phase === 'telegraph' && this.attackKind === 'laser';
      const isActive = this.phase === 'attack' && this.attackKind === 'laser';
      if (!isTele && !isActive) return;

      const W = this.gridW * cell;
      const H = this.gridH * cell;
      const row = this.laser.axis === 'row';
      const blink = 0.5 + 0.5 * Math.sin(this.time * 12);

      g.save();
      if (isTele) {
        // warning band: translucent cells + running hatch, NOT lethal
        const x = row ? 0 : this.laser.index * cell;
        const y = row ? this.laser.index * cell : 0;
        const w = row ? W : cell;
        const h = row ? cell : H;
        g.fillStyle = 'rgba(255,45,85,' + (0.08 + 0.16 * blink).toFixed(3) + ')';
        g.fillRect(x, y, w, h);
        hatchBand(g, x, y, w, h, this.time, 'rgba(255,45,85,0.55)', 14, 120);
      } else {
        // thick beam with glow and a white core
        const flicker = 0.9 + 0.1 * Math.sin(this.time * 60);
        const th = cell * 0.6 * flicker;
        const core = cell * 0.2 * flicker;
        g.shadowColor = '#ff2d55';
        g.shadowBlur = 26;
        g.fillStyle = 'rgba(255,45,85,0.85)';
        if (row) g.fillRect(0, this.laser.index * cell + (cell - th) / 2, W, th);
        else g.fillRect(this.laser.index * cell + (cell - th) / 2, 0, th, H);
        g.shadowBlur = 0;
        g.fillStyle = '#ffffff';
        if (row) g.fillRect(0, this.laser.index * cell + (cell - core) / 2, W, core);
        else g.fillRect(this.laser.index * cell + (cell - core) / 2, 0, core, H);
      }
      g.restore();
    }

    drawDashTelegraph(g, cell) {
      if (this.phase !== 'telegraph' || this.attackKind !== 'dash') return;
      const W = this.gridW * cell;
      const blink = 0.5 + 0.5 * Math.sin(this.time * 12);
      g.save();
      for (let r = 0; r < 2; r++) {
        const y = (this.y + r) * cell;
        g.fillStyle = 'rgba(255,45,85,' + (0.06 + 0.13 * blink).toFixed(3) + ')';
        g.fillRect(0, y, W, cell);
        hatchBand(g, 0, y, W, cell, this.time, 'rgba(255,45,85,0.4)', 18, 140);
        // chevrons showing the dash direction
        g.fillStyle = 'rgba(255,45,85,' + (0.3 + 0.3 * blink).toFixed(3) + ')';
        for (let px0 = -90 + ((this.time * 140) % 90); px0 < W; px0 += 90) {
          g.beginPath();
          if (this.dashDir > 0) {
            g.moveTo(px0, y + cell * 0.3);
            g.lineTo(px0 + 12, y + cell * 0.5);
            g.lineTo(px0, y + cell * 0.7);
          } else {
            g.moveTo(px0 + 12, y + cell * 0.3);
            g.lineTo(px0, y + cell * 0.5);
            g.lineTo(px0 + 12, y + cell * 0.7);
          }
          g.closePath();
          g.fill();
        }
      }
      g.restore();
    }

    drawFirewalls(g, cell) {
      const flare = this.phase === 'attack' && this.attackKind === 'firewall';
      for (let i = 0; i < this.firewalls.length; i++) {
        const f = this.firewalls[i];
        const x = f.x * cell;
        const y = f.y * cell;
        if (f.warm) {
          // warm-up: blinking dashed outline, not lethal
          const blink = 0.5 + 0.5 * Math.sin(this.time * 16);
          g.strokeStyle = 'rgba(255,122,0,' + (0.35 + 0.5 * blink).toFixed(3) + ')';
          g.lineWidth = 2;
          g.setLineDash([5, 4]);
          g.strokeRect(x + 2.5, y + 2.5, cell - 5, cell - 5);
          g.setLineDash([]);
        } else {
          const flash = flare ? 0.5 + 0.5 * Math.sin(this.time * 30) : 0;
          g.shadowColor = '#ff7a00';
          g.shadowBlur = 8 + flash * 10;
          g.fillStyle = 'rgba(255,122,0,' + (0.22 + flash * 0.25).toFixed(3) + ')';
          g.fillRect(x + 1.5, y + 1.5, cell - 3, cell - 3);
          g.shadowBlur = 0;
          g.strokeStyle = '#ff7a00';
          g.lineWidth = 2;
          g.strokeRect(x + 1.5, y + 1.5, cell - 3, cell - 3);
          hatchBand(g, x + 3, y + 3, cell - 6, cell - 6, this.time, 'rgba(255,122,0,0.7)', 8, 12);
        }
      }
    }

    drawCharge(g, cell) {
      if (!this.charge) return;
      const cx = this.charge.x * cell + cell / 2;
      const cy = this.charge.y * cell + cell / 2;
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 5);
      const r = cell * (0.26 + pulse * 0.06);
      g.save();
      g.translate(cx, cy);
      g.rotate(this.time * 1.4);
      g.shadowColor = '#00ff9d';
      g.shadowBlur = 10 + pulse * 10;
      g.fillStyle = '#00ff9d';
      g.beginPath();
      g.moveTo(0, -r);
      g.lineTo(r, 0);
      g.lineTo(0, r);
      g.lineTo(-r, 0);
      g.closePath();
      g.fill();
      g.shadowBlur = 0;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(0, 0, r * 0.25, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }

  CS.BossFight = BossFight;
})();
