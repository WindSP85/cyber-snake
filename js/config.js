/* ============================================================
   NEON://SNAKE — cloud config (feature T14)
   CS.Config: Supabase credentials for the global leaderboard.
   Loads first, before every other script — anyone may read it.

   ПУСТЫЕ СТРОКИ = локальный режим (как сейчас): таблица лидеров
   живёт в localStorage, сеть не трогается вовсе, файл можно
   открывать через file://. Заполняется при подключении облака:
   Supabase → Project Settings → API → URL + anon public key
   (и выполнить supabase.sql из корня проекта).
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  CS.Config = {
    /* заполняется при подключении облака (Supabase: Settings → API) */
    supabaseUrl: 'https://fjpwljcsumnabuymynpk.supabase.co',
    supabaseKey: 'sb_publishable_ccfXAKoH5QhqVuTNxs6UUA_B83qU8WV'
  };
})();
