/* ============================================================
   NEON://SNAKE — audio engine stub (SPEC §7)
   Full synthesis arrives in T2. Calls before ensure()
   are silently ignored; no exceptions ever.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  CS.Audio = {
    /* Create/resume AudioContext on a user gesture */
    ensure: function () {},

    /* 'menu' | 'game' | 'boss' | null (stop) */
    music: function (mode) {},

    /* Play an SFX by name */
    sfx: function (name) {},

    setMuted: function (muted) {},

    /* Mute state is persisted in localStorage key 'cs_muted' */
    getMuted: function () {
      try {
        const raw = window.localStorage.getItem('cs_muted');
        return raw === '1' || raw === 'true';
      } catch (e) {
        return false;
      }
    }
  };
})();
