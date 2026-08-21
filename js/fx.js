/* ============================================================
   NEON://SNAKE — FX stub (SPEC §7)
   Particles / shake / glitch / flash arrive in T5.
   Safe no-ops.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  CS.FX = {
    update: function (dt) {},

    /* draw on top of the scene (particles, flashes) */
    draw: function (g) {},

    /* particle burst at pixel coordinates */
    burst: function (px, py, color, n) {},

    /* screen shake */
    shake: function (power) {},

    glitch: function (sec) {},

    flash: function (color, sec) {}
  };
})();
