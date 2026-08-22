# NEON://SNAKE

> 🇷🇺 Киберпанк-змейка с боссами, тайнами и синт-саундтреком — прямо в браузере, без установки.
> 🇬🇧 A cyberpunk snake game with bosses, mystery boxes and a synthwave soundtrack — right in your browser.

**[▶ Играть онлайн / Play online](https://windsp85.github.io/cyber-snake/)** · или скачайте репозиторий и откройте `index.html` двойным кликом / or clone and double-click `index.html`.

---

## 🇷🇺 Описание (Русский)

Аркадная змейка в эстетике киберпанка: неоновая арена, глитч-эффекты, полностью синтезированный дарк-синтвейв и **восемь боссов** с уникальными механиками. Игра адаптируется под любое устройство: определяет разрешение экрана и подстраивает размер арены, в вертикальном режиме телефона появляются большие кнопки управления внизу экрана.

### Возможности

- 🌍 **Выбор языка** при входе: русский / English — весь интерфейс, подсказки и имена боссов.
- 📱 **Адаптивная арена**: плотность игры постоянна (~600 клеток), а пропорции подстраиваются под экран — от 30×20 на десктопе до вертикального поля на телефоне. Раскладка мобильная: счёт вверху, поле в середине, кнопки прижаты к низу.
- 🎮 **Удобное управление**: стрелки и WASD (любая раскладка), свайпы, экранные кнопки в портрете; буфер ввода — быстрые повороты «уголком» не теряются.
- 🍎 **Пикапы**: ❤ жизнь (респавн вместо смерти), ⚡ скачок (×1.6 скорость, ×2 очки), 🧲 магнит (сам собирает еду), ❄ замедление, золотой пакет (+150), ☠ вирус (**−50 очков** — счёт умеет падать).
- ❓ **Контейнеры-тайны**: что внутри — неизвестно: джекпот +500, ×2 очки, турбо, жизнь, **реверс управления**, **распад змейки** (лови сбежавшие ядра!), или мгновенная смерть.
- 🏦 **Хранилище хвоста**: периодический портал конвертирует отросший хвост в очки (+15 × уровень за сегмент) — вечный рост больше не приговор.
- 👾 **8 боссов** каждые 3 уровня (далее — усиленные mk-версии): лазеры, файрволы, рывки, рассекающий луч с разрезанием змейки, снаряды и мины, босс-пожиратель хвоста, заморозка, дроны-антивирусы.
- 🏆 **Таблица лидеров**: локальный топ-10 с именами и датами; при рекорде — предложение сохранить результат (интерфейс готов к глобальному серверу).
- 🎵 **Живой звук**: музыка и 20+ эффектов синтезируются в реальном времени (Web Audio API): меню 84 BPM, игра 100 BPM, боевой режим 128 BPM с дисторшн-басом.
- ✨ **Эффекты**: частицы, тряска, глитчи, CRT-сканлайны, всплывающий «−1» урона над боссом.
- 🏅 **Достижения** (13) и **скины змейки** (7: неон, лёд, токсин, магма, золото, радуга, призрак) — открываются за подвиги.
- ◈ **Мета-прогресс**: чипы данных за забеги → 4 апгрейда (жизни, магнит, длительность, удача).
- 📅 **Челлендж дня**: 5 модификаторов по сиду даты (зеркало, лёд, сливок, темнота, охота) + сезонная глобальная таблица лидеров.
- 📳 **Telegram**: виброотклик, кнопка «поделиться рекордом», полноэкранный запуск; **8 боссов с уникальными моделями** (глаз-октаэдр, корона, куб-матрица, пила, турель, пасть, кристаллы, монитор).
- 🔊 Раздельные ползунки громкости, обучение первых забегов, автопроверка двуязычия (check-i18n.js).

### Управление

| Действие | Клавиши | Тач |
|---|---|---|
| Направление | Стрелки **и** WASD | Свайпы или экранные кнопки |
| Пауза | Space или Esc | Кнопка паузы |
| Старт / рестарт | Enter | Кнопки «Играть» / «Заново» |
| Звук | M | Кнопка звука |

### Запуск

Откройте `index.html` в любом современном браузере — интернет и установка не нужны. Для Telegram: `@windspsnake_bot` → мини-приложение «snake».

### Стек

Vanilla JS (классические скрипты без сборки), **Canvas 2D** (интерполяция, devicePixelRatio, адаптивная сетка), **Web Audio API** (16-шаговый секвенсор, ля-минор). Ноль внешних зависимостей, офлайн-first.

---

## 🇬🇧 English

An arcade snake in cyberpunk aesthetics: neon grid, glitch effects, a fully synthesized dark-synthwave soundtrack and **eight bosses** with unique mechanics. The game adapts to any device: it detects the screen resolution and adjusts the arena, showing big on-screen controls at the bottom in phone portrait.

### Features

- 🌍 **Language selection** on entry: Russian / English — the whole UI, hints and boss names.
- 📱 **Adaptive arena**: constant game density (~600 cells), proportions follow the screen — 30×20 on desktop, a vertical field on phones. Mobile layout: score on top, field in the middle, buttons pinned to the bottom.
- 🎮 **Comfortable controls**: arrows and WASD (any layout), swipes, on-screen buttons in portrait; input buffer keeps fast corner turns.
- 🍎 **Pickups**: ❤ extra life (respawn instead of death), ⚡ surge, 🧲 magnet, ❄ time dilation, golden packet (+150), ☠ virus (**−50 points** — the score can drop).
- ❓ **Mystery containers**: jackpot +500, ×2 score, turbo, life, **reversed controls**, **snake split** (catch the escaped cores!), or instant death.
- 🏦 **Tail bank**: a periodic portal converts your grown tail into points (+15 × level per segment).
- 👾 **8 bosses** every 3rd level (then stronger mk-versions): lasers, firewalls, dashes, a cutting beam that slices the snake, projectiles and mines, a tail-devouring boss, freeze waves, antivirus drones.
- 🏆 **Leaderboard**: local top-10 with names and dates; server-ready interface.
- 🎵 **Live sound**: music and 20+ SFX synthesized in real time (Web Audio API).
- ✨ **Juice**: particles, screen shake, glitches, CRT scanlines, floating «−1» damage markers.

### Run

Open `index.html` in any modern browser — no internet or installation required. Telegram: `@windspsnake_bot` → «snake» mini app.

---

## Лицензия / License

© 2026 **WindSP85** · All rights reserved / Все права защищены.

См. [LICENSE](LICENSE). Копирование, изменение и распространение кода без письменного разрешения автора не допускается.
See [LICENSE](LICENSE). Copying, modification and distribution of this code without the author's written permission is not allowed.

## Автор / Author

**WindSP85** — [github.com/WindSP85](https://github.com/WindSP85)
