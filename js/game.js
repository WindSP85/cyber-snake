/* ============================================================
   NEON://SNAKE — game orchestrator stub (SPEC §7)
   Full core arrives in T4. For now boot() opens the menu
   and keeps the start button alive.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  CS.Game = {
    boot: function () {
      CS.UI.show('menu');
      CS.UI.on({
        start: function () {
          CS.UI.toast('ЗАГРУЗКА...');
        }
      });
    }
  };

  function launch() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        CS.Game.boot();
      });
    } else {
      CS.Game.boot();
    }
  }

  launch();
})();
