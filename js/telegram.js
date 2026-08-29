/* ============================================================
   NEON://SNAKE — Telegram Mini App wrapper (feature T15, SPEC §15)
   CS.TG: thin, always-safe helpers over window.Telegram.WebApp.
   Outside Telegram (the official SDK failed to load, file:// or
   offline) window.Telegram is absent and every method degrades
   into a silent no-op — no exceptions ever escape this module.
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  const SHARE_BASE = 'https://t.me/share/url?url=';
  const APP_LINK = 'https://t.me/windspsnake_bot/snake';
  const CLICK_THROTTLE_MS = 150;   // min pause between 'click' pulses

  let lastClickAt = -CLICK_THROTTLE_MS; // haptic('click') throttle clock

  function webApp() {
    try {
      return (window.Telegram && window.Telegram.WebApp) || null;
    } catch (e) {
      return null;
    }
  }

  function isTelegram() {
    try {
      return !!window.Telegram;
    } catch (e) {
      return false;
    }
  }

  /* Telegram.WebApp.ready() + expand() (moved here from CS.Game.boot).
     Also tags <body> with 'in-telegram' so the .tg-only elements
     (the gameover share button) appear inside the Mini App only. */
  function init() {
    try {
      if (isTelegram() && document.body && document.body.classList &&
        typeof document.body.classList.add === 'function') {
        document.body.classList.add('in-telegram');
      }
      const wa = webApp();
      if (wa && typeof wa.ready === 'function') wa.ready();
      if (wa && typeof wa.expand === 'function') wa.expand();
    } catch (e) {
      /* not inside Telegram: nothing to bootstrap */
    }
  }

  /* kind: 'error' | 'success' | 'warning' | 'click' | 'heavy';
     unknown kinds are ignored, 'click' fires at most every 150 ms */
  function haptic(kind) {
    try {
      const wa = webApp();
      if (!wa || !wa.HapticFeedback) return;
      const hf = wa.HapticFeedback;
      if (kind === 'error' || kind === 'success' || kind === 'warning') {
        if (typeof hf.notificationOccurred === 'function') {
          hf.notificationOccurred(kind);
        }
      } else if (kind === 'click') {
        const now = Date.now();
        if (now - lastClickAt < CLICK_THROTTLE_MS) return;
        lastClickAt = now;
        if (typeof hf.selectionChanged === 'function') hf.selectionChanged();
      } else if (kind === 'heavy') {
        if (typeof hf.impactOccurred === 'function') {
          hf.impactOccurred('heavy');
        }
      }
    } catch (e) {
      /* haptics must never break the game */
    }
  }

  /* Open t.me/share/url with the localized share text ('{1}' = score)
     and the mini-app link; via WebApp.openTelegramLink inside the
     Mini App, a plain window.open everywhere else */
  function shareScore(score) {
    try {
      const text = CS.I18N && typeof CS.I18N.t === 'function'
        ? CS.I18N.t('shareText', score)
        : String(score);
      openShare(SHARE_BASE + encodeURIComponent(APP_LINK) +
        '&text=' + encodeURIComponent(text));
    } catch (e) {
      /* sharing is optional: ignore any failure */
    }
  }

  /* feature T24 (SPEC §22): share an arbitrary link with an arbitrary
     text — the duel invite carries the room deep link instead of the
     plain app link */
  function shareLink(link, text) {
    try {
      openShare(SHARE_BASE + encodeURIComponent(String(link)) +
        '&text=' + encodeURIComponent(String(text)));
    } catch (e) {
      /* sharing is optional: ignore any failure */
    }
  }

  /* the single share door: the Telegram bridge inside the Mini App,
     a new tab everywhere else */
  function openShare(url) {
    const wa = webApp();
    if (wa && typeof wa.openTelegramLink === 'function') {
      wa.openTelegramLink(url);
      return;
    }
    window.open(url, '_blank');
  }

  CS.TG = {
    init: init,
    haptic: haptic,
    shareScore: shareScore,
    shareLink: shareLink,
    isTelegram: isTelegram
  };
})();
