/* ============================================================
   NEON://SNAKE — i18n layer (feature T7)
   CS.I18N.get / set / t / onChange. Dictionary-based UI language,
   persisted in localStorage key 'cs_lang', 'ru' by default.
   Static markup texts are bound via data-i18n attributes and
   re-applied on every switch — no page reload needed.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  const STORAGE_KEY = 'cs_lang';
  const DEFAULT_LANG = 'ru';

  /* ---------- dictionary (ru is the fallback language) ---------- */
  const DICT = {
    ru: {
      langTitle: 'ВЫБЕРИТЕ ЯЗЫК',
      subtitle: 'киберпротокол v2.077',
      play: 'Играть',
      controls: 'Управление',
      back: 'Назад',
      hudScore: 'Счёт',
      hudBest: 'Рекорд',
      hudLevel: 'Уровень',
      pauseBtn: 'Пауза',
      soundOn: 'Звук: вкл',
      soundOff: 'Звук: выкл',
      bestLabel: 'Рекорд:',
      hintMenu: 'Enter — старт · M — звук',
      hintPause: 'Space — продолжить',
      hintRestart: 'Enter — заново',
      pauseTitle: 'ПАУЗА',
      resume: 'Продолжить',
      toMenu: 'В меню',
      gameOverTitle: 'ИГРА ОКОНЧЕНА',
      restart: 'Заново',
      controlsTitle: 'УПРАВЛЕНИЕ',
      ctlColAction: 'Действие',
      ctlColKeys: 'Клавиши',
      ctlColTouch: 'Тач',
      ctlDirection: 'Направление',
      ctlDirKeys: 'Стрелки и WASD',
      ctlDirTouch: 'Свайпы в 4 стороны',
      ctlPause: 'Пауза',
      ctlPauseKeys: 'Space или Esc',
      ctlPauseTouch: 'Кнопка паузы в HUD',
      ctlStart: 'Старт / рестарт',
      ctlStartKeys: 'Enter или клик по полю',
      ctlStartTouch: 'Кнопки «Играть» / «Заново»',
      ctlSound: 'Звук вкл/выкл',
      ctlSoundKeys: 'M',
      ctlSoundTouch: 'Кнопка звука в HUD',
      toastConnect: 'ПОДКЛЮЧЕНИЕ К СЕТИ...',
      toastLevel: 'УРОВЕНЬ {1}',
      toastBossDown: 'БОСС УНИЧТОЖЕН',
      hintBoss: 'СЪЕШЬТЕ ЗЕЛЁНЫЙ ЗАРЯД — УРОН БОССУ',
      bossWarn: '⚠ БОСС: ',
      boss1: 'СТРАЖ СЕТИ',
      boss2: 'ВИРУС-КОРОЛЕВА',
      boss3: 'АЛГОРИТМ ОМЕГА',
      boss4: 'ДЕКОМПИЛЯТОР',
      boss5: 'ОХОТНИК-ТУРЕЛЬ',
      boss6: 'ГЛОТ',
      boss7: 'КРИОГЕН',
      boss8: 'АДМИН СИСТЕМЫ',
      pVirus: 'ЗАРАЖЕНИЕ: −50',
      pGolden: '+150 ДАННЫХ',
      pSurge: 'СКАЧОК ЭНЕРГИИ!',
      pSlow: 'ЗАМЕДЛЕНИЕ ВРЕМЕНИ',
      pMagnet: 'МАГНИТ АКТИВЕН',
      pLife: '+1 ЖИЗНЬ',
      pFreeze: 'ЗАМОРОЗКА',
      respawnToast: 'ПЕРЕЗАПУСК СИСТЕМЫ...',
      livesLabel: 'Жизни',
      /* feature T11: mystery containers + tail bank (SPEC §14) */
      mJackpot: 'ДЖЕКПОТ +500',
      mDouble: '×2 ОЧКИ 10 С',
      mTurbo: 'ТУРБО! ×2 СКОРОСТЬ',
      mLifeRe: '+1 ЖИЗНЬ',
      mReverse: 'РЕВЕРС УПРАВЛЕНИЯ!',
      mSplit: 'РАСПАД! ЛОВИ ЯДРА!',
      mDeath: 'ФАТАЛЬНАЯ ОШИБКА',
      bankToast: 'ХВОСТ → +{1} ОЧКОВ',
      bankInterest: 'ПРОЦЕНТЫ ПО ВКЛАДУ +50',
      /* feature T10: leaderboard (SPEC §13) */
      board: 'Лидеры',
      boardTitle: 'ЛИДЕРЫ',
      boardClear: 'Очистить',
      boardSure: 'Точно?',
      boardEmpty: 'ПОКА ПУСТО',
      /* feature T14: global leaderboard mode badges */
      boardGlobal: 'МИР',
      boardLocal: 'ОФЛАЙН · ЛОКАЛЬНЫЙ ТОП',
      boardLoading: 'ЗАГРУЗКА…',
      savePrompt: 'ВЫ В ТОП-10! ИМЯ:',
      save: 'Сохранить',
      colPlace: '#',
      colName: 'ИМЯ',
      colScore: 'СЧЁТ',
      colLvl: 'УР.',
      colDate: 'ДАТА',
      /* feature T15: Telegram share (SPEC §15) */
      share: 'Поделиться',
      shareText: 'Мой рекорд в NEON://SNAKE: {1} 🐍 Побьёшь?',
      /* feature T16: achievements (SPEC §16) */
      ach: 'Достижения',
      achTitle: 'ДОСТИЖЕНИЯ',
      achOf: '{1} из {2}',
      achFirstMeal: 'Первый пакет',
      achBoss1: 'Первый босс',
      achBoss5: 'Гроза боссов',
      achLvl5: 'Разогрев',
      achLvl10: 'Профи',
      achScore1000: 'Первая тысяча',
      achScore2500: 'Магнат данных',
      achJackpot: 'Джекпот!',
      achJackpot3: 'Три удачи',
      achCores: 'Ловец ядер',
      achBanker: 'Банкир',
      achMystery10: 'Мастер тайн',
      achSurvivor: 'Выживший',
      aFirstMeal: 'Первая еда',
      aBoss1: 'Первый босс повержен',
      aBoss5: '5 боссов за всё время',
      aLvl5: 'Уровень 5',
      aLvl10: 'Уровень 10',
      aScore1000: '1000 очков',
      aScore2500: '2500 очков',
      aJackpot: 'Джекпот!',
      aJackpot3: '3 джекпота за всё время',
      aCores: 'Поймал оба ядра после распада',
      aBanker: 'Сдал 8+ сегментов в хранилище',
      aMystery10: '10 тайн за всё время',
      aSurvivor: 'Выжил на всех 3 жизнях',
      /* feature T17: skins (SPEC §17) */
      skins: 'Скины',
      skinsTitle: 'СКИНЫ',
      skinNeon: 'Неон',
      skinIce: 'Лёд',
      skinToxic: 'Токсин',
      skinMagma: 'Магма',
      skinGold: 'Золото',
      skinRainbow: 'Радуга',
      skinGhost: 'Призрак',
      skinCondIce: 'Повергни первого босса',
      skinCondToxic: 'Достигни 10 уровня',
      skinCondMagma: 'Набери 2500 очков',
      skinCondGold: 'Сдай 8+ сегментов за раз',
      skinCondRainbow: 'Повергни 5 боссов',
      skinCondGhost: 'Открой 10 тайн',
      /* feature T19: meta-progression upgrades (SPEC §19) */
      upg: 'Апгрейды',
      upgTitle: 'АПГРЕЙДЫ',
      upgChips: '◈ {1}',
      upgBuy: 'Купить',
      upgMax: 'МАКС',
      upgLife: 'Жизнь',
      upgMagnet: 'Магнит',
      upgDuration: 'Длительность',
      upgLuck: 'Удача',
      upgLifeD: 'Старт +1 жизнь за уровень',
      upgMagnetD: 'Радиус магнита +1 за уровень',
      upgDurationD: 'Эффекты дольше +40% за уровень',
      upgLuckD: 'Пикапы чаще: интервал спавна −20% за уровень',
      chipsEarn: '+{1} ЧИПОВ ДАННЫХ',
      /* feature T20: daily challenge + seasons (SPEC §20) */
      daily: 'Челлендж дня',
      dailyBest: 'Сегодня: {1}',
      dailyRecord: 'РЕКОРД ДНЯ: {1}',
      dMirror: 'ЗЕРКАЛО',
      dIce: 'ЛЁД',
      dCream: 'СЛИВОК',
      dDark: 'ТЕМНОТА',
      dHunt: 'ОХОТА',
      dMirrorD: 'управление наоборот',
      dIceD: 'всё в замедлении',
      dCreamD: 'еда ×2 очков, но рост вдвое',
      dDarkD: 'видно только у головы',
      dHuntD: 'тайны чаще, вирусы злее',
      seasonBadge: 'СЕЗОН: {1}',
      /* feature T21: volume sliders + first-runs tutorial (SPEC §21) */
      volMusic: 'МУЗЫКА',
      volSfx: 'ЗВУКИ',
      tutMove: 'СТРЕЛКИ — ДВИЖЕНИЕ',
      tutMoveTouch: 'СВАЙП — ДВИЖЕНИЕ',
      tutFood: 'ЕДА РАСТЁТ',
      tutDanger: 'БЕЛЫЕ ВСПЫШКИ = ОПАСНОСТЬ',
      tutLife: '❤ — ЗАПАСНАЯ ЖИЗНЬ',
      /* feature T23: online duel (SPEC §22) */
      dRoundScore: 'ВЫ {1} : {2} СОПЕРНИК',
      dEat: 'СОПЕРНИК СЪЕДЕН!',
      dTrapped: 'ЗАКОЛЬЦОВАН!',
      dHead: 'ЛОБ-В-ЛОБ',
      dCrash: 'АВАРИЯ!',
      dWin: 'ПОБЕДА!',
      dLose: 'ПОРАЖЕНИЕ',
      dDraw: 'НИЧЬЯ',
      dLeft: 'СОПЕРНИК ПОКИНУЛ БОЙ',
      dReady: 'БОЙ!',
      /* feature T24: the duel lobby + result screen (SPEC §22) */
      duel: 'ОНЛАЙН-БОЙ',
      duelTitle: 'ОНЛАЙН-БОЙ',
      duelCreate: 'СОЗДАТЬ БОЙ',
      duelJoin: 'ВОЙТИ ПО КОДУ',
      duelCode: 'КОД КОМНАТЫ',
      duelWait: 'ждём соперника…',
      duelInvite: 'БИЙ МЕНЯ В NEON://SNAKE!',
      duelInviteBtn: 'ПОВЗВАТЬ В БОЙ',
      duelCopy: 'КОПИРОВАТЬ ССЫЛКУ',
      duelCopied: 'СКОПИРОВАНО',
      duelGo: 'В БОЙ',
      duelHost: 'ХОСТ',
      duelGuest: 'ГОСТЬ',
      duelRematch: 'РЕВАНШ',
      duelWaitRematch: 'ждём соперника…',
      duelExit: 'ВЫЙТИ',
      duelResultWin: 'ПОБЕДА!',
      duelResultLoss: 'ПОРАЖЕНИЕ',
      duelResultDraw: 'НИЧЬЯ',
      duelResultLeft: 'СОПЕРНИК ПОКИНУЛ',
      duelErrNoNet: 'НЕТ СЕТИ ИЛИ ОБЛАКО НЕДОСТУПНО',
      duelErrFull: 'КОМНАТА ЗАНЯТА',
      duelErrNone: 'КОМНАТА НЕ НАЙДЕНА — ПРОВЕРЬТЕ КОД',
      duelErrTimeout: 'НЕ УДАЛОСЬ СОЕДИНИТЬСЯ',
      /* feature T25: local duel history (battles screen, streak, brag) */
      battles: 'МОИ БОИ',
      battlesTitle: 'МОИ БОИ',
      battlesWins: 'ПОБЕДЫ: {1}',
      battlesLosses: 'ПОРАЖЕНИЯ: {1}',
      battlesStreak: 'СЕРИЯ: {1}',
      battlesEmpty: 'ПОКА ПУСТО',
      battleW: 'ПОБЕДА',
      battleL: 'ПОРАЖЕНИЕ',
      battleD: 'НИЧЬЯ',
      duelBrag: 'Я разбил {1} в NEON://SNAKE! Побьёшь?',
      duelBragBtn: 'ХВАСТАТЬСЯ',
      duelStreakBadge: '🔥 {1} ПОДРЯД'
    },
    en: {
      langTitle: 'SELECT LANGUAGE',
      subtitle: 'cyberprotocol v2.077',
      play: 'Play',
      controls: 'Controls',
      back: 'Back',
      hudScore: 'Score',
      hudBest: 'Best',
      hudLevel: 'Level',
      pauseBtn: 'Pause',
      soundOn: 'Sound: on',
      soundOff: 'Sound: off',
      bestLabel: 'Best:',
      hintMenu: 'Enter — start · M — sound',
      hintPause: 'Space — resume',
      hintRestart: 'Enter — restart',
      pauseTitle: 'PAUSED',
      resume: 'Resume',
      toMenu: 'Menu',
      gameOverTitle: 'GAME OVER',
      restart: 'Restart',
      controlsTitle: 'CONTROLS',
      ctlColAction: 'Action',
      ctlColKeys: 'Keys',
      ctlColTouch: 'Touch',
      ctlDirection: 'Direction',
      ctlDirKeys: 'Arrows and WASD',
      ctlDirTouch: '4-way swipes',
      ctlPause: 'Pause',
      ctlPauseKeys: 'Space or Esc',
      ctlPauseTouch: 'Pause button in the HUD',
      ctlStart: 'Start / restart',
      ctlStartKeys: 'Enter or click the field',
      ctlStartTouch: '"Play" / "Restart" buttons',
      ctlSound: 'Sound on/off',
      ctlSoundKeys: 'M',
      ctlSoundTouch: 'Sound button in the HUD',
      toastConnect: 'CONNECTING TO THE NET...',
      toastLevel: 'LEVEL {1}',
      toastBossDown: 'BOSS DESTROYED',
      hintBoss: 'EAT THE GREEN CHARGE TO DAMAGE THE BOSS',
      bossWarn: '⚠ BOSS: ',
      boss1: 'NET WARDEN',
      boss2: 'VIRUS QUEEN',
      boss3: 'OMEGA ALGORITHM',
      boss4: 'DECOMPILER',
      boss5: 'HUNTER TURRET',
      boss6: 'THE DEVOURER',
      boss7: 'CRYOGEN',
      boss8: 'SYS ADMIN',
      pVirus: 'INFECTION: −50',
      pGolden: '+150 DATA',
      pSurge: 'POWER SURGE!',
      pSlow: 'TIME DILATION',
      pMagnet: 'MAGNET ON',
      pLife: '+1 LIFE',
      pFreeze: 'FROZEN',
      respawnToast: 'SYSTEM REBOOT...',
      livesLabel: 'Lives',
      /* feature T11: mystery containers + tail bank (SPEC §14) */
      mJackpot: 'JACKPOT +500',
      mDouble: '×2 SCORE 10S',
      mTurbo: 'TURBO! ×2 SPEED',
      mLifeRe: '+1 LIFE',
      mReverse: 'CONTROLS REVERSED!',
      mSplit: 'SPLIT! CATCH THE CORES!',
      mDeath: 'FATAL ERROR',
      bankToast: 'TAIL → +{1} POINTS',
      bankInterest: 'DEPOSIT INTEREST +50',
      /* feature T10: leaderboard (SPEC §13) */
      board: 'Leaders',
      boardTitle: 'LEADERS',
      boardClear: 'Clear',
      boardSure: 'Sure?',
      boardEmpty: 'EMPTY YET',
      /* feature T14: global leaderboard mode badges */
      boardGlobal: 'GLOBAL',
      boardLocal: 'OFFLINE · LOCAL TOP',
      boardLoading: 'LOADING…',
      savePrompt: 'TOP-10! NAME:',
      save: 'Save',
      colPlace: '#',
      colName: 'NAME',
      colScore: 'SCORE',
      colLvl: 'LVL',
      colDate: 'DATE',
      /* feature T15: Telegram share (SPEC §15) */
      share: 'Share',
      shareText: 'My NEON://SNAKE score: {1} 🐍 Beat it!',
      /* feature T16: achievements (SPEC §16) */
      ach: 'Achievements',
      achTitle: 'ACHIEVEMENTS',
      achOf: '{1} of {2}',
      achFirstMeal: 'First packet',
      achBoss1: 'First boss',
      achBoss5: 'Boss bane',
      achLvl5: 'Warming up',
      achLvl10: 'Pro',
      achScore1000: 'First thousand',
      achScore2500: 'Data mogul',
      achJackpot: 'Jackpot!',
      achJackpot3: 'Lucky three',
      achCores: 'Core catcher',
      achBanker: 'Banker',
      achMystery10: 'Mystery master',
      achSurvivor: 'Survivor',
      aFirstMeal: 'First meal',
      aBoss1: 'First boss down',
      aBoss5: '5 bosses total',
      aLvl5: 'Level 5',
      aLvl10: 'Level 10',
      aScore1000: '1000 points',
      aScore2500: '2500 points',
      aJackpot: 'Jackpot!',
      aJackpot3: '3 jackpots total',
      aCores: 'Caught both split cores',
      aBanker: 'Banked 8+ segments',
      aMystery10: '10 mysteries total',
      aSurvivor: 'Burned all 3 lives',
      /* feature T17: skins (SPEC §17) */
      skins: 'Skins',
      skinsTitle: 'SKINS',
      skinNeon: 'Neon',
      skinIce: 'Ice',
      skinToxic: 'Toxic',
      skinMagma: 'Magma',
      skinGold: 'Gold',
      skinRainbow: 'Rainbow',
      skinGhost: 'Ghost',
      skinCondIce: 'Defeat your first boss',
      skinCondToxic: 'Reach level 10',
      skinCondMagma: 'Score 2500 points',
      skinCondGold: 'Bank 8+ segments at once',
      skinCondRainbow: 'Defeat 5 bosses',
      skinCondGhost: 'Open 10 mysteries',
      /* feature T19: meta-progression upgrades (SPEC §19) */
      upg: 'Upgrades',
      upgTitle: 'UPGRADES',
      upgChips: '◈ {1}',
      upgBuy: 'Buy',
      upgMax: 'MAX',
      upgLife: 'Life',
      upgMagnet: 'Magnet',
      upgDuration: 'Duration',
      upgLuck: 'Luck',
      upgLifeD: '+1 start life per level',
      upgMagnetD: 'Magnet radius +1 per level',
      upgDurationD: 'Effects last +40% longer per level',
      upgLuckD: 'Pickups more often: spawn interval −20% per level',
      chipsEarn: '+{1} DATA CHIPS',
      /* feature T20: daily challenge + seasons (SPEC §20) */
      daily: 'Daily challenge',
      dailyBest: 'Today: {1}',
      dailyRecord: 'DAY RECORD: {1}',
      dMirror: 'MIRROR',
      dIce: 'ICE',
      dCream: 'CREAM',
      dDark: 'DARKNESS',
      dHunt: 'HUNT',
      dMirrorD: 'controls reversed',
      dIceD: 'everything slowed',
      dCreamD: 'food ×2 points, double growth',
      dDarkD: 'you only see near the head',
      dHuntD: 'more mysteries, meaner viruses',
      seasonBadge: 'SEASON: {1}',
      /* feature T21: volume sliders + first-runs tutorial (SPEC §21) */
      volMusic: 'MUSIC',
      volSfx: 'SFX',
      tutMove: 'ARROWS TO MOVE',
      tutMoveTouch: 'SWIPE TO MOVE',
      tutFood: 'FOOD MAKES YOU GROW',
      tutDanger: 'WHITE FLASHES = DANGER',
      tutLife: '❤ — SPARE LIFE',
      /* feature T23: online duel (SPEC §22) */
      dRoundScore: 'YOU {1} : {2} RIVAL',
      dEat: 'RIVAL DEVOURED!',
      dTrapped: 'TRAPPED!',
      dHead: 'HEAD-ON',
      dCrash: 'CRASHED!',
      dWin: 'VICTORY!',
      dLose: 'DEFEAT',
      dDraw: 'DRAW',
      dLeft: 'RIVAL LEFT THE DUEL',
      dReady: 'FIGHT!',
      /* feature T24: the duel lobby + result screen (SPEC §22) */
      duel: 'ONLINE DUEL',
      duelTitle: 'ONLINE DUEL',
      duelCreate: 'CREATE A DUEL',
      duelJoin: 'JOIN BY CODE',
      duelCode: 'ROOM CODE',
      duelWait: 'waiting for a rival…',
      duelInvite: 'FIGHT ME IN NEON://SNAKE!',
      duelInviteBtn: 'INVITE TO A DUEL',
      duelCopy: 'COPY LINK',
      duelCopied: 'COPIED',
      duelGo: 'FIGHT',
      duelHost: 'HOST',
      duelGuest: 'GUEST',
      duelRematch: 'REMATCH',
      duelWaitRematch: 'waiting for a rival…',
      duelExit: 'EXIT',
      duelResultWin: 'VICTORY!',
      duelResultLoss: 'DEFEAT',
      duelResultDraw: 'DRAW',
      duelResultLeft: 'RIVAL LEFT',
      duelErrNoNet: 'NO NETWORK OR THE CLOUD IS UNREACHABLE',
      duelErrFull: 'ROOM IS FULL',
      duelErrNone: 'ROOM NOT FOUND — CHECK THE CODE',
      duelErrTimeout: 'COULD NOT CONNECT',
      /* feature T25: local duel history (battles screen, streak, brag) */
      battles: 'MY BATTLES',
      battlesTitle: 'MY BATTLES',
      battlesWins: 'WINS: {1}',
      battlesLosses: 'LOSSES: {1}',
      battlesStreak: 'STREAK: {1}',
      battlesEmpty: 'EMPTY YET',
      battleW: 'WIN',
      battleL: 'LOSS',
      battleD: 'DRAW',
      duelBrag: 'I crushed {1} in NEON://SNAKE! Beat me!',
      duelBragBtn: 'BRAG',
      duelStreakBadge: '🔥 {1} IN A ROW'
    }
  };

  const listeners = [];
  let lang = loadLang();

  /* ---------- persistence ---------- */

  function loadLang() {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved && DICT[saved]) return saved;
    } catch (e) {
      /* storage unavailable: keep the default */
    }
    return DEFAULT_LANG;
  }

  function saveLang() {
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      /* storage unavailable: the choice lives until reload */
    }
  }

  /* ---------- DOM application ---------- */

  function applyDom() {
    if (!document || typeof document.querySelectorAll !== 'function') return;
    const nodes = document.querySelectorAll('[data-i18n]');
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].textContent = CS.I18N.t(nodes[i].getAttribute('data-i18n'));
    }
    const titled = document.querySelectorAll('[data-i18n-title]');
    for (let i = 0; i < titled.length; i++) {
      titled[i].setAttribute('title', CS.I18N.t(titled[i].getAttribute('data-i18n-title')));
    }
    if (document.documentElement && typeof document.documentElement.setAttribute === 'function') {
      document.documentElement.setAttribute('lang', lang);
    }
  }

  function notify() {
    const snapshot = listeners.slice();
    for (let i = 0; i < snapshot.length; i++) {
      const cb = snapshot[i];
      if (typeof cb !== 'function') continue;
      try { cb(lang); } catch (e) { /* a broken listener must not break the switch */ }
    }
  }

  CS.I18N = {
    /* current language code: 'ru' | 'en' */
    get: function () {
      return lang;
    },

    /* switch the language, persist it, re-apply data-i18n texts,
       update <html lang> and fire the onChange callbacks */
    set: function (code) {
      lang = DICT[code] ? code : DEFAULT_LANG;
      saveLang();
      applyDom();
      notify();
    },

    /* translate a key with an optional '{1}' substitution;
       unknown keys/languages never throw — ru (then the key) is used */
    t: function (key, arg) {
      const table = DICT[lang] || DICT[DEFAULT_LANG];
      const fallback = DICT[DEFAULT_LANG];
      let text;
      if (Object.prototype.hasOwnProperty.call(table, key)) text = table[key];
      else if (Object.prototype.hasOwnProperty.call(fallback, key)) text = fallback[key];
      else return String(key);
      if (arg !== undefined && arg !== null) {
        text = String(text).replace('{1}', String(arg));
      }
      return String(text);
    },

    /* register a callback fired on every set() */
    onChange: function (cb) {
      if (typeof cb === 'function') listeners.push(cb);
    }
  };

  /* apply the saved language to the markup as soon as it is parsed
     (this script loads first, so this init runs before ui/game) */
  function init() {
    applyDom();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
