/* ============================================================
   NEON://SNAKE — задания: ПВП-дейлик + недельный (SPEC §28)
   CS.Quests: детерминированный (по дате/неделе) выбор одного
   задания из пула, прогресс в localStorage, события — от duelui
   по итогам матча. Без DOM и сети — file://-safe.

   Contract:
     CS.Quests.daily()   → {id, key, need}   | null (нет прогресса)
     CS.Quests.weekly()  → {id, key, need}
     CS.Quests.progress(which) → {key, have, need, done}
     CS.Quests.event(evt)     — 'duel_end' {win, clean, causes, foe,
                                 roundsWon} из duelui.onMatchEnd
     CS.Quests.peek() → [{which, key, have, need, done}] для экрана
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  const DAY_KEY = 'cs_quest_day';
  const WEEK_KEY = 'cs_quest_week';

  /* ---------- пулы ---------- */

  /* дейлик: {id, key, need} — прогресс обнуляется каждый день */
  const DAILY_POOL = [
    { id: 'wins2', key: 'dqWins', need: 2 },      // выиграть 2 дуэли
    { id: 'play3', key: 'dqPlay', need: 3 },      // сыграть 3 дуэли
    { id: 'bite2', key: 'dqBite', need: 2 },      // 2 раунда-победы укусом
    { id: 'clean1', key: 'dqClean', need: 1 },    // выиграть 2:0
    { id: 'loop1', key: 'dqLoop', need: 1 }       // победа закольцовкой
  ];

  /* недельный: ключ недели YYYY-Www, обнуляется по понедельникам */
  const WEEKLY_POOL = [
    { id: 'wins10', key: 'wqWins', need: 10 },    // 10 побед за неделю
    { id: 'diff5', key: 'wqDiff', need: 5 },      // 5 разных соперников
    { id: 'streak4', key: 'wqStreak', need: 4 },  // серия из 4 побед
    { id: 'rounds20', key: 'wqRounds', need: 20 } // 20 выигранных раундов
  ];

  /* ---------- утилиты (стиль daily.js) ---------- */

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function dateStr() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* ISO-неделя: понедельник — начало; ключ YYYY-Www */
  function weekStr() {
    const d = new Date();
    const day = (d.getDay() + 6) % 7;            // пн=0
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
    const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
    const jan1 = new Date(thursday.getFullYear(), 0, 1);
    const week = Math.floor((thursday - jan1) / 604800000) + 1;
    return thursday.getFullYear() + '-W' + pad2(week);
  }

  function hashStr(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  function loadRaw(storageKey, stamp) {
    try {
      const raw = JSON.parse(window.localStorage.getItem(storageKey) || 'null');
      if (raw && raw.stamp === stamp && raw.id) return raw;
    } catch (e) {
      /* битый JSON — начнём заново */
    }
    return null;
  }

  function saveRaw(storageKey, raw) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(raw));
    } catch (e) {
      /* хранилище недоступно — прогресс до перезагрузки */
    }
  }

  function questFor(pool, stamp, storageKey) {
    const pick = pool[hashStr(stamp) % pool.length];
    const raw = loadRaw(storageKey, stamp);
    return {
      id: pick.id,
      key: pick.key,
      need: pick.need,
      have: raw && raw.id === pick.id ? raw.have : 0
    };
  }

  function bump(storageKey, stamp, quest, delta) {
    let raw = loadRaw(storageKey, stamp);
    if (!raw || raw.id !== quest.id) raw = { stamp: stamp, id: quest.id, have: 0 };
    raw.have = Math.min(quest.need, (raw.have || 0) + delta);
    saveRaw(storageKey, raw);
    return raw.have;
  }

  /* ---------- события матча ---------- */

  /* evt = {win, clean, causes:[...], foe, roundsWon} — от onMatchEnd */
  function onDuelEnd(evt) {
    const e = evt || {};
    const win = !!e.win;
    const causes = Array.isArray(e.causes) ? e.causes : [];
    const day = questFor(DAILY_POOL, dateStr(), DAY_KEY);
    const week = questFor(WEEKLY_POOL, weekStr(), WEEK_KEY);

    /* дейлик */
    if (day.id === 'wins2' && win) bump(DAY_KEY, dateStr(), day, 1);
    if (day.id === 'play3') bump(DAY_KEY, dateStr(), day, 1);
    if (day.id === 'bite2') {
      const n = causes.filter(function (c) { return c === 'bite'; }).length;
      if (n) bump(DAY_KEY, dateStr(), day, n);
    }
    if (day.id === 'clean1' && win && e.clean) bump(DAY_KEY, dateStr(), day, 1);
    if (day.id === 'loop1' && win && causes.indexOf('loop') !== -1) {
      bump(DAY_KEY, dateStr(), day, 1);
    }

    /* недельный */
    if (week.id === 'wins10' && win) bump(WEEK_KEY, weekStr(), week, 1);
    if (week.id === 'diff5' && win && e.foe) {
      const seenKey = 'cs_quest_foes_' + weekStr();
      let seen = [];
      try {
        seen = JSON.parse(window.localStorage.getItem(seenKey) || '[]');
      } catch (err) { /* пусто */ }
      if (seen.indexOf(e.foe) === -1) {
        seen.push(e.foe);
        if (seen.length > 30) seen = seen.slice(-30);
        try { window.localStorage.setItem(seenKey, JSON.stringify(seen)); } catch (err) { /* нет */ }
        bump(WEEK_KEY, weekStr(), week, 1);
      }
    }
    if (week.id === 'streak4') {
      /* прогресс = длина ТЕКУЩЕЙ серии побед: поражение обнуляет */
      const sk = 'cs_quest_streak';
      let cur = 0;
      try { cur = Number(window.localStorage.getItem(sk)) || 0; } catch (err) { cur = 0; }
      cur = win ? Math.max(cur, 0) + 1 : 0;
      try { window.localStorage.setItem(sk, String(cur)); } catch (err) { /* нет */ }
      let raw = loadRaw(WEEK_KEY, weekStr());
      if (!raw || raw.id !== 'streak4') raw = { stamp: weekStr(), id: 'streak4', have: 0 };
      raw.have = win ? Math.min(week.need, cur) : 0;
      saveRaw(WEEK_KEY, raw);
    }
    if (week.id === 'rounds20') {
      bump(WEEK_KEY, weekStr(), week, Math.max(0, Number(e.roundsWon) || 0));
    }
  }

  /* ---------- публичное ---------- */

  function progress(which) {
    if (which === 'weekly') {
      const q = questFor(WEEKLY_POOL, weekStr(), WEEK_KEY);
      return { which: 'weekly', key: q.key, have: q.have, need: q.need, done: q.have >= q.need };
    }
    const q = questFor(DAILY_POOL, dateStr(), DAY_KEY);
    return { which: 'daily', key: q.key, have: q.have, need: q.need, done: q.have >= q.need };
  }

  CS.Quests = {
    daily: function () { return progress('daily'); },
    weekly: function () { return progress('weekly'); },
    progress: progress,
    event: function (evt) {
      try {
        onDuelEnd(evt);
      } catch (e) {
        /* прогресс задания не должен ломать экран результата */
      }
    },
    peek: function () {
      return [progress('daily'), progress('weekly')];
    }
  };
})();
