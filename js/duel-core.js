/* ============================================================
   NEON://SNAKE — ядро дуэли без интерфейса (SPEC §22, серверная
   симметрия). Один и тот же код крутит матч И на сервере
   (Node, server/server.js — единственный авторитет), И может
   использоваться клиентом для оффлайн-превью: ни DOM, ни канваса,
   ни звуков — только клетки, тики и вердикты.

   Правила раунда (священно, дубликат дуэльного ядра T23):
   - стена / своё тело          -> раунд сопернику
   - голова в тело соперника    -> УКУС: соперник обрезан в точке
     укуса, упавшее становится едой (2 клетки на 3 сегмента,
     округление вверх, максимум 12), кусающий проходит сквозь
     тело 0.4 с; меньше 3 сегментов -> СЪЕДЕН
   - лоб в лоб (одна клетка /   -> побеждает длиннейший,
     обмен клетками за тик)        равные -> ничья раунда
   - ЗАПАДНЯ: флуд-филл от головы по свободным клеткам (еда
     проходима) < длина + 5  -> раунд окружившему
   Матч: до 2 побед из максимум 3 раундов.

   Сетка одна на всех: сервер задаёт GRID_W×GRID_H в 'start',
   оба клиента рендерят идентичную арену.

   НЕТКОД v2 (мировые стандарты быстрых сетевых игр):
   - входы не теряются: буфер поворотов FIFO глубиной 3 (как соло);
   - каждый вход клиента нумеруется (seq) и подтверждается в снапшоте
     (sq) — клиент знает, какие входы уже вшиты в авторитарное состояние;
   - снапшот несёт номер тика tk и серверное время st: клиент строит
     предсказание «вперёд» от авторитарного состояния и реплеит только
     неподтверждённые входы (rewind & replay), а соперника рисует по
     интерполяции снапшотов на отложенном таймлайне (jitter buffer).
   ============================================================ */
(function () {
  'use strict';

  /* ---------- константы (дубль T23, менять только парой) ---------- */

  var TICK_RATE = 9.5;          // тиков симуляции в секунду
  var START_LEN = 5;            // длина змейки на старте раунда
  var START_X0 = 0.15;          // противоположные трети арены
  var START_X1 = 0.85;
  var TURN_BUFFER = 3;          // буфер поворотов: как в соло (SPEC §2) —
                                // два быстрых «уголка» между тиками НЕ
                                // теряются (раньше буфер был 1 и второй
                                // поворот молча затирал первый → вечное
                                // расхождение с предсказанием клиента)
  var COUNTDOWN_TIME = 3;       // фаза 3-2-1, с
  var ROUNDEND_TIME = 2.5;      // баннер итога раунда, с
  var MATCH_WINS = 2;           // до 2 побед
  var MATCH_ROUNDS = 3;         // максимум 3 раунда
  var FOOD_STANDING = 2;        // пакетов на поле всегда
  var FOOD_GROW = 2;            // сегментов за пакет
  var FOOD_TOTAL_MAX = 16;      // потолок вместе с обрезками
  var FOOD_PER_CUT = 3;         // 2 еды на 3 срезанных сегмента
  var FOOD_CUT_MAX = 12;        // максимум еды за один укус
  var BITE_PASS_TIME = 0.4;     // окно прохода сквозь тело, с
  var BITE_MIN_KEEP = 3;        // меньше осталось -> съеден
  var TRAP_MARGIN = 5;          // достижимо < длина + 5 -> западня
  var TRAP_SLOWMO = 1;          // длительность слоу-мо, с
  var TRAP_SLOW_FACTOR = 0.2;   // скорость симуляции в слоу-мо
  /* СЕКРЕТ АРЕНЫ (SPEC §14/§22): в дуэли только круг и пульс.
     Маска — функция НОМЕРА ТИКА: клиент предсказывает её точно
     (нет расхождений со временем). Первый секрет — не раньше
     ARENA_FIRST_TICK, дальше — случайно раз в 16-28 с. */
  var ARENA_FIRST_TICK = 95;    // ~10 с боя (тесты живут меньше)
  var ARENA_GAP_MIN = 150;      // ~16 с между секретами
  var ARENA_GAP_MAX = 266;      // ~28 с
  var ARENA_DUR_TICKS = 57;     // 6 с длительность
  var ARENA_IN_TICKS = 16;      // ~1.7 с плавный вход (успеть уйти из угла)
  var ARENA_OUT_TICKS = 10;     // ~1 с плавный выход к прямоугольнику

  var GRID_W = 36;              // арена серверной дуэли: клетки
  var GRID_H = 30;              // (одинакова у обоих игроков)

  var DIR = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };
  var DIR_NAMES = ['up', 'down', 'left', 'right'];
  var DIR_LIST = [DIR.up, DIR.down, DIR.left, DIR.right];

  /* цвета баннеров раунда в снапшоте (kc): сторона 0 — циан,
     сторона 1 — оранж соперника, ничья — жёлтый; клиент рисует */
  var SIDE_COLORS = ['#00f0ff', '#ff7a00', '#ffe600'];

  function idx(x, y, gw) { return y * gw + x; }

  function normDir(d) {
    if (typeof d === 'string' && DIR[d]) return DIR[d];
    if (typeof d === 'number' && DIR_LIST[d]) return DIR_LIST[d];
    if (d && typeof d === 'object' && isFinite(d.x) && isFinite(d.y)) {
      for (var k = 0; k < 4; k++) {
        if (DIR_LIST[k].x === d.x && DIR_LIST[k].y === d.y) return DIR_LIST[k];
      }
    }
    return null;
  }

  function dirName(d) {
    for (var k = 0; k < 4; k++) {
      if (DIR_LIST[k].x === d.x && DIR_LIST[k].y === d.y) return DIR_NAMES[k];
    }
    return 'up';
  }

  function dirIndex(d) {
    for (var k = 0; k < 4; k++) {
      if (DIR_LIST[k].x === d.x && DIR_LIST[k].y === d.y) return k;
    }
    return 0;
  }

  /* ---------- фабрика матча ---------- */

  /* createMatch({onRound, onWin}):
     onRound({w, r, s, k}) — раунд завершён (w: 0|1|-1);
     onWin({side, s})      — матч завершён (side: 0|1|-1).
     Дальше: begin() → update(dt) → input(side, dir) → snapshot(). */
  function createMatch(hooks) {
    var onRound = hooks && typeof hooks.onRound === 'function' ? hooks.onRound : null;
    var onWin = hooks && typeof hooks.onWin === 'function' ? hooks.onWin : null;

    var GW = GRID_W;
    var GH = GRID_H;
    var started = false;
    var matchEnded = false;

    var phase = 'idle';        // countdown|fight|roundEnd|matchEnd
    var phaseTimer = 0;
    var round = 1;
    var score = [0, 0];
    var roundWinner = null;
    var snakes = [];
    var food = [];
    var tickTimer = 0;
    var slowmo = 0;
    var banner = null;
    var events = { bite: 0, trap: 0, eat: 0, round: 0 };

    /* НЕТКОД v2: детерминизм и подтверждения (мировой стандарт
       «sequenced inputs + ack + tick-stamped snapshots»):
       - tickN    — номер тика боя (монотонный внутри раунда);
       - pending  — повороты стороны, ждущие своего тика (FIFO до 3,
                    как буфер ввода соло-игры SPEC §2);
       - seqAck   — последний seq входа стороны, ПОЛНОСТЬЮ вошедший
                    в симуляцию (клиент знает, что можно не реплеить);
       - seqAuto  — монотонный fallback для старых клиентов без seq. */
    var tickN = 0;
    var pending = [[], []];
    var seqAck = [0, 0];
    var seqAuto = [0, 0];
    var arena = null;      // {k:'circle'|'pulse', s, e} — тики
    var arenaNext = ARENA_FIRST_TICK;

    /* флуд-филл: типизированные буферы, одно выделение на матч */
    var blocked = new Uint8Array(GW * GH);
    var seen = new Int32Array(GW * GH);
    var queueBuf = new Int32Array(GW * GH);
    var stamp = 0;

    /* ---------- змейки ---------- */

    function makeSnake(headX, headY, dir, len) {
      var segs = [];
      for (var i = 0; i < len; i++) {
        var x = headX - dir.x * i;
        var y = headY - dir.y * i;
        segs.push({ prev: { x: x, y: y }, curr: { x: x, y: y } });
      }
      return { segs: segs, dir: dir, queue: [], growth: 0, pass: 0 };
    }

    /* постановка поворота в очередь стороны: клиент помечает вход
       тиком, на котором ОН его применил (детерминизм предсказания);
       опоздавший вход применяется при первом же тике. Повторы и
       развороты на 180° игнорируются (и сразу подтверждаются — они
       ничего не меняют); переполнение буфера (спам) выталкивает
       СТАРЫЙ поворот — новый важнее */
    function queueTurn(side, d, seq, tick) {
      var q = pending[side];
      var s = snakes[side];
      var last = q.length ? q[q.length - 1].dir : s.dir;
      if (d.x === last.x && d.y === last.y ||
          d.x === -last.x && d.y === -last.y) {
        ackSeq(side, seq);
        return;
      }
      var when = Number.isFinite(tick) ? Math.max(Math.floor(tick), tickN + 1) : tickN + 1;
      if (q.length >= TURN_BUFFER) q.shift();
      q.push({ dir: d, seq: seq, tick: when });
    }

    function ackSeq(side, seq) {
      if (Number.isFinite(seq) && seq > seqAck[side]) seqAck[side] = seq;
    }

    /* один поворот за тик: FIFO, только входы, чей тик настал */
    function takeTurn(side) {
      var q = pending[side];
      var s = snakes[side];
      while (q.length && q[0].tick <= tickN) {
        var e = q.shift();
        ackSeq(side, e.seq);
        if (e.dir.x === -s.dir.x && e.dir.y === -s.dir.y) continue;
        if (e.dir.x === s.dir.x && e.dir.y === s.dir.y) continue;
        s.dir = e.dir;
        break;
      }
    }

    function moveSnake(s, c) {
      var last = s.segs.length - 1;
      var oldTailX = s.segs[last].curr.x;
      var oldTailY = s.segs[last].curr.y;
      for (var i = last; i > 0; i--) {
        var sg = s.segs[i];
        var ahead = s.segs[i - 1].curr;
        sg.prev.x = sg.curr.x;
        sg.prev.y = sg.curr.y;
        sg.curr.x = ahead.x;
        sg.curr.y = ahead.y;
      }
      var h = s.segs[0];
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

    function selfCrash(s) {
      var head = s.segs[0].curr;
      for (var i = 1; i < s.segs.length; i++) {
        if (s.segs[i].curr.x === head.x && s.segs[i].curr.y === head.y) return true;
      }
      return false;
    }

    /* ---------- еда ---------- */

    function occupiedSet() {
      var occ = {};
      for (var i = 0; i < 2; i++) {
        var segs = snakes[i].segs;
        for (var k = 0; k < segs.length; k++) {
          occ[idx(segs[k].curr.x, segs[k].curr.y, GW)] = 1;
        }
      }
      for (var f = 0; f < food.length; f++) {
        occ[idx(food[f].x, food[f].y, GW)] = 1;
      }
      return occ;
    }

    function spawnFood() {
      var occ = occupiedSet();
      var free = [];
      for (var y = 0; y < GH; y++) {
        for (var x = 0; x < GW; x++) {
          if (!occ[idx(x, y, GW)]) free.push(idx(x, y, GW));
        }
      }
      if (!free.length) return;
      var c = free[Math.floor(Math.random() * free.length)];
      food.push({ x: c % GW, y: Math.floor(c / GW) });
    }

    function maintainFood() {
      while (food.length < FOOD_STANDING) {
        var before = food.length;
        spawnFood();
        if (food.length === before) break;
      }
    }

    function eatFood(s) {
      var head = s.segs[0].curr;
      for (var i = food.length - 1; i >= 0; i--) {
        if (food[i].x === head.x && food[i].y === head.y) {
          food.splice(i, 1);
          s.growth += FOOD_GROW;
        }
      }
    }

    function dropFood(cells) {
      if (!cells.length) return;
      var n = Math.min(FOOD_CUT_MAX, Math.ceil(cells.length * 2 / FOOD_PER_CUT));
      for (var i = 0; i < n; i++) {
        var c = cells[Math.floor(i * cells.length / n)];
        var dup = false;
        for (var k = 0; k < food.length; k++) {
          if (food[k].x === c.x && food[k].y === c.y) { dup = true; break; }
        }
        if (!dup) food.push({ x: c.x, y: c.y });
      }
      while (food.length > FOOD_TOTAL_MAX) food.shift();
    }

    /* ---------- западня (флуд-филл) ---------- */

    function markBlocked() {
      blocked.fill(0);
      for (var i = 0; i < 2; i++) {
        var segs = snakes[i].segs;
        for (var k = 0; k < segs.length; k++) {
          blocked[idx(segs[k].curr.x, segs[k].curr.y, GW)] = 1;
        }
      }
    }

    function reachCount(s) {
      var head = s.segs[0].curr;
      var start = idx(head.x, head.y, GW);
      stamp++;
      var qh = 0;
      var qt = 0;
      seen[start] = stamp;
      queueBuf[qt++] = start;
      var count = 0;
      while (qh < qt) {
        var c = queueBuf[qh++];
        count++;
        var cx = c % GW;
        var cy = (c - cx) / GW;
        if (cx > 0) { var n = c - 1; if (!blocked[n] && seen[n] !== stamp) { seen[n] = stamp; queueBuf[qt++] = n; } }
        if (cx < GW - 1) { var n2 = c + 1; if (!blocked[n2] && seen[n2] !== stamp) { seen[n2] = stamp; queueBuf[qt++] = n2; } }
        if (cy > 0) { var n3 = c - GW; if (!blocked[n3] && seen[n3] !== stamp) { seen[n3] = stamp; queueBuf[qt++] = n3; } }
        if (cy < GH - 1) { var n4 = c + GW; if (!blocked[n4] && seen[n4] !== stamp) { seen[n4] = stamp; queueBuf[qt++] = n4; } }
      }
      return count;
    }

    function trapCheck() {
      markBlocked();
      var r0 = reachCount(snakes[0]);
      var r1 = reachCount(snakes[1]);
      var t0 = r0 < snakes[0].segs.length + snakes[0].growth + TRAP_MARGIN;
      var t1 = r1 < snakes[1].segs.length + snakes[1].growth + TRAP_MARGIN;
      if (t0 && t1) return r0 === r1 ? -1 : (r0 < r1 ? 1 : 0);
      if (t0) return 1;
      if (t1) return 0;
      return null;
    }

    /* ---------- секрет арены: маска по номеру тика ---------- */

    /* сила формы 0..1: плавный вход, плато, плавный выход */
    function arenaK(tick) {
      if (!arena || tick <= arena.s || tick >= arena.e) return 0;
      if (tick < arena.s + ARENA_IN_TICKS) return (tick - arena.s) / ARENA_IN_TICKS;
      if (tick > arena.e - ARENA_OUT_TICKS) return (arena.e - tick) / ARENA_OUT_TICKS;
      return 1;
    }

    /* играбельна ли клетка на этом тике (центры клеток против маски);
       ДУБЛИРУЕТСЯ в js/duel.js для предсказания — менять только парой */
    function arenaOk(x, y, tick) {
      if (!arena) return true;
      var k = arenaK(tick);
      if (k <= 0) return true;
      var px = x + 0.5, py = y + 0.5;
      var cx = GW / 2, cy = GH / 2;
      if (arena.k === 'circle') {
        var rFull = Math.sqrt(cx * cx + cy * cy);
        var r = rFull - (rFull - Math.max(cx, cy) * 0.74) * k;
        var dx = px - cx, dy = py - cy;
        return dx * dx + dy * dy <= r * r;
      }
      /* pulse: сжатие → разжатие до исходного прямоугольника */
      var m = Math.min(GW, GH) * 0.12 *
        Math.sin((tick - arena.s) / (arena.e - arena.s) * Math.PI);
      return px > m && px < GW - m && py > m && py < GH - m;
    }

    /* ---------- тик ---------- */

    function targetOf(s) {
      var h = s.segs[0].curr;
      return { x: h.x + s.dir.x, y: h.y + s.dir.y };
    }

    function biteCheck(me, foe) {
      if (me.pass > 0) return null;
      var head = me.segs[0].curr;
      for (var k = 1; k < foe.segs.length; k++) {
        var c = foe.segs[k].curr;
        if (c.x !== head.x || c.y !== head.y) continue;
        var dropped = [];
        for (var s = k; s < foe.segs.length; s++) {
          dropped.push({ x: foe.segs[s].curr.x, y: foe.segs[s].curr.y });
        }
        foe.segs.length = k;
        foe.growth = 0;
        dropFood(dropped);
        me.pass = BITE_PASS_TIME;
        events.bite++;
        return foe.segs.length < BITE_MIN_KEEP ? 'devoured' : 'bite';
      }
      return null;
    }

    function setBanner(key, t, color) {
      banner = { key: key, t: t, total: t, color: color || SIDE_COLORS[2] };
    }

    function endRound(winner, key) {
      if (winner === 0 || winner === 1) score[winner]++;
      roundWinner = winner;
      phase = 'roundEnd';
      phaseTimer = ROUNDEND_TIME;
      events.round++;
      setBanner(key, ROUNDEND_TIME + 0.6,
        winner === -1 ? SIDE_COLORS[2] : SIDE_COLORS[winner]);
      if (onRound) {
        try { onRound({ w: winner, r: round, s: [score[0], score[1]], k: key }); } catch (e) { /* хук — не наша проблема */ }
      }
    }

    function trapWin(winner) {
      slowmo = TRAP_SLOWMO;
      events.trap++;
      endRound(winner, 'dTrapped');
    }

    function tick() {
      var s0 = snakes[0];
      var s1 = snakes[1];
      tickN++;
      takeTurn(0);
      takeTurn(1);

      /* расписание секрета арены: детерминированный телеграф —
         10 тиков до старта маски (s = tickN + 10) */
      if (!arena && tickN >= arenaNext) {
        arena = {
          k: Math.random() < 0.5 ? 'circle' : 'pulse',
          s: tickN + 10,
          e: tickN + 10 + ARENA_DUR_TICKS
        };
        arenaNext = tickN + ARENA_GAP_MIN +
          Math.floor(Math.random() * (ARENA_GAP_MAX - ARENA_GAP_MIN));
      }

      var t0 = targetOf(s0);
      var t1 = targetOf(s1);
      var wall = [false, false];
      if (t0.x < 0 || t0.x >= GW || t0.y < 0 || t0.y >= GH ||
          !arenaOk(t0.x, t0.y, tickN)) wall[0] = true;
      if (t1.x < 0 || t1.x >= GW || t1.y < 0 || t1.y >= GH ||
          !arenaOk(t1.x, t1.y, tickN)) wall[1] = true;
      if (wall[0] || wall[1]) {
        endRound(wall[0] && wall[1] ? -1 : (wall[0] ? 1 : 0), 'dCrash');
        return;
      }

      var h0 = s0.segs[0].curr;
      var h1 = s1.segs[0].curr;
      var sameCell = t0.x === t1.x && t0.y === t1.y;
      var swap = t0.x === h1.x && t0.y === h1.y && t1.x === h0.x && t1.y === h0.y;
      if (sameCell || swap) {
        var l0 = s0.segs.length + s0.growth;
        var l1 = s1.segs.length + s1.growth;
        endRound(l0 === l1 ? -1 : (l0 > l1 ? 0 : 1), 'dHead');
        return;
      }

      moveSnake(s0, t0);
      moveSnake(s1, t1);

      var dead = [selfCrash(s0), selfCrash(s1)];
      var devoured = false;
      for (var i = 0; i < 2; i++) {
        if (dead[0] || dead[1]) break;
        var me = snakes[i];
        var foe = snakes[1 - i];
        var r = biteCheck(me, foe);
        if (r === 'devoured') {
          dead[1 - i] = true;
          devoured = true;
        }
      }
      if (!dead[0] && !dead[1]) {
        eatFood(s0);
        eatFood(s1);
        maintainFood();
      }
      if (dead[0] || dead[1]) {
        if (dead[0] && dead[1]) endRound(-1, 'dDraw');
        else {
          var winner = dead[0] ? 1 : 0;
          if (devoured) events.eat++;
          endRound(winner, devoured ? 'dEat' : 'dCrash');
        }
        return;
      }

      var trap = trapCheck();
      if (trap !== null) trapWin(trap);
    }

    /* ---------- фазы ---------- */

    function startRound() {
      var y = Math.floor(GH / 2);
      var x0 = Math.max(START_LEN, Math.min(GW - START_LEN - 1, Math.round(GW * START_X0)));
      var x1 = Math.max(START_LEN, Math.min(GW - START_LEN - 1, Math.round(GW * START_X1)));
      snakes = [
        makeSnake(x0, y, DIR.right, START_LEN),
        makeSnake(x1, y, DIR.left, START_LEN)
      ];
      food = [];
      maintainFood();
      tickTimer = 0;
      slowmo = 0;
      roundWinner = null;
      tickN = 0;            // НЕТКОД v2: тики нумеруются внутри раунда
      pending = [[], []];
      seqAck = [0, 0];
      seqAuto = [0, 0];
      arena = null;        // новый раунд — арена с чистого листа
      arenaNext = ARENA_FIRST_TICK;
      phase = 'countdown';
      phaseTimer = COUNTDOWN_TIME;
    }

    function nextAfterRoundEnd() {
      if (score[0] >= MATCH_WINS || score[1] >= MATCH_WINS || round >= MATCH_ROUNDS) {
        matchEnd(score[0] === score[1] ? -1 : (score[0] > score[1] ? 0 : 1));
        return;
      }
      round++;
      startRound();
    }

    function matchEnd(winner) {
      phase = 'matchEnd';
      setBanner(winner === -1 ? 'dDraw' : 'dWin', 999, SIDE_COLORS[2]);
      matchEnded = true;
      if (onWin) {
        try { onWin({ side: winner, s: [score[0], score[1]] }); } catch (e) { /* хук */ }
      }
    }

    /* главный шаг: звать ~20 раз/с с реальным dt */
    function update(dt) {
      if (!started || matchEnded) return;
      if (banner) {
        banner.t -= dt;
        if (banner.t <= 0) banner = null;
      }
      for (var i = 0; i < 2; i++) {
        if (snakes[i] && snakes[i].pass > 0) {
          snakes[i].pass = Math.max(0, snakes[i].pass - dt);
        }
      }
      var slow = slowmo > 0 ? TRAP_SLOW_FACTOR : 1;
      if (slowmo > 0) slowmo = Math.max(0, slowmo - dt);

      if (phase === 'countdown') {
        phaseTimer -= dt;
        if (phaseTimer <= 0) {
          phase = 'fight';
          phaseTimer = 0;
          tickTimer = 0;
          setBanner('dReady', 0.8, SIDE_COLORS[0]);
        }
      } else if (phase === 'fight') {
        tickTimer += dt * slow;
        var step = 1 / TICK_RATE;
        var guard = 6;
        while (tickTimer >= step && guard-- > 0 && phase === 'fight') {
          tickTimer -= step;
          tick();
        }
      } else if (phase === 'roundEnd') {
        phaseTimer -= dt * slow;
        if (phaseTimer <= 0) nextAfterRoundEnd();
      }
    }

    /* ---------- снапшот (форма = 'state' из T23/T27) ---------- */

    function packSnake(s) {
      var out = [];
      for (var i = 0; i < s.segs.length; i++) {
        out.push(s.segs[i].curr.x, s.segs[i].curr.y);
      }
      return out;
    }

    function snapshot() {
      return {
        ph: phase,
        r: round,
        s: [score[0], score[1]],
        pt: Math.max(0, phaseTimer),
        sn: [packSnake(snakes[0]), packSnake(snakes[1])],
        d: [dirIndex(snakes[0].dir), dirIndex(snakes[1].dir)],
        /* g — незавершённый рост (сегменты в полёте): клиенту нужен
           для точного реплея от снапшота; p — таймер прохода сквозь
           тело после укуса (мигание-щит на клиенте) */
        g: [snakes[0].growth, snakes[1].growth],
        p: [snakes[0].pass, snakes[1].pass],
        f: food.map(function (c) { return [c.x, c.y]; }),
        w: roundWinner,
        k: banner ? banner.key : null,
        kt: banner ? Math.max(0, banner.t) : 0,
        kc: banner ? banner.color : null,
        ev: [events.bite, events.trap, events.eat, events.round],
        /* НЕТКОД v2: tk — тик симуляции, st — серверное время (мс),
           sq — последний подтверждённый seq входа каждой стороны;
           ar — активный секрет арены {k, s, e} тиками (SPEC §14) */
        tk: tickN,
        st: Date.now(),
        sq: [seqAck[0], seqAck[1]],
        ar: arena ? { k: arena.k, s: arena.s, e: arena.e } : null
      };
    }

    /* ---------- запуск ---------- */

    function begin() {
      score = [0, 0];
      round = 1;
      matchEnded = false;
      banner = null;
      slowmo = 0;
      events = { bite: 0, trap: 0, eat: 0, round: 0 };
      snakes = [makeSnake(3, 3, DIR.right, 1), makeSnake(6, 3, DIR.left, 1)];
      started = true;
      startRound();
    }

    return {
      begin: begin,
      update: update,
      /* input(0|1, 'up'|'down'|'left'|'right'|{x,y}, seq?, tick?) —
         seq: порядковый номер входа от клиента; tick: тик, на котором
         клиент применил вход (нет значений → старые immediate-клиенты) */
      input: function (side, d, seq, tick) {
        if (!started || matchEnded) return;
        if (side !== 0 && side !== 1) return;
        var v = normDir(d);
        if (!v || !snakes[side]) return;
        var n = Number(seq);
        if (!Number.isFinite(n) || n < 0 || n > 1e9) n = ++seqAuto[side];
        var w = Number(tick);
        if (!Number.isFinite(w) || w > tickN + 1000) w = tickN + 1;
        queueTurn(side, v, n, w);
      },
      snapshot: snapshot,
      done: function () { return matchEnded; },
      started: function () { return started; },
      phase: function () { return phase; },
      score: function () { return [score[0], score[1]]; },
      grid: function () { return { w: GW, h: GH }; }
    };
  }

  var api = {
    createMatch: createMatch,
    GRID_W: GRID_W,
    GRID_H: GRID_H,
    TICK_RATE: TICK_RATE,
    dirName: dirName,
    normDir: normDir
  };

  /* браузер: window.CS.DuelCore; Node: module.exports (сервер) */
  if (typeof window !== 'undefined') {
    window.CS = window.CS || {};
    window.CS.DuelCore = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
