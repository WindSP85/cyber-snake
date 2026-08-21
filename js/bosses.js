/* ============================================================
   NEON://SNAKE — boss fight system (SPEC §4, §6, §7)
   CS.BossFight: 2x2-cell boss, laser / firewall / dash attacks,
   data charges, HP, smooth cell-based movement, canvas render.
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

  const NAMES = ['СТРАЖ СЕТИ', 'ВИРУС-КОРОЛЕВА', 'АЛГОРИТМ ОМЕГА'];

  /* ---------- small helpers ---------- */
  function key(x, y) { return x + ',' + y; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function randInt(n) { return Math.floor(Math.random() * n); }
  function manhattan(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); }

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

      this.maxHp = 3 + this.bossIndex;
      this.hp = this.maxHp;
      this.name = this.bossIndex <= NAMES.length
        ? NAMES[this.bossIndex - 1]
        : 'АЛГОРИТМ ОМЕГА mk.' + (this.bossIndex - NAMES.length);

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

      this.emit('onWarn', '⚠ БОСС: ' + this.name);
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

      // finish the current one-cell visual slide in any live phase
      if (this.moveT < 1) {
        this.moveT = Math.min(1, this.moveT + dt / MOVE_DURATION);
        if (this.moveT >= 1) {
          this.x = this.moveTo.x;
          this.y = this.moveTo.y;
          this.moveFrom.x = this.x; this.moveFrom.y = this.y;
        }
      }

      if (this.phase === 'idle') {
        this.updateIdleMove(dt);
        this.cooldown -= dt;
        if (this.cooldown <= 0 && this.moveT >= 1) this.chooseAttack();
      } else if (this.phase === 'telegraph') {
        this.telegraphTimer -= dt;
        if (this.telegraphTimer <= 0) this.launchAttack();
      } else if (this.phase === 'attack') {
        if (this.attackKind === 'dash') {
          this.updateDash(dt);
        } else {
          this.attackTimer -= dt;
          if (this.attackTimer <= 0) this.endAttack();
        }
      }
    }

    pauseDuration() {
      return Math.max(MIN_PAUSE, 2.5 - 0.15 * this.bossIndex);
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
        }
      }
      this.moveFrom.x = this.x; this.moveFrom.y = this.y;
      this.moveTo.x = nx; this.moveTo.y = ny;
      this.moveT = 0;
      return true;
    }

    /* ---------- attack selection ---------- */
    chooseAttack() {
      const pool = ['laser', 'firewall'];
      if (this.bossIndex >= 2) pool.push('dash');
      if (this.firewalls.length >= FIREWALL_CAP) {
        pool.splice(pool.indexOf('firewall'), 1); // cap reached, nothing to place
      }
      let kind = pool[randInt(pool.length)];
      if (kind === this.lastAttack && pool.length > 1) {
        const rest = pool.filter((k) => k !== this.lastAttack);
        kind = rest[randInt(rest.length)];
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
      } else { // dash
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
      }
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
      } else { // dash
        this.dashX = this.x;
        this.phase = 'attack';
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

    endAttack() {
      if (this.attackKind === 'dash') {
        this.x = Math.round(this.dashX);
        this.moveFrom.x = this.x; this.moveFrom.y = this.y;
        this.moveTo.x = this.x; this.moveTo.y = this.y;
        this.moveT = 1;
        this.dashDir = 0;
      }
      this.laser = null;
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
        this.drawLaser(g, cell);
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

      // rotating spikes around the core
      g.save();
      g.translate(cx, cy);
      g.rotate(this.time * 0.9);
      g.strokeStyle = '#ff2d55';
      g.lineWidth = 2;
      g.globalAlpha = 0.5 + pulse * 0.3 + tele * 0.2;
      const spikes = 10;
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

      // pulsing dark-red core block
      g.shadowColor = '#ff2d55';
      g.shadowBlur = 16 + pulse * 10 + tele * 22;
      const grad = g.createRadialGradient(cx, cy, cell * 0.2, cx, cy, size * 0.75);
      grad.addColorStop(0, 'rgba(255,45,85,' + (0.5 + tele * 0.4).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(40,4,14,0.92)');
      g.fillStyle = grad;
      roundRectPath(g, px + 2, py + 2, size - 4, size - 4, 6);
      g.fill();
      g.shadowBlur = 0;
      g.lineWidth = 2;
      g.strokeStyle = isTele ? '#ff5c7a' : '#ff2d55';
      g.stroke();

      // inner eye, pupil tracks the snake head
      const eyeR = cell * 0.34 * (1 + tele * 0.12);
      g.shadowColor = '#ff2d55';
      g.shadowBlur = 10 + tele * 14;
      g.fillStyle = '#12030a';
      g.beginPath();
      g.arc(cx, cy, eyeR, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
      g.lineWidth = 2;
      g.strokeStyle = '#ff2d55';
      g.stroke();

      let dx = 0, dy = 1;
      if (this.head) {
        const hx = this.head.x * cell + cell / 2 - cx;
        const hy = this.head.y * cell + cell / 2 - cy;
        const len = Math.sqrt(hx * hx + hy * hy) || 1;
        dx = hx / len;
        dy = hy / len;
      }
      g.fillStyle = isTele ? '#ff2d55' : '#ffd7de';
      g.beginPath();
      g.arc(cx + dx * eyeR * 0.45, cy + dy * eyeR * 0.45, cell * 0.15 * (1 + tele * 0.3), 0, Math.PI * 2);
      g.fill();
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
