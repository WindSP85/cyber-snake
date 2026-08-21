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
      livesLabel: 'Жизни'
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
      livesLabel: 'Lives'
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
