/* ============================================================
   NEON://SNAKE — boss fight stub (SPEC §7)
   Full AI (laser / firewall / dash) arrives in T3.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  class BossFight {
    constructor(bossIndex, gridW, gridH, events) {
      this.bossIndex = bossIndex || 1;
      this.gridW = gridW || 30;
      this.gridH = gridH || 20;
      this.events = events || {};
      this.active = false;
      this.hp = 1;
      this.maxHp = 1;
      this.name = 'СТРАЖ СЕТИ';
      this.phase = 'idle';
    }

    /* dt in seconds; snakeCells = [{x,y},...] head first */
    update(dt, snakeCells) {}

    /* g = CanvasRenderingContext2D, cell = px per grid cell */
    draw(g, cell) {}

    /* Set<"x,y"> of lethal cells for the current frame */
    hazardCells() {
      return new Set();
    }

    /* true if a data charge was at (x, y) — damage applied */
    collectCharge(x, y) {
      return false;
    }

    /* Charge positions, usually 1 */
    chargeCells() {
      return [];
    }
  }

  CS.BossFight = BossFight;
})();
