/* ============================================================
   NEON://SNAKE — online duel renderer + netcode (T23, SPEC §22)
   CS.Duel lives inside game.js as the 'duel' state: the main rAF
   loop keeps running, but its update/render branch into this
   module while a match is live. The solo game states are never
   touched by duel code.

   НЕТКОД v2 — серверная авторитарность + стандарты быстрых
   сетевых игр (подход Quake/Source/Overwatch, адаптированный
   под клеточную змейку):
   - СЕРВЕР считает матч (server/duel-core.js): столкновения,
     укусы, западни, раунды — истина только там. Оба клиента —
     равноправные рендереры снапшотов 16/с.
   - INSTANT INPUT: свой поворот применяется на следующем ЛОКАЛЬНОМ
     тике (отклик без сетевого круга — «как в соло», SPEC §27.2).
   - SEQUENCED INPUTS + ACK: каждый вход нумеруется (seq) и
     помечается тиком применения; снапшот подтверждает его (sq).
   - RECONCILIATION (rewind & replay): от авторитарного состояния
     на тике tk реплеятся ТОЛЬКО неподтверждённые входы до
     текущего локального тика. Вход, пришедший серверу вовремя,
     применяется там ровно на том же тике — реплей совпадает с
     предсказанием в ноль коррекций.
   - ERROR BLENDING: расхождение (джиттер, поздний вход, еда)
     превращается в экспоненциально гаснущее визуальное смещение —
     никаких телепортов «фантомной» змейки.
   - ENTITY INTERPOLATION: соперник рисуется интерполяцией буфера
     снапшотов на отложенном адаптивном таймлайне (джиттер-буфер):
     сеть колышется — движение нет.
   - RATE SYNC: локальный тиковый таймлайн опережает серверный на
     oneWay+1 тиков и мягко подстраивается (±15%) — предсказание
     не уезжает и не отстаёт.
   - STARVATION: снапшотов нет >0.6 с — таймлайн замирает (без
     дикой экстраполяции), связь вернулась — плавный догон.

   Round rules (SPEC §22, sacred — решает СЕРВЕР):
   - wall / own body              -> round to the rival
   - head into the rival's body   -> BITE: the rival is cut, the
     dropped segments become food, the biter rides through 0.4 s;
     fewer than 3 segments left -> DEVOURED
   - head-on (same cell / swap)   -> the longer snake wins,
     equal lengths -> round draw
   - TRAPPED: flood fill from the head < length + 5 -> round to
     the encircler with a 1 s slow-mo
   Match: best of 3 rounds, first to 2 wins.

   Public surface (game.js + the T24 ui):
     CS.Duel.init({cell, grid, hooks})        — game.js injection
     CS.Duel.begin({host?, myIndex, onMatchEnd}) — start a match
       (host — легаси-поле: симуляция всегда на сервере)
     CS.Duel.stop()                           — teardown anytime
     CS.Duel.active()                         — is a match live
     CS.Duel.update(dt) / draw(g)             — 'duel' branches
     CS.Duel.input(dir)                       — steer MY snake
     CS.Duel.state()                          — live debug view
   ============================================================ */
(function () {
  'use strict';

  const CS = window.CS = window.CS || {};

  /* ---------- tuning (SPEC §22) ---------- */

  const TICK_RATE = 9.5;          // shared ticks per second (x1.15 fix)
  const TICK_STEP = 1 / TICK_RATE; // seconds per simulation tick
  const START_LEN = 5;            // snake length at a round start
  const START_X0 = 0.15;          // opposite thirds of the arena
  const START_X1 = 0.85;
  const TURN_BUFFER = 3;          // как буфер ввода соло (SPEC §2):
                                  // быстрые «уголки» не теряются
  const COUNTDOWN_TIME = 3;       // 3-2-1 phase, s
  const ROUNDEND_TIME = 2.5;      // round result banner, s
  const FOOD_STANDING = 2;        // packets on the field, always
  const FOOD_GROW = 2;            // segments gained per packet
  const TRAP_SLOWMO = 1;          // slow-mo length, s (visual)
  const TRAP_SLOW_FACTOR = 0.2;   // banner/phase slowdown while trapped
  const STATE_TIMEOUT = 10;       // rival-drop threshold, s — больше
                                  // серверного грейса (8 c): обрыв
                                  // лечится переподключением
  const TICK_GUARD = 6;           // max ticks per update frame
  /* неткод v2 */
  const INPUT_LOG_MAX = 64;       // своя история входов (реплей)
  const SNAP_BUF_MAX = 12;        // снапшотов соперника в буфере
  const STARVE_AFTER = 0.6;       // с такой тишиной таймлайн замирает, s
  const RESYNC_JUMP = 2;          // тиков пропуска после тишины: прыжок
  const LEAD_DEFAULT = 2.5;       // стартовое опережение сервера, тиков
  const LEAD_MIN = 1.5;
  const LEAD_MAX = 5;
  const RATE_K = 0.25;            // gain регулятора темпа
  const RATE_MIN = 0.85;
  const RATE_MAX = 1.15;
  const DELAY_MIN = 0.8;          // интерполяционная задержка, тиков
  const DELAY_MAX = 6;
  const DELAY_TARGET = 1.25;      // соперник отстаёт от последнего tk
  const DELAY_SPEED = 2;          // тиков/с — скорость адаптации
  const ERR_DECAY = 0.12;         // базовая постоянная гашения, s
  const ERR_CAP = 14;              // потолок смещения на сегмент, клеток
  const SNAP_CELLS = 18;          // катастрофа (в среднем на сегмент) — прыжок
  const PING_WINDOW = 15;         // окно оценки one-way, снапшотов

  const DIR = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };
  const DIR_NAMES = ['up', 'down', 'left', 'right'];
  const DIR_LIST = [DIR.up, DIR.down, DIR.left, DIR.right];

  const BG = '#04050c';
  const GRID_LINE = 'rgba(0,240,255,.07)';
  const RIVAL_HEAD = [255, 122, 0];   // #ff7a00
  const RIVAL_TAIL = [255, 45, 85];   // #ff2d55
  const RIVAL_GLOW = '#ff7a00';
  const MY_GLOW = '#00f0ff';

  /* ---------- injected config (game.js) ---------- */

  let cfg = null;        // {cell, grid(), hooks{resize}} — see init()
  let CELL = 30;

  /* ---------- state ---------- */

  /* дефолт арены — от серверного ядра (index.html грузит duel-core
     раньше): fallback-числа только для отдельного sandbox-запуска */
  let GW = (CS.DuelCore && CS.DuelCore.GRID_W) || 42;
  let GH = (CS.DuelCore && CS.DuelCore.GRID_H) || 28;
  let live = false;            // a match is running
  let myIndex = 0;             // my snake side (server 'start')
  let foeIndex = 1;
  let onMatchEndCb = null;

  let phase = 'idle';          // countdown|fight|roundEnd|matchEnd
  let phaseTimer = 0;
  let round = 1;
  let score = [0, 0];
  let roundWinner = null;      // 0|1|-1 once a round resolved
  let matchEnded = false;
  let snakes = [];             // авторитарные змейки из снапшотов
  let food = [];               // авторитарная еда из снапшота
  let animTime = 0;
  let slowmo = 0;              // TRAP_SLOWMO seconds remaining (visual)
  let banner = null;           // {key,t,total,color}
  let rivalName = '';          // T27b: shown above the rival's head
  let fightTime = 0;           // T27b: seconds since the fight began
  let guestLastCount = -1;     // countdown beeps
  let guestEvents = { bite: 0, trap: 0, eat: 0, round: 0 };
  let netBound = false;
  let snapAge = 0;             // секунд с последнего снапшота: и
                              // голодание, и таймаут ухода соперника

  /* ---------- неткод v2 ---------- */

  let clock = { tick: 0, acc: 0, rate: 1, run: false }; // локальный таймлайн
  let pred = null;             // предсказание СВОЕЙ змейки (fight)
  let inputSeq = 0;            // счётчик своих входов
  let inputLog = [];           // [{seq, tick, dirName}] — для реплея
  let snapBuf = [];            // соперник: [{tk, pts[{x,y}], dir}] по tk
  let arenaInfo = null;        // снапшотное {k,s,e} секрета арены
  let lastTk = -1;             // tk последнего применённого снапшота
  let mySq = 0;                // последний подтверждённый seq
  let delayTicks = LEAD_DEFAULT; // интерполяционная задержка, тиков
  let offRows = [];            // гаснущие визуальные смещения [{x,y}]
  let offMag = 0;              // QA: суммарная величина смещения
  let pingMs = 0;              // оценка RTT по меткам времени
  let pingKnown = false;
  let offSamples = [];         // arrive−st, окно для минимума

  /* ---------- helpers ---------- */

  function tr(key, a, b) {
    let s = key;
    try {
      if (CS.I18N && typeof CS.I18N.t === 'function') s = CS.I18N.t(key, a);
    } catch (e) {
      s = key;
    }
    if (b !== undefined) s = String(s).replace('{2}', String(b));
    return s;
  }

  function sfx(name) {
    try {
      if (CS.Audio && typeof CS.Audio.sfx === 'function') CS.Audio.sfx(name);
    } catch (e) { /* headless: silence */ }
  }

  function fx(name, a, b, c, d) {
    try {
      const f = CS.FX && CS.FX[name];
      if (typeof f === 'function') f.call(CS.FX, a, b, c, d);
    } catch (e) { /* headless: silence */ }
  }

  function haptic(kind) {
    try {
      if (CS.TG && typeof CS.TG.haptic === 'function') CS.TG.haptic(kind);
    } catch (e) { /* outside Telegram: silence */ }
  }

  function netSend(type, data) {
    try {
      return !!(CS.Net && typeof CS.Net.send === 'function' && CS.Net.send(type, data));
    } catch (e) {
      return false;
    }
  }

  function colorStr(rgb) {
    return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
  }

  /* the rival's fixed orange->red body blend */
  function rivalColor(i, n) {
    const k = n <= 1 ? 0 : i / (n - 1);
    return colorStr([
      Math.round(RIVAL_HEAD[0] + (RIVAL_TAIL[0] - RIVAL_HEAD[0]) * k),
      Math.round(RIVAL_HEAD[1] + (RIVAL_TAIL[1] - RIVAL_HEAD[1]) * k),
      Math.round(RIVAL_HEAD[2] + (RIVAL_TAIL[2] - RIVAL_HEAD[2]) * k)
    ]);
  }

  /* my snake always wears the active skin (feature T17) */
  function myColor(i, n) {
    try {
      if (CS.Skins && typeof CS.Skins.colors === 'function') {
        return CS.Skins.colors(i, n, animTime);
      }
    } catch (e) { /* fall through to the neon default */ }
    return i === 0 ? '#00f0ff' : '#ff2bd6';
  }

  function sideColor(side, i, n) {
    return side === myIndex ? myColor(i, n) : rivalColor(i, n);
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* accepts a vector {x,y}, a name 'up'... or 0..3 */
  function normDir(d) {
    if (typeof d === 'string' && DIR[d]) return DIR[d];
    if (typeof d === 'number' && DIR_LIST[d]) return DIR_LIST[d];
    if (d && typeof d === 'object' && Number.isFinite(d.x) && Number.isFinite(d.y)) {
      for (let k = 0; k < 4; k++) {
        if (DIR_LIST[k].x === d.x && DIR_LIST[k].y === d.y) return DIR_LIST[k];
      }
    }
    return null;
  }

  function dirName(d) {
    for (let k = 0; k < 4; k++) {
      if (DIR_LIST[k].x === d.x && DIR_LIST[k].y === d.y) return DIR_NAMES[k];
    }
    return 'up';
  }

  function dirIndex(d) {
    for (let k = 0; k < 4; k++) {
      if (DIR_LIST[k].x === d.x && DIR_LIST[k].y === d.y) return k;
    }
    return 0;
  }

  /* ---------- snakes ---------- */

  function makeSnake(headX, headY, dir, len) {
    const segs = [];
    for (let i = 0; i < len; i++) {
      const x = headX - dir.x * i;
      const y = headY - dir.y * i;
      segs.push({ prev: { x: x, y: y }, curr: { x: x, y: y } });
    }
    return { segs: segs, dir: dir, queue: [], growth: 0, pass: 0 };
  }

  /* буфер поворотов — точное зеркало серверного (duel-core.js):
     FIFO до 3, повторы/развороты игнорируются, переполнение
     выталкивает старый (новый важнее) */
  function queueTurn(s, d) {
    const last = s.queue.length ? s.queue[s.queue.length - 1] : s.dir;
    if (d.x === last.x && d.y === last.y) return;
    if (d.x === -last.x && d.y === -last.y) return;
    if (s.queue.length >= TURN_BUFFER) s.queue.shift();
    s.queue.push(d);
  }

  function takeTurn(s) {
    while (s.queue.length) {
      const d = s.queue.shift();
      if (d.x === -s.dir.x && d.y === -s.dir.y) continue;
      if (d.x === s.dir.x && d.y === s.dir.y) continue;
      s.dir = d;
      break;
    }
  }

  function moveSnake(s, c) {
    const last = s.segs.length - 1;
    const oldTailX = s.segs[last].curr.x;
    const oldTailY = s.segs[last].curr.y;
    for (let i = last; i > 0; i--) {
      const sg = s.segs[i];
      const ahead = s.segs[i - 1].curr;
      sg.prev.x = sg.curr.x;
      sg.prev.y = sg.curr.y;
      sg.curr.x = ahead.x;
      sg.curr.y = ahead.y;
    }
    const h = s.segs[0];
    h.prev.x = h.curr.x;
    h.prev.y = h.curr.y;
    h.curr.x = c.x;
    h.curr.y = c.y;
    if (s.growth > 0) {
      s.growth--;
      s.segs.push({
        prev: { x: oldTailX, y: oldTailY },
        curr: { x: oldTailX, y: oldTailY }
      });
    }
  }

  function cloneSnake(s) {
    const segs = [];
    for (let i = 0; i < s.segs.length; i++) {
      segs.push({
        prev: { x: s.segs[i].prev.x, y: s.segs[i].prev.y },
        curr: { x: s.segs[i].curr.x, y: s.segs[i].curr.y }
      });
    }
    return { segs: segs, dir: s.dir, queue: [], growth: s.growth, pass: s.pass };
  }

  /* интерполированная позиция сегмента i на доле тика t */
  function segAt(s, i, t) {
    const sg = s.segs[Math.min(Math.max(i, 0), s.segs.length - 1)];
    return {
      x: sg.prev.x + (sg.curr.x - sg.prev.x) * t,
      y: sg.prev.y + (sg.curr.y - sg.prev.y) * t
    };
  }

  /* совпадает ли логика двух змеек (позиции/длина/направление) */
  function snakeSame(a, b) {
    if (!a || !b || a.segs.length !== b.segs.length) return false;
    if (a.dir !== b.dir && (a.dir.x !== b.dir.x || a.dir.y !== b.dir.y)) return false;
    for (let i = 0; i < a.segs.length; i++) {
      if (a.segs[i].curr.x !== b.segs[i].curr.x ||
          a.segs[i].curr.y !== b.segs[i].curr.y) return false;
    }
    return true;
  }

  /* ---------- food (локальный превью до первого снапшота) ---------- */

  function occupiedSet() {
    const occ = {};
    for (let i = 0; i < 2; i++) {
      if (!snakes[i]) continue;
      const segs = snakes[i].segs;
      for (let k = 0; k < segs.length; k++) occ[idx(segs[k].curr.x, segs[k].curr.y)] = 1;
    }
    for (let i = 0; i < food.length; i++) occ[idx(food[i].x, food[i].y)] = 1;
    return occ;
  }

  function spawnFood() {
    const occ = occupiedSet();
    const free = [];
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        if (!occ[idx(x, y)]) free.push(idx(x, y));
      }
    }
    if (!free.length) return;
    const c = free[Math.floor(Math.random() * free.length)];
    food.push({ x: c % GW, y: Math.floor(c / GW) });
  }

  function maintainFood() {
    while (food.length < FOOD_STANDING) {
      const before = food.length;
      spawnFood();
      if (food.length === before) break; // no room at all
    }
  }

  /* ---------- неткод v2: таймлайн, предсказание, реплей ---------- */

  function idx(x, y) { return y * GW + x; }

  /* СЕКРЕТ АРЕНЫ (SPEC §14/§22): зеркало серверной маски duel-core.js —
     математика 1:1, менять только парой. Тиковая детерминированность =
     точное предсказание; для РЕНДЕРА тик дробный (плавная граница) */
  const ARENA_IN_TICKS = 16;
  const ARENA_OUT_TICKS = 10;

  function arenaK(tick) {
    if (!arenaInfo || tick <= arenaInfo.s || tick >= arenaInfo.e) return 0;
    if (tick < arenaInfo.s + ARENA_IN_TICKS) return (tick - arenaInfo.s) / ARENA_IN_TICKS;
    if (tick > arenaInfo.e - ARENA_OUT_TICKS) return (arenaInfo.e - tick) / ARENA_OUT_TICKS;
    return 1;
  }

  function arenaOkC(x, y, tick) {
    if (!arenaInfo) return true;
    const k = arenaK(tick);
    if (k <= 0) return true;
    const px = x + 0.5, py = y + 0.5;
    const cx = GW / 2, cy = GH / 2;
    if (arenaInfo.k === 'circle') {
      const rFull = Math.sqrt(cx * cx + cy * cy);
      const r = rFull - (rFull - Math.max(cx, cy) * 0.74) * k;
      const dx = px - cx, dy = py - cy;
      return dx * dx + dy * dy <= r * r;
    }
    const m = Math.min(GW, GH) * 0.12 *
      Math.sin((tick - arenaInfo.s) / (arenaInfo.e - arenaInfo.s) * Math.PI);
    return px > m && px < GW - m && py > m && py < GH - m;
  }

  /* опережение сервера: oneWay + 1 тик — вход, отправленный сейчас,
     успевает к тику своего применения (см. шапку) */
  function leadTarget() {
    if (!pingKnown) return LEAD_DEFAULT;
    const oneWayTicks = (pingMs / 2 / 1000) / TICK_STEP;
    return Math.max(LEAD_MIN, Math.min(LEAD_MAX, oneWayTicks + 1));
  }

  /* локальный тик предсказания: чистое движение своей змейки + еда;
     столкновения/укусы/раунды — только сервер */
  function predTick() {
    if (!pred || !pred.segs.length) return;
    takeTurn(pred);
    const h = pred.segs[0];
    const nx = h.curr.x + pred.dir.x;
    const ny = h.curr.y + pred.dir.y;
    if (nx < 0 || nx >= GW || ny < 0 || ny >= GH || !arenaOkC(nx, ny, clock.tick)) {
      // стена (граница или секрет-арена) — вердикт за сервером:
      // предсказание замирает у края
      return;
    }
    moveSnake(pred, { x: nx, y: ny });
    for (let i = food.length - 1; i >= 0; i--) {
      if (food[i].x === nx && food[i].y === ny) {
        food.splice(i, 1);
        pred.growth += FOOD_GROW;
        fx('burst', nx * CELL + CELL / 2, ny * CELL + CELL / 2, '#ff2bd6', 7);
        sfx('eat');
        haptic('click');
      }
    }
  }

  /* RECONCILIATION: реплей неподтверждённых входов от авторитарного
     состояния (тик tk) до текущего локального тика. Еда — из ТОГО ЖЕ
     снапшота (локальный список уже потрёб predicted-съеданиями —
     реплей обязан повторить путь сервера, а не клиента). Совпало —
     не трогаем змейку (якоря интерполяции живут). Расхождение —
     новая логика + гаснущее визуальное смещение вместо телепорта */
  function reconcile(tk, sq, snapFood) {
    if (sq > mySq) mySq = sq;
    // подтверждённые входы больше не нужны
    while (inputLog.length && inputLog[0].seq <= mySq) inputLog.shift();

    const base = snakes[myIndex];
    if (!base) return;
    const sim = cloneSnake(base);

    const unacked = [];
    for (let i = 0; i < inputLog.length; i++) {
      if (inputLog[i].seq > mySq) unacked.push(inputLog[i]);
    }
    const simFood = (snapFood || food).slice();
    let qi = 0;
    for (let t = tk + 1; t <= clock.tick; t++) {
      while (qi < unacked.length && unacked[qi].tick <= t) {
        queueTurn(sim, DIR[unacked[qi].dir] || sim.dir);
        qi++;
      }
      takeTurn(sim);
      const h = sim.segs[0];
      const nx = h.curr.x + sim.dir.x;
      const ny = h.curr.y + sim.dir.y;
      if (nx < 0 || nx >= GW || ny < 0 || ny >= GH || !arenaOkC(nx, ny, t)) break;
      moveSnake(sim, { x: nx, y: ny });
      for (let i = simFood.length - 1; i >= 0; i--) {
        if (simFood[i].x === nx && simFood[i].y === ny) {
          simFood.splice(i, 1);
          sim.growth += FOOD_GROW;
        }
      }
    }
    /* входы с тегом БУДУЩИХ тиков реплей не затронул — вернём их в
       очередь: замена pred не имеет права терять ещё не применённые
       повороты (иначе живое предсказание пропускает ход) */
    for (; qi < unacked.length; qi++) {
      queueTurn(sim, DIR[unacked[qi].dir] || sim.dir);
    }

    if (snakeSame(pred, sim)) {
      pred.growth = sim.growth; // рост мог уточниться — позиции те же
      pred.dir = sim.dir;
      pred.pass = sim.pass;
      return;
    }

    /* расхождение: смещение от ОТРИСОВАННОЙ позиции к новой логике */
    const start = rowsBetween(pred, sim);
    pred = sim;
    /* порог прыжка — в среднем НА СЕГМЕНТ (mag — сумма по всем) */
    offRows = start.mag > SNAP_CELLS * Math.max(1, start.n) ? [] : start.rows;
    offMag = offRows.length ? start.mag : 0;
  }

  /* векторы смещения от ОТОБРАЖАЕМОЙ позы a (логика + ещё не погашенное
     смещение!) к позе b — цепляем визуальный долг, иначе каждая
    -refresh-коррекция роняла бы его и давала прыжок */
  function rowsBetween(a, b) {
    const t = Math.min(1, clock.acc / TICK_STEP);
    const rows = [];
    const n = Math.max(a.segs.length, b.segs.length);
    let mag = 0;
    for (let i = 0; i < n; i++) {
      const pa = segAt(a, i, t);
      const off = offRows[i];
      const ax = pa.x + (off ? off.x : 0);
      const ay = pa.y + (off ? off.y : 0);
      const pb = segAt(b, i, t);
      let dx = ax - pb.x;
      let dy = ay - pb.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > ERR_CAP) {
        const s = ERR_CAP / len;
        dx *= s;
        dy *= s;
      }
      mag += Math.abs(dx) + Math.abs(dy);
      rows.push({ x: dx, y: dy });
    }
    return { rows: rows, mag: mag, n: n };
  }

  /* экспоненциальное гашение визуального смещения; темп — по
     СРЕДНЕЙ величине на сегмент: большой догон после тишины гасится
     дольше — змейка видимо ускоряется к правде, а не телепортируется */
  function decayOff(dt) {
    if (!offRows.length) return;
    let mag = 0;
    for (let i = 0; i < offRows.length; i++) {
      mag += Math.abs(offRows[i].x) + Math.abs(offRows[i].y);
    }
    const avg = mag / Math.max(1, offRows.length);
    const tau = ERR_DECAY * (1 + Math.min(3, avg / 4));
    const k = Math.exp(-dt / tau);
    mag = 0;
    for (let i = 0; i < offRows.length; i++) {
      offRows[i].x *= k;
      offRows[i].y *= k;
      mag += Math.abs(offRows[i].x) + Math.abs(offRows[i].y);
    }
    if (mag < 0.05) {
      offRows = [];
      mag = 0;
    }
    offMag = mag;
  }

  /* буфер снапшотов соперника: вставка/замена по tk, сортировка */
  function upsertFoeSnap(tk) {
    const s = snakes[foeIndex];
    if (!s || !s.segs.length) return;
    const pts = [];
    for (let i = 0; i < s.segs.length; i++) {
      pts.push({ x: s.segs[i].curr.x, y: s.segs[i].curr.y });
    }
    const entry = { tk: tk, pts: pts, dir: dirIndex(s.dir) };
    for (let i = 0; i < snapBuf.length; i++) {
      if (snapBuf[i].tk === tk) {
        snapBuf[i] = entry;
        return;
      }
      if (snapBuf[i].tk > tk) {
        snapBuf.splice(i, 0, entry);
        break;
      }
      if (i === snapBuf.length - 1) {
        snapBuf.push(entry);
        break;
      }
    }
    if (!snapBuf.length) snapBuf.push(entry);
    while (snapBuf.length > SNAP_BUF_MAX) snapBuf.shift();
    const cut = lastTk - SNAP_BUF_MAX;
    while (snapBuf.length && snapBuf[0].tk < cut) snapBuf.shift();
  }

  /* ---------- networking ---------- */

  function ensureNet() {
    if (netBound) return;
    netBound = true;
    try {
      if (CS.Net && typeof CS.Net.onMessage === 'function') {
        CS.Net.onMessage(onNetMsg);
      }
    } catch (e) {
      /* no transport: offline preview only */
    }
  }

  function onNetMsg(type, data) {
    if (!live) return;
    if (type === 'state') applySnapshot(data);
    else if (type === 'round') applyRoundMsg(data);
    else if (type === 'win') applyWinMsg(data);
  }

  function unpackSnake(flat, growth) {
    const segs = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const x = flat[i];
      const y = flat[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      segs.push({
        prev: { x: x, y: y },
        curr: { x: x, y: y }
      });
    }
    if (!segs.length) return null;
    return {
      segs: segs, dir: DIR.right, queue: [],
      growth: Number.isFinite(growth) ? growth : 0, pass: 0
    };
  }

  /* новый раунд: таймлайн и история входов начинаются с чистого
     листа (сервер тоже сбрасывает тики и подтверждения) */
  function resetRoundNet() {
    pred = null;
    clock = { tick: 0, acc: 0, rate: 1, run: false };
    inputLog = [];
    snapBuf = [];
    lastTk = -1;
    mySq = 0;
    offRows = [];
    offMag = 0;
    arenaInfo = null; // новый раунд — арена с чистого листа
  }

  function applySnapshot(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.sn)) return;
    snapAge = 0;
    const arrive = Date.now();
    const prevPhase = phase;

    /* оценка one-way: смещение часов = arrive − st; минимум за окно
       ≈ чистая задержка пересылки; пинг = 2 × one-way (T27.3) */
    if (Number.isFinite(d.st)) {
      offSamples.push(arrive - d.st);
      if (offSamples.length > PING_WINDOW) offSamples.shift();
      let mn = offSamples[0];
      for (let i = 1; i < offSamples.length; i++) {
        if (offSamples[i] < mn) mn = offSamples[i];
      }
      const oneWay = Math.max(0, (arrive - d.st) - mn);
      const rtt = 2 * oneWay;
      pingMs = pingKnown ? pingMs * 0.8 + rtt * 0.2 : rtt;
      pingKnown = true;
    }

    /* авторитарные змейки */
    for (let i = 0; i < 2; i++) {
      const s = unpackSnake(d.sn[i], d.g ? d.g[i] : 0);
      if (s) {
        const di = d.d && Number.isFinite(d.d[i]) ? Math.max(0, Math.min(3, d.d[i])) : 0;
        s.dir = DIR_LIST[di];
        /* p — авторитарный таймер «щита» прохода сквозь тело (SPEC §22):
           локально только затухает, обновляется снапшотом */
        const pv = d.p && Number.isFinite(d.p[i]) ? d.p[i] : 0;
        s.pass = Math.max(pv, snakes[i] ? snakes[i].pass : 0);
        snakes[i] = s;
      }
    }
    food = [];
    if (Array.isArray(d.f)) {
      for (let i = 0; i < d.f.length; i++) {
        const c = d.f[i];
        if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
          food.push({ x: c[0], y: c[1] });
        }
      }
    }
    if (Array.isArray(d.s) && Number.isFinite(d.s[0]) && Number.isFinite(d.s[1])) {
      score = [d.s[0], d.s[1]];
    }
    if (Number.isFinite(d.r)) round = d.r;
    roundWinner = Number.isFinite(d.w) ? d.w : null;
    phase = typeof d.ph === 'string' ? d.ph : phase;
    if (Number.isFinite(d.pt)) phaseTimer = d.pt;
    /* секрет арены: снапшот — единственный источник правды */
    arenaInfo = (d.ar && typeof d.ar.k === 'string' &&
      Number.isFinite(d.ar.s) && Number.isFinite(d.ar.e))
      ? { k: d.ar.k === 'circle' ? 'circle' : 'pulse', s: d.ar.s, e: d.ar.e }
      : null;

    /* вход в отсчёт (новый раунд): сетевой таймлайн с чистого листа.
       Только на ПЕРЕХОДЕ — повороты, нажатые во время отсчёта,
       не должны стираться следующим countdown-снапшотом */
    if (phase === 'countdown' && prevPhase !== 'countdown') resetRoundNet();
    if (phase === 'fight' && prevPhase !== 'fight') fightTime = 0; // T27b

    /* local countdown beeps + the fight tone */
    if (phase === 'countdown') {
      const n = Math.max(0, Math.ceil(phaseTimer));
      if (n !== guestLastCount) {
        guestLastCount = n;
        if (n > 0) sfx('duelCount');
      }
    } else {
      guestLastCount = -1;
    }
    if (phase === 'fight' && prevPhase !== 'fight') {
      setBanner('dReady', 0.8, '#00ff9d');
      sfx('duelGo');
    }

    /* banner mirror */
    if (typeof d.k === 'string' && d.k) {
      const t = Number.isFinite(d.kt) ? d.kt : 1;
      if (!banner || banner.key !== d.k || banner.t < t) {
        setBanner(d.k, Math.max(t, 0.3), typeof d.kc === 'string' ? d.kc : '#00f0ff');
      }
    }

    /* event mirrors: fire local fx/sfx once per counter bump */
    if (Array.isArray(d.ev)) {
      const ev = {
        bite: d.ev[0] | 0,
        trap: d.ev[1] | 0,
        eat: d.ev[2] | 0,
        round: d.ev[3] | 0
      };
      if (ev.bite > guestEvents.bite) {
        guestEvents.bite = ev.bite;
        fx('glitch', 0.2);
        fx('shake', 5);
        sfx('duelBite');
      }
      if (ev.trap > guestEvents.trap) {
        guestEvents.trap = ev.trap;
        slowmo = TRAP_SLOWMO;
        fx('flash', '#ff2d55', 0.18);
        sfx('duelTrap');
      }
      if (ev.round > guestEvents.round) guestEvents.round = ev.round;
      if (ev.eat > guestEvents.eat) guestEvents.eat = ev.eat;
    }

    /* неткод v2: тики, буфер соперника, reconciliation */
    const tk = Number.isFinite(d.tk) ? (d.tk | 0) : -1;
    if (tk < 0) return;

    if (phase === 'fight') {
      if (!pred) {
        /* первый боевой снапшот раунда: таймлайн стартует СРАЗУ с
           положенным опережением сервера (lead) — иначе полторы
           секунды догонa делают каждый вход опоздавшим; входы,
           нажатые во время отсчёта, реплей применит на тике 1 */
        clock.tick = tk + Math.round(leadTarget());
        clock.acc = 0;
        clock.rate = 1;
        clock.run = true;
        pred = cloneSnake(snakes[myIndex]);
        lastTk = tk;
        upsertFoeSnap(tk);
        reconcile(tk, Array.isArray(d.sq) ? d.sq[myIndex] : 0, food);
        return;
      }
      if (tk < lastTk) return; // устаревший снапшот (после бёрста)
      lastTk = tk;
      upsertFoeSnap(tk);
      if (!clock.run && tk - clock.tick > RESYNC_JUMP) {
        /* вернулись после долгой тишины: сервер ушёл далеко —
           перезапускаем таймлайн у его настоящего тика (с опережением);
           pred НЕ трогаем — reconcile посчитает смещение от показанной
           позиции и плавно догонит (без телепорта) */
        clock.tick = tk + Math.round(leadTarget());
        clock.acc = 0;
      }
      clock.run = true;
      reconcile(tk, Array.isArray(d.sq) ? d.sq[myIndex] : 0, food);
    } else {
      lastTk = Math.max(lastTk, tk);
      upsertFoeSnap(tk);
    }
  }

  function applyRoundMsg(d) {
    if (!d || typeof d !== 'object') return;
    if (Array.isArray(d.s) && Number.isFinite(d.s[0]) && Number.isFinite(d.s[1])) {
      score = [d.s[0], d.s[1]];
    }
    roundWinner = Number.isFinite(d.w) ? d.w : null;
    phase = 'roundEnd';
    clock.run = false;
    if (typeof d.k === 'string' && d.k) {
      setBanner(d.k, ROUNDEND_TIME + 0.6,
        d.w === -1 || d.w === null || d.w === undefined ? '#ffe600' : sideColor(d.w, 0, 1));
    }
  }

  function applyWinMsg(d) {
    if (!d || typeof d !== 'object' || matchEnded) return;
    if (Array.isArray(d.s) && Number.isFinite(d.s[0]) && Number.isFinite(d.s[1])) {
      score = [d.s[0], d.s[1]];
    }
    const winner = Number.isFinite(d.side) ? d.side : -1;
    phase = 'matchEnd';
    clock.run = false;
    const result = winner === -1 ? 'draw' : (winner === myIndex ? 'win' : 'loss');
    setBanner(result === 'win' ? 'dWin' : (result === 'loss' ? 'dLose' : 'dDraw'), 999,
      result === 'win' ? '#00ff9d' : (result === 'loss' ? '#ff2d55' : '#ffe600'));
    sfx(result === 'win' ? 'duelWin' : 'duelLose');
    finishMatch(result);
  }

  /* ---------- match flow ---------- */

  /* локальный превью-старт: фазы рисуются сразу, первый же снапшот
     привозит авторитарную истину */
  function startRound() {
    const y = Math.floor(GH / 2);
    const x0 = Math.max(START_LEN, Math.min(GW - START_LEN - 1, Math.round(GW * START_X0)));
    const x1 = Math.max(START_LEN, Math.min(GW - START_LEN - 1, Math.round(GW * START_X1)));
    snakes = [
      makeSnake(x0, y, DIR.right, START_LEN),
      makeSnake(x1, y, DIR.left, START_LEN)
    ];
    food = [];
    maintainFood();
    resetRoundNet();
    roundWinner = null;
    phase = 'countdown';
    phaseTimer = COUNTDOWN_TIME;
  }

  function finishMatch(result) {
    if (matchEnded) return;
    matchEnded = true;
    if (typeof onMatchEndCb === 'function') {
      try {
        onMatchEndCb({ result: result, score: [score[0], score[1]] });
      } catch (e) {
        /* the caller's callback is the caller's problem */
      }
    }
  }

  /* нет снапшотов STATE_TIMEOUT секунд — соперник ушёл */
  function rivalLeft() {
    if (phase === 'matchEnd') return;
    phase = 'matchEnd';
    clock.run = false;
    setBanner('dLeft', 999, '#ff2d55');
    sfx('duelLose');
    fx('glitch', 0.4);
    finishMatch('aborted');
  }

  function setBanner(key, t, color) {
    banner = { key: key, t: t, total: t, color: color || '#00f0ff' };
  }

  /* ---------- update ---------- */

  function update(dt) {
    animTime += dt;
    if (banner) {
      banner.t -= dt;
      if (banner.t <= 0) banner = null;
    }
    for (let i = 0; i < 2; i++) {
      if (snakes[i] && snakes[i].pass > 0) {
        snakes[i].pass = Math.max(0, snakes[i].pass - dt);
      }
    }
    if (pred && pred.pass > 0) pred.pass = Math.max(0, pred.pass - dt);
    const slow = slowmo > 0 ? TRAP_SLOW_FACTOR : 1;
    if (slowmo > 0) slowmo = Math.max(0, slowmo - dt);
    snapAge += dt;

    /* тишина транспорта = соперник ушёл (presence — задача T24 ui) */
    if (live && phase !== 'matchEnd' && snapAge > STATE_TIMEOUT) rivalLeft();

    if (phase === 'countdown') {
      /* бипы отсчёта — только из applySnapshot (guestLastCount):
         локальный дубль звучал дважды каждую секунду */
      phaseTimer -= dt;
      if (phaseTimer <= 0) {
        phase = 'fight';
        phaseTimer = 0;
        fightTime = 0;
        setBanner('dReady', 0.8, '#00ff9d');
        sfx('duelGo');
      }
    } else if (phase === 'fight') {
      fightTime += dt; // T27b: identity label timings

      /* неткод v2: голодание — таймлайн замирает, чтобы после
         бёрста снапшотов не лететь наперёд вслепую */
      if (snapAge > STARVE_AFTER) clock.run = false;

      if (clock.run && pred) {
        clock.acc += dt * clock.rate;
        let guard = TICK_GUARD;
        while (clock.acc >= TICK_STEP && guard-- > 0 && phase === 'fight') {
          clock.acc -= TICK_STEP;
          clock.tick++;
          predTick();
        }
        if (clock.acc >= TICK_STEP) clock.acc = 0; // dt-спайк не копим

        /* rate sync: локальный тик держит опережение leadTarget() над
           ТЕКУЩИМ тиком сервера. Оценка сервера обязана учитывать
           транзит снапшота (lastTk был истинен oneWay назад) — иначе
           пила snapAge между доставками раскачивает регулятор, lead
           схлопывается и входы опаздывают к своим тикам */
        const oneWay = pingKnown ? pingMs / 2000 : 0.07;
        const estSrv = lastTk + (snapAge + oneWay) / TICK_STEP;
        const err = (clock.tick + clock.acc / TICK_STEP) - estSrv - leadTarget();
        clock.rate = Math.max(RATE_MIN, Math.min(RATE_MAX, 1 - err * RATE_K));

        /* адаптивная задержка интерполяции соперника: рендер-тик
           отстаёт от последнего авторитарного на ~DELAY_TARGET */
        const clockFloat = clock.tick + clock.acc / TICK_STEP;
        const desired = clockFloat - (lastTk - DELAY_TARGET);
        const dstep = Math.max(-DELAY_SPEED * dt, Math.min(DELAY_SPEED * dt, desired - delayTicks));
        delayTicks = Math.max(DELAY_MIN, Math.min(DELAY_MAX, delayTicks + dstep));
      }

      decayOff(dt);
    } else if (phase === 'roundEnd') {
      phaseTimer -= dt * slow;
    }
  }

  /* ---------- арена: рендер-маска (SPEC §14) ---------- */

  /* контур маски на ДРОБНОМ тике (рендертаймлайн) — плавная граница */
  function arenaPathD(g, tickF) {
    if (!arenaInfo) return false;
    const k = arenaK(tickF);
    if (k <= 0.01) return false;
    const W = GW * CELL, H = GH * CELL;
    const cx = W / 2, cy = H / 2;
    const ccx = GW / 2, ccy = GH / 2;
    g.beginPath();
    if (arenaInfo.k === 'circle') {
      const rFull = Math.sqrt(ccx * ccx + ccy * ccy);
      const r = (rFull - (rFull - Math.max(ccx, ccy) * 0.74) * k) * CELL;
      g.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
    } else {
      const m = Math.min(GW, GH) * 0.12 *
        Math.sin((tickF - arenaInfo.s) / (arenaInfo.e - arenaInfo.s) * Math.PI) * CELL;
      g.rect(m, m, W - m * 2, H - m * 2);
    }
    return true;
  }

  function arenaStrokeD(g, tickF) {
    if (!arenaPathD(g, tickF)) return;
    g.save();
    g.strokeStyle = '#00f0ff';
    g.lineWidth = 2;
    g.shadowColor = '#00f0ff';
    g.shadowBlur = 14;
    g.stroke();
    g.restore();
  }

  /* телеграф: до старта маски — пульсирующий контур БУДУЩЕЙ границы */
  function arenaTelegraph(g, tickF) {
    if (!arenaInfo || tickF >= arenaInfo.s || tickF < arenaInfo.s - 14) return;
    const W = GW * CELL, H = GH * CELL;
    const cx = W / 2, cy = H / 2;
    const ccx = GW / 2, ccy = GH / 2;
    const a = 0.18 + 0.22 * (0.5 + 0.5 * Math.sin(tickF * 2.2));
    g.save();
    g.globalAlpha = a;
    g.strokeStyle = '#ffe600';
    g.lineWidth = 2;
    g.setLineDash([10, 8]);
    g.beginPath();
    if (arenaInfo.k === 'circle') {
      const rFull = Math.sqrt(ccx * ccx + ccy * ccy);
      const r = (rFull - (rFull - Math.max(ccx, ccy) * 0.74)) * CELL;
      g.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
    } else {
      const m = Math.min(GW, GH) * 0.12 * CELL;
      g.rect(m, m, W - m * 2, H - m * 2);
    }
    g.stroke();
    g.restore();
  }

  /* ---------- отрисовка поз (неткод v2) ---------- */

  /* своя змейка: предсказание + гаснущее смещение расхождения */
  function myPose() {
    const s = pred || snakes[myIndex];
    if (!s || !s.segs.length) return null;
    const t = phase === 'fight' ? Math.min(1, clock.acc / TICK_STEP) : 1;
    const pts = [];
    for (let i = 0; i < s.segs.length; i++) {
      const p = segAt(s, i, t);
      const off = offRows[i];
      pts.push(off ? { x: p.x + off.x, y: p.y + off.y } : p);
    }
    return { pts: pts, dir: s.dir, pass: s.pass };
  }

  /* соперник: интерполяция буфера снапшотов на отложенном таймлайне;
     вне боя — статичная авторитарная поза */
  function rivalPose() {
    const s = snakes[foeIndex];
    if (!s || !s.segs.length) return null;
    if (phase !== 'fight' || snapBuf.length === 0) {
      const pts = [];
      for (let i = 0; i < s.segs.length; i++) {
        pts.push({ x: s.segs[i].curr.x, y: s.segs[i].curr.y });
      }
      return { pts: pts, dir: s.dir, pass: s.pass };
    }
    /* страховка: рендер-тик никогда не заглядывает за последний
       авторитарный тик (иначе пришлось бы рисовать будущее) */
    let rt = clock.tick + clock.acc / TICK_STEP - delayTicks;
    if (lastTk >= 0) rt = Math.min(rt, lastTk - 0.02);
    let a = snapBuf[0];
    let b = null;
    for (let i = 0; i < snapBuf.length; i++) {
      if (snapBuf[i].tk <= rt) a = snapBuf[i];
      else { b = snapBuf[i]; break; }
    }
    const span = b ? Math.max(1, b.tk - a.tk) : 1;
    const u = b ? Math.max(0, Math.min(1, (rt - a.tk) / span)) : 1;
    const n = Math.max(a.pts.length, b ? b.pts.length : 0);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const pa = a.pts[Math.min(i, a.pts.length - 1)];
      const pb = b ? b.pts[Math.min(i, b.pts.length - 1)] : pa;
      pts.push({ x: pa.x + (pb.x - pa.x) * u, y: pa.y + (pb.y - pa.y) * u });
    }
    return { pts: pts, dir: DIR_LIST[b ? b.dir : a.dir], pass: s.pass };
  }

  function sidePose(side) {
    return side === myIndex ? myPose() : rivalPose();
  }

  /* ---------- drawing ---------- */

  /* PERF: the arena background (grid + the two-color frame) is baked
     once per grid/dpr into an offscreen canvas and blitted with a
     single drawImage — no per-frame strokes, no shadowBlur */
  let arenaCache = null;            // offscreen grid + frame
  let arenaCacheKey = '';           // GW|GH|dpr signature

  function drawArena(g) {
    const W = GW * CELL;
    const H = GH * CELL;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const sig = GW + '|' + GH + '|' + dpr;
    if (sig !== arenaCacheKey) {
      arenaCache = null;
      arenaCacheKey = '';
      if (typeof document !== 'undefined' && document.createElement) {
        const cv = document.createElement('canvas');
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
        const c = cv.getContext('2d');
        if (c) {
          c.setTransform(dpr, 0, 0, dpr, 0, 0);
          c.strokeStyle = GRID_LINE;
          c.lineWidth = 1;
          c.beginPath();
          for (let x = 1; x < GW; x++) {
            c.moveTo(x * CELL + 0.5, 0);
            c.lineTo(x * CELL + 0.5, H);
          }
          for (let y = 1; y < GH; y++) {
            c.moveTo(0, y * CELL + 0.5);
            c.lineTo(W, y * CELL + 0.5);
          }
          c.stroke();
          /* the arena frame: my color vs the rival's orange */
          c.save();
          c.lineWidth = 2;
          c.shadowBlur = 14;
          c.strokeStyle = MY_GLOW;
          c.shadowColor = MY_GLOW;
          c.beginPath();
          c.moveTo(1, 1);
          c.lineTo(W - 1, 1);
          c.stroke();
          c.strokeStyle = RIVAL_GLOW;
          c.shadowColor = RIVAL_GLOW;
          c.beginPath();
          c.moveTo(W - 1, 1);
          c.lineTo(W - 1, H - 1);
          c.lineTo(1, H - 1);
          c.stroke();
          c.restore();
          arenaCache = cv;
          arenaCacheKey = sig;
        }
      }
    }
    if (arenaCache) {
      g.drawImage(arenaCache, 0, 0, W, H); // 1:1 into logical px
      return;
    }
    /* canvasless fallback: the original direct strokes */
    g.strokeStyle = GRID_LINE;
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 1; x < GW; x++) {
      g.moveTo(x * CELL + 0.5, 0);
      g.lineTo(x * CELL + 0.5, H);
    }
    for (let y = 1; y < GH; y++) {
      g.moveTo(0, y * CELL + 0.5);
      g.lineTo(W, y * CELL + 0.5);
    }
    g.stroke();
    g.save();
    g.lineWidth = 2;
    g.shadowBlur = 14;
    g.strokeStyle = MY_GLOW;
    g.shadowColor = MY_GLOW;
    g.beginPath();
    g.moveTo(1, 1);
    g.lineTo(W - 1, 1);
    g.stroke();
    g.strokeStyle = RIVAL_GLOW;
    g.shadowColor = RIVAL_GLOW;
    g.beginPath();
    g.moveTo(W - 1, 1);
    g.lineTo(W - 1, H - 1);
    g.lineTo(1, H - 1);
    g.stroke();
    g.restore();
  }

  /* T27b: during the countdown and the first seconds the players see
     a big «YOU» over their own head and the rival's name over theirs;
     then a small chevron marker fades out by second ten */
  function drawIdentity(g) {
    if (phase !== 'countdown' && phase !== 'fight') return;
    const intro = phase === 'countdown' || fightTime < 3;
    if (!intro && fightTime >= 10) return;
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    for (let side = 0; side < 2; side++) {
      const mine = side === myIndex;
      const pose = sidePose(side);
      if (!pose || !pose.pts.length) continue;
      const x = pose.pts[0].x * CELL + CELL / 2;
      const y = pose.pts[0].y * CELL - 4;
      if (mine) {
        if (intro) {
          g.globalAlpha = 0.75 + 0.25 * Math.sin(animTime * 7);
          g.font = 'bold 15px "Cascadia Mono", Consolas, monospace';
          g.fillStyle = '#ffffff';
          g.shadowColor = MY_GLOW;
          g.shadowBlur = 8;
          g.fillText(tr('duelYou'), x, y);
        } else {
          // 3..10 s: a small chevron pointer
          const a = Math.max(0, 1 - (fightTime - 3) / 7);
          g.globalAlpha = 0.6 * a;
          g.fillStyle = '#ffffff';
          g.beginPath();
          g.moveTo(x, y - 2);
          g.lineTo(x - 5, y - 10);
          g.lineTo(x + 5, y - 10);
          g.closePath();
          g.fill();
        }
      } else if (intro && rivalName) {
        g.globalAlpha = 0.8;
        g.font = '11px "Cascadia Mono", Consolas, monospace';
        g.fillStyle = '#ff9d5c';
        g.shadowColor = RIVAL_GLOW;
        g.shadowBlur = 6;
        g.fillText(rivalName, x, y);
      }
    }
    g.restore();
  }

  /* PERF: food glow = baked sprite stretched over the old blur
     envelope (the solo field does the same in game.js) */
  function drawFoodCells(g) {
    for (let i = 0; i < food.length; i++) {
      const pulse = 0.5 + 0.5 * Math.sin(animTime * 6 + i * 1.9);
      const cx = food[i].x * CELL + CELL / 2;
      const cy = food[i].y * CELL + CELL / 2;
      const s = CELL * (0.5 + 0.1 * pulse);
      const b = 8 + 10 * pulse;
      const gw = 2 * (s / 2 + 1.6 * b);
      if (CS.FX && typeof CS.FX.drawGlow === 'function') {
        CS.FX.drawGlow(g, cx, cy, gw, gw, '#ff2bd6', 13);
      }
      g.save();
      g.translate(cx, cy);
      g.rotate(Math.PI / 4);
      g.fillStyle = '#ff2bd6';
      roundRect(g, -s / 2, -s / 2, s, s, 3);
      g.fill();
      g.fillStyle = '#ffffff';
      g.fillRect(-s * 0.12, -s * 0.12, s * 0.24, s * 0.24);
      g.restore();
    }
  }

  /* T27.3: пинг в углу — зелёный <120, жёлтый <250, красный ≥250 */
  function drawPing(g) {
    if (!pingKnown || phase === 'countdown') return;
    const n = Math.round(pingMs);
    const color = n < 120 ? '#00ff9d' : (n < 250 ? '#ffe600' : '#ff2d55');
    const W = GW * CELL;
    const H = GH * CELL;
    g.save();
    g.font = '11px "Cascadia Mono", Consolas, monospace';
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.globalAlpha = 0.85;
    g.fillStyle = color;
    g.shadowColor = color;
    g.shadowBlur = 6;
    g.fillText(tr('duelPing', n), W - 8, H - 6);
    if (!clock.run) { // голодание: честная плашка
      g.textAlign = 'left';
      g.fillStyle = '#ffe600';
      g.shadowColor = '#ffe600';
      g.fillText(tr('duelNetWait'), 8, H - 6);
    }
    g.restore();
  }

  function drawSnake(g, side) {
    const mine = side === myIndex;
    const pose = sidePose(side);
    if (!pose || !pose.pts.length) return;
    const n = pose.pts.length;
    let skinAlpha = 1;
    if (mine) {
      try {
        if (CS.Skins && typeof CS.Skins.alpha === 'function') skinAlpha = CS.Skins.alpha();
      } catch (e) { skinAlpha = 1; }
    }
    for (let i = n - 1; i >= 0; i--) {
      const x = pose.pts[i].x * CELL;
      const y = pose.pts[i].y * CELL;
      const isHead = i === 0;
      const pad = isHead ? CELL * 0.06 : CELL * 0.07;
      g.save();
      g.fillStyle = sideColor(side, i, n);
      if (pose.pass > 0 && isHead) {
        /* riding through the rival's body: blink like a shield */
        g.globalAlpha = Math.max(0.15, 0.45 + 0.55 * Math.sin(animTime * 14));
      } else if (skinAlpha < 1 && mine) {
        g.globalAlpha = skinAlpha;
      }
      if (isHead) {
        /* PERF: печённый LRU-спрайт вместо shadowBlur (как в соло);
           радуга квантуется в skins.js — кэш не греется */
        const glow = mine ? (CS.Skins && typeof CS.Skins.headGlow === 'function'
          ? CS.Skins.headGlow(animTime) : MY_GLOW) : RIVAL_GLOW;
        CS.FX.drawGlow(g, x + CELL / 2, y + CELL / 2, CELL * 2.6, CELL * 2.6, glow, 16);
      }
      roundRect(g, x + pad, y + pad, CELL - pad * 2, CELL - pad * 2, isHead ? 8 : 6);
      g.fill();
      if (isHead) {
        g.fillStyle = BG;
        const fxp = x + CELL / 2 + pose.dir.x * CELL * 0.16;
        const fyp = y + CELL / 2 + pose.dir.y * CELL * 0.16;
        const px = -pose.dir.y;
        const py = pose.dir.x;
        const off = CELL * 0.15;
        const r = Math.max(2, CELL * 0.08);
        g.beginPath();
        g.arc(fxp + px * off, fyp + py * off, r, 0, Math.PI * 2);
        g.arc(fxp - px * off, fyp - py * off, r, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }
  }

  function bigFont(g, px) {
    g.font = 'bold ' + px + 'px "Cascadia Mono", Consolas, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
  }

  function drawHud(g) {
    const W = GW * CELL;
    g.save();
    bigFont(g, Math.max(18, Math.round(CELL * 0.85)));
    g.shadowColor = '#00f0ff';
    g.shadowBlur = 12;
    g.fillStyle = '#eafcff';
    g.fillText(tr('dRoundScore', score[myIndex], score[foeIndex]), W / 2, CELL * 0.9);
    g.restore();
  }

  function drawBanner(g) {
    const W = GW * CELL;
    const H = GH * CELL;
    if (phase === 'countdown') {
      const n = Math.max(1, Math.ceil(phaseTimer));
      const frac = Math.max(0, Math.min(1, phaseTimer - Math.floor(phaseTimer)));
      g.save();
      bigFont(g, Math.round(CELL * 3));
      g.globalAlpha = 0.35 + 0.65 * frac;
      g.shadowColor = '#00f0ff';
      g.shadowBlur = 24;
      g.fillStyle = '#eafcff';
      g.fillText(String(n), W / 2, H / 2);
      g.restore();
      return;
    }
    if (!banner) return;
    g.save();
    const k = Math.min(1, banner.t / 0.4);   // fade only at the very end
    const pop = banner.total > 10 ? 1 : Math.min(1, (banner.total - banner.t) / 0.12 + 0.4);
    g.globalAlpha = k;
    bigFont(g, Math.round(CELL * 1.4 * pop));
    g.shadowColor = banner.color;
    g.shadowBlur = 18;
    g.fillStyle = banner.color;
    g.fillText(tr(banner.key), W / 2, H / 2);
    g.restore();
  }

  function draw(g) {
    if (!g || !live) return;
    const W = GW * CELL;
    const H = GH * CELL;
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    drawArena(g);
    /* SPEC §14: секрет арены — сцена в клипе маски на отложенном
       рендер-таймлайне (тот же, что у соперника) */
    const tickF = clock.tick + clock.acc / TICK_STEP - delayTicks;
    const arMask = arenaPathD(g, tickF);
    if (arMask) {
      g.save();
      g.clip();
    }
    drawFoodCells(g);
    drawSnake(g, 0);
    drawSnake(g, 1);
    if (arMask) {
      g.restore();
      arenaStrokeD(g, tickF);
    }
    arenaTelegraph(g, tickF);
    drawIdentity(g); // T27b: «YOU» + names during the countdown start
    drawHud(g);
    drawPing(g);     // T27.3: пинг и честная плашка голодания
    drawBanner(g);
  }

  /* ---------- public API ---------- */

  CS.Duel = {
    /* game.js injection: {cell, grid() -> {w,h}, hooks{resize(w,h)}} */
    init: function (options) {
      cfg = options && typeof options === 'object' ? options : null;
      if (cfg && Number.isFinite(cfg.cell) && cfg.cell > 0) CELL = cfg.cell;
    },

    /* {host:bool (легаси: симуляция всегда на сервере, поле
       игнорируется), myIndex:0|1, onMatchEnd(result,score), grid?:
       {w,h} — серверная арена важнее локальной (SPEC: у обоих
       игроков одинаковые размеры) } */
    begin: function (opts) {
      const o = opts || {};
      myIndex = (o.myIndex === 0 || o.myIndex === 1) ? o.myIndex : 0;
      foeIndex = 1 - myIndex;
      onMatchEndCb = typeof o.onMatchEnd === 'function' ? o.onMatchEnd : null;

      const grid = (o.grid && Number.isFinite(o.grid.w) && Number.isFinite(o.grid.h))
        ? o.grid // сервер прислал арену: она одна на всех
        : ((cfg && typeof cfg.grid === 'function') ? cfg.grid() : null);
      if (grid && Number.isFinite(grid.w) && Number.isFinite(grid.h)) {
        GW = Math.max(10, Math.min(60, Math.round(grid.w)));
        GH = Math.max(10, Math.min(60, Math.round(grid.h)));
      }
      if (cfg && cfg.hooks && typeof cfg.hooks.resize === 'function') {
        try { cfg.hooks.resize(GW * CELL, GH * CELL); } catch (e) { /* canvasless */ }
      }

      score = [0, 0];
      round = 1;
      matchEnded = false;
      banner = null;
      slowmo = 0;
      snapAge = 0;
      guestLastCount = -1;
      guestEvents = { bite: 0, trap: 0, eat: 0, round: 0 };
      inputSeq = 0;
      pingMs = 0;
      pingKnown = false;
      offSamples = [];
      delayTicks = LEAD_DEFAULT;
      snakes = [makeSnake(3, 3, DIR.right, 1), makeSnake(6, 3, DIR.left, 1)];
      live = true;
      ensureNet();
      startRound();
    },

    stop: function () {
      live = false;
      phase = 'idle';
      phaseTimer = 0;
      snakes = [];
      food = [];
      banner = null;
      slowmo = 0;
      clock.run = false;
      pred = null;
      onMatchEndCb = null;
    },

    active: function () {
      return live;
    },

    /* feature T24 (SPEC §22): the lobby ui saw the rival's presence
       drop — end the live match as 'aborted' right now (the same
       path as the transport-silence timeout); after a match
       end this is a safe no-op */
    abort: function () {
      if (live) rivalLeft();
    },

    /* T27b: whose snake is whose — set by duelui at the match start */
    setRivalName: function (n) {
      rivalName = String(n || '').slice(0, 20);
    },

    /* steer MY snake: мгновенный локальный отклик + вход с seq/tick
       серверу (там он применяется ровно на том же тике) */
    input: function (d) {
      if (!live) return;
      if (phase !== 'fight' && phase !== 'countdown') return;
      const v = normDir(d);
      if (!v) return;
      inputSeq++;
      const tick = (phase === 'fight' && pred) ? clock.tick + 1 : 1;
      inputLog.push({ seq: inputSeq, tick: tick, dir: dirName(v) });
      if (inputLog.length > INPUT_LOG_MAX) inputLog.shift();
      netSend('turn', { dir: dirName(v), seq: inputSeq, tick: tick });
      if (pred) queueTurn(pred, v); // свой тик — локальный, без сети
    },

    update: update,

    draw: draw,

    /* live debug/QA view (test.html + headless tests) */
    state: function () {
      return {
        live: live,
        host: false, // симуляция на сервере (легаси-поле для UI)
        myIndex: myIndex,
        phase: phase,
        phaseTimer: phaseTimer,
        round: round,
        score: score,
        roundWinner: roundWinner,
        snakes: snakes,
        pred: pred ? (pred.segs[0].curr.x + ',' + pred.segs[0].curr.y) : null, // T27 QA
        food: food,
        banner: banner,
        slowmo: slowmo,
        events: guestEvents,
        grid: { w: GW, h: GH, cell: CELL },
        /* неткод v2 — QA-телеметрия */
        net: {
          myTick: clock.tick,
          tickFrac: clock.acc / TICK_STEP,
          rate: clock.rate,
          running: clock.run,
          lastTk: lastTk,
          sq: mySq,
          seq: inputSeq,
          delayTicks: delayTicks,
          renderTick: Math.min(clock.tick + clock.acc / TICK_STEP - delayTicks,
            lastTk >= 0 ? lastTk - 0.02 : Infinity),
          pingMs: pingMs,
          pingKnown: pingKnown,
          offMag: offMag,
          snapBufLen: snapBuf.length,
          starving: !clock.run && phase === 'fight',
          inputLogLen: inputLog.length,
          arena: arenaInfo ? arenaInfo.k + '@' + arenaInfo.s + '-' + arenaInfo.e : null,
          predDir: pred ? dirName(pred.dir) : null,
          predSegs: pred ? pred.segs.map(function (sg) { return sg.curr.x + ',' + sg.curr.y; }) : null,
          srvSegs: snakes[myIndex] ? snakes[myIndex].segs.map(function (sg) { return sg.curr.x + ',' + sg.curr.y; }) : null,
          dispHead: (function () {
            const p = myPose();
            if (!p || !p.pts.length) return null;
            return (Math.round(p.pts[0].x * 100) / 100) + ',' +
              (Math.round(p.pts[0].y * 100) / 100);
          })()
        }
      };
    }
  };
})();
