# NEON://SNAKE

> 🇷🇺 Киберпанк-змейка с боссами и синт-саундтреком — прямо в браузере, без установки.
> 🇬🇧 A cyberpunk snake game with bosses and a synthwave soundtrack — right in your browser.

**[▶ Играть онлайн / Play online](https://windsp85.github.io/cyber-snake/)** · или скачайте репозиторий и откройте `index.html` двойным кликом / or clone and double-click `index.html`.

---

## 🇷🇺 Описание (Русский)

Аркадная змейка в эстетике киберпанка: неоновая арена, глитч-эффекты, полностью синтезированный дарк-синтвейв и боссы с уникальными атаками. Без сборки, без CDN, без зависимостей — игра работает офлайн, даже по двойному клику на `index.html`.

### Возможности

- 🎮 **Удобное управление** — стрелки и WASD (на любой раскладке клавиатуры), свайпы на телефоне, буфер ввода на 3 нажатия: быстрые повороты «уголком» не теряются, разворот на 180° заблокирован.
- 🐍 **Плавное движение** — интерполяция между клетками, свечение и градиент змейки от циана к пурпуру.
- 👾 **Боссы каждые 3 уровня** — прицельный лазер, файрволы, таранные рывки через арену; каждый следующий — сильнее.
- 🎵 **Живой звук** — музыка и 12 эффектов синтезируются в реальном времени (Web Audio API): спокойное меню 84 BPM, игра 100 BPM, злой боевой режим 128 BPM с дисторшн-басом.
- 📈 **Прогрессия** — скорость растёт с уровнем, палитра арены меняется (cyan → magenta → yellow → green → orange), бонусы-«фрагменты кода» на время.
- 🏆 **Рекорд** сохраняется между сессиями (localStorage).
- ✨ **Эффекты** — частицы, тряска экрана, глитчи, CRT-сканлайны и виньетка.

### Управление

| Действие | Клавиши | Тач |
|---|---|---|
| Направление | Стрелки **и** WASD | Свайпы в 4 стороны |
| Пауза | Space или Esc | Кнопка «Пауза» в HUD |
| Старт / рестарт | Enter | Кнопки «Играть» / «Заново» |
| Звук вкл/выкл | M | Кнопка звука в HUD |

### Боссы

| Босс | Чем опасен |
|---|---|
| **СТРАЖ СЕТИ** | прицельный лазер по ряду/колонке, файрволы |
| **ВИРУС-КОРОЛЕВА** | + таранные рывки через всю арену |
| **АЛГОРИТМ ОМЕГА** | весь арсенал, быстрее и злее; далее — версии mk.N |

Каждая атака телеграфируется мигающим красным предупреждением. Босс получает урон от зелёных «зарядов данных» на поле. За победу — взрыв, фанфара и +250 × номер босса.

### Запуск

Откройте `index.html` в любом современном браузере (Chrome, Edge, Firefox). Интернет, сервер и установка не нужны.

### Стек

Vanilla JS (классические скрипты, без сборки), **Canvas 2D** (рендер с интерполяцией и devicePixelRatio), **Web Audio API** (16-шаговый секвенсор, ля-минор). Ноль внешних зависимостей.

### Структура

```
index.html      — разметка: канвас, HUD, экраны
css/style.css   — неоновый стиль, CRT-оверлеи, глитч-анимации
js/audio.js     — CS.Audio: синтезированная музыка и SFX
js/bosses.js    — CS.BossFight: боссы, лазер/файрвол/рывок
js/fx.js        — CS.FX: частицы, тряска, глитч, вспышки
js/ui.js        — CS.UI: экраны, HUD, тосты
js/game.js      — CS.Game: ядро — змейка, уровни, ввод, loop
```

---

## 🇬🇧 English

An arcade snake game in cyberpunk aesthetics: neon grid, glitch effects, a fully synthesized dark-synthwave soundtrack and bosses with unique attack patterns. No build step, no CDN, no dependencies — it even runs offline from a double-clicked `index.html`.

### Features

- 🎮 **Comfortable controls** — Arrow keys and WASD (works on any keyboard layout), touch swipes, a 3-input buffer so fast corner turns are never lost; 180° reversals blocked.
- 🐍 **Smooth motion** — sub-cell interpolation, glowing cyan-to-magenta gradient snake.
- 👔 **Bosses every 3rd level** — targeted lasers, firewall blocks, dash attacks across the arena; each boss is stronger than the last.
- 🎵 **Live sound** — music and 12 SFX synthesized in real time (Web Audio API): calm 84 BPM menu, 100 BPM gameplay, a fierce 128 BPM battle theme with a distorted bass.
- 📈 **Progression** — speed scales with level, arena palette cycles, timed bonus pickups.
- 🏆 **High score** persisted in localStorage.
- ✨ **Juice** — particles, screen shake, glitches, CRT scanlines and vignette.

### Controls

| Action | Keys | Touch |
|---|---|---|
| Direction | Arrows **and** WASD | 4-way swipes |
| Pause | Space or Esc | Pause button |
| Start / restart | Enter | «Играть» / «Заново» buttons |
| Mute | M | Sound button |

### Run

Open `index.html` in any modern browser (Chrome, Edge, Firefox). No internet, server or installation required.

### Tech

Vanilla JS (classic scripts, no build), **Canvas 2D** (interpolated rendering, devicePixelRatio-aware), **Web Audio API** (16-step sequencer, A minor). Zero external dependencies.

---

## Лицензия / License

© 2026 **WindSP85** · All rights reserved / Все права защищены.

См. [LICENSE](LICENSE). Копирование, изменение и распространение кода без письменного разрешения автора не допускается.
See [LICENSE](LICENSE). Copying, modification and distribution of this code without the author's written permission is not allowed.

## Автор / Author

**WindSP85** — [github.com/WindSP85](https://github.com/WindSP85)
