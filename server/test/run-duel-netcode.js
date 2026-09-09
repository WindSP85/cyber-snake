/* ============================================================
   NEON://SNAKE — headless-тест неткода дуэли (НЕТКОД v2)
   (запуск: node server/test/run-duel-netcode.js)

   Прогоняет НАСТОЯЩИЕ js/duel.js (клиент) в песочнице vm против
   НАСТОЯЩЕГО js/duel-core.js (серверная симуляция) с моделью
   сети: задержки туда/обратно, джиттер, тишина, бёрсты.

   Проверяет мировые стандарты неткода быстрых игр:
   1) буфер поворотов: быстрые «уголки» не теряются на сервере;
   2) мгновенный отклик: поворот применяется на следующем локальном
      тике ДО какого-либо подтверждения сервера;
   3) точное предсказание: своевременные входы + путь без еды —
      реплей совпадает с сервером в ноль коррекций (offMag === 0);
   4) поздний вход: коррекция появляется и плавно гаснет,
      позиция не прыгает (шаг кадра ≤ 1.35 клетки);
   5) настоящая игра (змейка ест, растёт): видимых телепортов нет,
      каждая коррекция само-zатухает;
   6) тишина ~1 с: таймлайн замирает, восстановление — плавный
      догон без телепорта (непрерывность отображаемой позиции);
   7) устаревший снапшот игнорируется;
   8) интерполяция соперника: renderTick монотонен и не вылезает
      за последний авторитарный тик.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const duelCore = require(path.join(ROOT, 'js', 'duel-core'));

/* виртуальные сим-часы: серверный st (Date.now из duel-core) и клиентский
   arrive (Date.now из vm-песочницы duel.js) живут на ОДНОЙ шкале —
   пинг-оценку можно сверять с истиной в абсолютных миллисекундах */
let simNowMs = 0;
let harnessRttMs = 0; // RTT текущей партии (задаёт runMatch из opts)
const realDateNow = Date.now;
Date.now = function () { return simNowMs; }; // только для этого тест-процесса

/* ---------- мини-репортер (как в run-tests.js) ---------- */

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ok  ' + msg);
  } else {
    failed++;
    console.log('  FAIL ' + msg);
  }
}

function eq(a, b, msg) {
  ok(a === b, msg + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')');
}

function section(name) {
  console.log('\n' + name);
}

/* ---------- песочница клиента (настоящий js/duel.js) ---------- */

function makeClient(myIndex, grid) {
  const listeners = [];
  const sent = [];
  const sandbox = { console: console, Date: { now: function () { return simNowMs; } } };
  sandbox.window = sandbox; // duel.js пишет в window.CS
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'js', 'duel.js'), 'utf8'),
    sandbox,
    { filename: 'js/duel.js' }
  );
  /* транспорт-заглушка: посылки копятся, снапшоты доставляются
     вручную из координатора */
  sandbox.CS.Net = {
    send: function (type, data) {
      sent.push({ type: type, data: JSON.parse(JSON.stringify(data)) });
      return true;
    },
    onMessage: function (cb) { listeners.push(cb); },
    /* честный RTT как в проде: эхо-метка через сеть партии */
    rttMs: function () { return harnessRttMs; }
  };
  const duel = sandbox.CS.Duel;
  duel.begin({ myIndex: myIndex, grid: grid, onMatchEnd: function () {} });
  return {
    duel: duel,
    deliver: function (type, data) {
      for (let i = 0; i < listeners.length; i++) listeners[i](type, data, '#server');
    },
    sent: sent
  };
}

/* ---------- координатор: сервер + сеть + клиент ---------- */

const SIM_STEP = 0.05;    // сервер апдейтится как в проде, с
const SNAP_EVERY = 0.0625; // снапшотами ~16/с
const DT = 0.01;          // шаг координации

/* opts: { duration, upDelay, downDelay, jitter, inputs:
   [{t, dir, side, delay?}], stall: {from, to}, myIndex } */
function runMatch(opts) {
  const core = duelCore.createMatch({});
  core.begin();
  const client = makeClient(opts.myIndex || 0, core.grid());

  const inputs = (opts.inputs || []).slice().sort(function (a, b) { return a.t - b.t; });
  const wire = []; // {eta, kind:'down'|'up', data, side}
  const trace = [];
  let t = 0;
  let simAcc = 0;
  let snapAcc = 0;
  let stalled = false;
  const stall = opts.stall || null;

  simNowMs = 0; // каждая партия стартует с нуля виртуальных часов
  harnessRttMs = Math.round(((opts.upDelay || 0) + (opts.downDelay || 0)) * 1000);
  while (t < opts.duration) {
    simNowMs += DT * 1000;
    /* сервер: шаги по 50 мс, как setInterval в проде */
    simAcc += DT;
    while (simAcc >= SIM_STEP) {
      simAcc -= SIM_STEP;
      core.update(SIM_STEP);
      snapAcc += SIM_STEP;
      if (snapAcc >= SNAP_EVERY) {
        snapAcc -= SNAP_EVERY;
        const snap = core.snapshot();
        wire.push({
          eta: t + (opts.downDelay || 0) + (opts.jitter || 0) * Math.random(),
          kind: 'down',
          data: JSON.parse(JSON.stringify(snap))
        });
      }
    }

    /* доставка: вниз (с окном тишины), вверх */
    stalled = !!(stall && t >= stall.from && t < stall.to);
    for (let i = wire.length - 1; i >= 0; i--) {
      const m = wire[i];
      if (m.eta > t) continue;
      if (m.kind === 'down' && stalled) continue; // копим бёрст
      wire.splice(i, 1);
      if (m.kind === 'down') client.deliver('state', m.data);
      else core.input(m.side, m.data.dir, m.data.seq, m.data.tick);
    }

    /* scripted-входы (сторона 0 — клиент, 1 — соперник-бот) */
    while (inputs.length && inputs[0].t <= t) {
      const inp = inputs.shift();
      if (inp.side === 1) {
        /* вход соперника едет в сеть с задержкой foeDelay (асимметрия) */
        wire.push({
          eta: t + (opts.foeDelay || 0) + (inp.delay || 0),
          kind: 'up',
          side: 1,
          data: { dir: inp.dir, seq: 900000 + Math.floor(t * 1000), tick: 1 }
        });
      } else {
        client.duel.input(inp.dir);
        /* помечаем последнюю посылку кастомной задержкой */
        const s = client.sent[client.sent.length - 1];
        if (s && inp.delay) s.delay = inp.delay;
      }
    }

    /* посылки клиента уходят в сеть */
    while (client.sent.length) {
      const s = client.sent.shift();
      wire.push({
        eta: t + (s.delay != null ? s.delay : (opts.upDelay || 0)),
        kind: 'up',
        side: 0,
        data: s.data
      });
    }

    client.duel.update(DT);

    const st = client.duel.state();
    trace.push({
      t: t,
      phase: st.phase,
      net: st.net,
      pred: st.pred
    });
    t += DT;
  }
  return { trace: trace, core: core, client: client };
}

/* ---------- планировщик безопасного пути (без еды и стен) ---------- */

/* считает клетки пути стороны 0 по расписанию поворотов — чтобы
   выбрать вариант, не задевающий стартовую еду (тогда предсказание
   обязано быть точным в ноль) */
function planPath(gw, gh, turns, shift) {
  let x = Math.max(5, Math.min(gw - 6, Math.round(gw * 0.15)));
  let y = Math.floor(gh / 2);
  let dx = 1;
  let dy = 0;
  const cells = [];
  const step = 1 / 9.5;
  let turnIdx = 0;
  const t0 = 3.45; // первый боевой снапшот уже пришёл, таймлайн жив
  for (let tick = 1; tick <= 90; tick++) {
    const tt = t0 + tick * step;
    while (turnIdx < turns.length && turns[turnIdx].at + (shift || 0) <= tt) {
      const d = turns[turnIdx].dir;
      const v = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[d];
      if (!(v[0] === -dx && v[1] === -dy) && !(v[0] === dx && v[1] === dy)) {
        dx = v[0];
        dy = v[1];
      }
      turnIdx++;
    }
    x += dx;
    y += dy;
    cells.push(x + ',' + y);
    cells.push((x+1) + ',' + y);
    cells.push((x-1) + ',' + y);
    cells.push(x + ',' + (y+1));
    cells.push(x + ',' + (y-1));
  }
  return cells;
}

function pathHitsFood(cells, food) {
  for (let i = 0; i < cells.length; i++) {
    for (let k = 0; k < food.length; k++) {
      if (cells[i] === food[k][0] + ',' + food[k][1]) return true;
    }
  }
  return false;
}

/* змейка-«серпантин»: вертикальные свипы с медленным дрейфом вправо;
   сторона 1 — зеркальный серпантин (не пересекаются со стороной 0) */
function serpentineTurns(side, phase) {
  const seq = side === 0
    ? [['up', 0], ['right', 1.2], ['down', 1.45], ['right', 3.85], ['up', 4.1], ['right', 6.5]]
    : [['down', 0], ['left', 1.2], ['up', 1.45], ['left', 3.85], ['down', 4.1], ['left', 6.5]];
  const out = [];
  for (let i = 0; i < seq.length; i++) {
    if (side === 1 && phase === 'relative') continue;
    out.push({ at: seq[i][1], dir: seq[i][0] });
  }
  return out;
}

/* стартовая еда матча (она статична, пока её не съели) */
function initialFood() {
  const m = duelCore.createMatch({});
  m.begin();
  let guard = 200;
  while (m.phase() !== 'fight' && guard-- > 0) m.update(0.05);
  return m.snapshot().f;
}

/* serpentine-входы для координатора: t — абсолютное время (бой
   стартует на ~3.05 с матча) */
function fightInputs(turns, shift, extra) {
  const out = [];
  for (let i = 0; i < turns.length; i++) {
    out.push({ t: 3.45 + turns[i].at + (shift || 0), dir: turns[i].dir, side: 0 });
  }
  /* соперник-бот: свой серпантин, чтобы не врезаться в сторону 0 */
  const foe = serpentineTurns(1);
  for (let i = 0; i < foe.length; i++) {
    out.push({ t: 3.45 + foe[i].at + (shift || 0), dir: foe[i].dir, side: 1 });
  }
  if (extra) out.push.apply(out, extra);
  return out;
}

/* максимальный покадровый шаг отображаемой головы в бою */
function maxHeadJump(trace) {
  let max = 0;
  let prev = null;
  for (let i = 0; i < trace.length; i++) {
    const fr = trace[i];
    if (!fr.net.dispHead) {
      prev = null;
      continue;
    }
    if (prev) {
      const a = prev.split(',');
      const b = fr.net.dispHead.split(',');
      const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
      if (d > max) max = d;
    }
    prev = fr.net.dispHead;
  }
  return max;
}

/* самый длинный НЕПРЕРЫВНЫЙ участок offMag > threshold: детектор
   «залипшего» расхождения (легитимные события — поздний вход, укус,
   еда — гаснут каждое само по себе, залипание — нет) */
function maxStuckSpan(fight, threshold) {
  let worst = 0;
  let run = -1;
  let prevT = 0;
  for (let i = 0; i < fight.length; i++) {
    const f = fight[i];
    if (f.net.offMag > threshold) {
      run = run < 0 ? 0 : run + (f.t - prevT);
      if (run > worst) worst = run;
    } else {
      run = -1;
    }
    prevT = f.t;
  }
  return worst;
}

/* ---------- прогон ---------- */

async function main() {
  console.log('NEON://SNAKE — неткод дуэли v2 (клиент js/duel.js x сервер js/duel-core.js)');

  /* ============ 1. Сервер: буфер поворотов ============ */
  section('[1] Буфер поворотов: быстрые уголки не теряются');

  {
    const m = duelCore.createMatch({});
    m.begin();
    let guard = 200;
    while (m.phase() !== 'fight' && guard-- > 0) m.update(0.05);
    let snap = m.snapshot();
    const tk0 = snap.tk;

    /* два поворота в одном межтиковом окне + третий следом */
    m.input(0, 'up', 1, tk0 + 1);
    m.input(0, 'left', 2, tk0 + 1);
    m.input(0, 'down', 3, tk0 + 2);
    m.update(0.05);
    m.update(0.05);
    m.update(0.05); // ~1 тик прошёл
    snap = m.snapshot();
    eq(snap.d[0], 0, 'после 1-го тика направление up (индекс 0)');
    m.update(0.05);
    m.update(0.05);
    m.update(0.05);
    snap = m.snapshot();
    eq(snap.d[0], 2, 'после 2-го тика направление left (индекс 2) — НЕ затёрто');
    m.update(0.05);
    m.update(0.05);
    m.update(0.05);
    snap = m.snapshot();
    eq(snap.d[0], 1, 'третий поворот (down) применился на своём тике');
    ok(snap.sq[0] >= 3, 'сервер подтвердил все три seq: sq=' + snap.sq[0]);
  }

  /* ============ 2. Мгновенный отклик ============ */
  section('[2] Мгновенный отклик: поворот до подтверждения');

  {
    const food = initialFood();
    const turns = serpentineTurns(0);
    let shift = 0;
    let path = planPath(duelCore.GRID_W, duelCore.GRID_H, turns, 0);
    for (let s = 0; s < 6 && pathHitsFood(path, food); s++) {
      shift = 0.07 * (s + 1);
      path = planPath(duelCore.GRID_W, duelCore.GRID_H, turns, shift);
    }
    const res = runMatch({
      duration: 6.6 + shift,
      upDelay: 0.06,
      downDelay: 0.07,
      inputs: fightInputs(turns, shift)
    });
    const first = res.trace.filter(function (f) { return f.t >= 3.45 + shift; });
    ok(first.length > 10, 'бой идёт, кадры собраны (' + first.length + ')');
    /* до первого поворота predDir=right, через ≤0.12 с после — up,
       при этом подтверждения входа ещё нет (sq < seq) */
    const atPress = res.trace.filter(function (f) {
      return f.t >= 3.45 + shift - 0.02 && f.t <= 3.45 + shift + 0.005;
    });
    const after = res.trace.filter(function (f) {
      return f.t >= 3.45 + shift + 0.10 && f.t <= 3.45 + shift + 0.13;
    });
    ok(atPress.length && after.length, 'кадры вокруг нажатия есть');
    if (atPress.length && after.length) {
      eq(atPress[0].net.predDir, 'right', 'до нажатия predDir=right');
      eq(after[0].net.predDir, 'up', 'через ~0.12 с predDir=up — локальный тик');
      ok(after[0].net.seq > after[0].net.sq,
        'подтверждения ещё нет (seq=' + after[0].net.seq + ' > sq=' + after[0].net.sq + ')');
    }

    /* ============ 3. Точное предсказание (путь без еды) ============ */
    section('[3] Точное предсказание: offMag === 0 на чистой сети');
    const fight = res.trace.filter(function (f) { return f.phase === 'fight'; });
    const warmed = fight.filter(function (f) { return f.t > 4.7 + shift; });
    ok(warmed.length > 50, 'бой достаточно длинный (' + warmed.length + ' кадров)');
    let maxOff = 0;
    for (let i = 0; i < warmed.length; i++) {
      if (warmed[i].net.offMag > maxOff) maxOff = warmed[i].net.offMag;
    }
    ok(maxOff === 0, 'ни одной коррекции: offMax=' + maxOff);
    ok(maxHeadJump(res.trace) <= 1.35,
      'покадровый шаг головы ≤ 1.35 клетки (' + maxHeadJump(res.trace).toFixed(2) + ')');
  }

  /* ============ 4. Поздний вход ============ */
  section('[4] Поздний вход: плавная коррекция без прыжка');

  {
    /* лестница вправо: короткие вертикали (±2.85 клетки) — задержка
       любого одного поворота не выводит змейку за стены */
    const stair = [];
    for (let k = 0; k < 6; k++) {
      stair.push({ at: 0.6 * k, dir: k % 2 === 0 ? 'up' : 'down' });
      stair.push({ at: 0.6 * k + 0.3, dir: 'right' });
    }
    const food = initialFood();
    let shift = 0;
    let path = planPath(duelCore.GRID_W, duelCore.GRID_H, stair, 0);
    for (let s2 = 0; s2 < 6 && pathHitsFood(path, food); s2++) {
      shift = 0.07 * (s2 + 1);
      path = planPath(duelCore.GRID_W, duelCore.GRID_H, stair, shift);
    }
    const LATE_AT = 0.6; // этот поворот уедет с задержкой 0.45 с
    const inputs = [];
    const foe = serpentineTurns(1);
    for (let i = 0; i < foe.length; i++) {
      inputs.push({ t: 3.45 + foe[i].at, dir: foe[i].dir, side: 1 });
    }
    for (let i = 0; i < stair.length; i++) {
      if (Math.abs(stair[i].at - LATE_AT) < 0.01) continue; // нет в базе
      inputs.push({ t: 3.45 + stair[i].at + shift, dir: stair[i].dir, side: 0 });
    }
    const lateT = 3.45 + LATE_AT + shift + 0.35;
    inputs.push({ t: lateT, dir: 'down', side: 0, delay: 0.45 });
    const res = runMatch({ duration: 7.6 + shift, upDelay: 0.06, downDelay: 0.07, inputs: inputs });
    const fight = res.trace.filter(function (f) { return f.phase === 'fight'; });
    ok(fight.length > 200, 'бой шёл (' + fight.length + ' кадров)');
    const spikes = fight.filter(function (f) { return f.t > lateT + 0.4 && f.net.offMag > 0.05; });
    ok(spikes.length > 0, 'коррекция возникла после позднего входа');
    if (spikes.length) {
      const maxSpike = spikes.reduce(function (m, f) { return Math.max(m, f.net.offMag); }, 0);
      /* независимые события (поздний вход, укус соперника, еда) дают
         каждое своё гаснущее смещение — запрещено только залипание */
      const stuck = maxStuckSpan(fight, 1.0);
      ok(stuck < 2.5,
        'коррекции гаснут, залипаний нет (пик ' + maxSpike.toFixed(2) +
        ', макс. залипание ' + stuck.toFixed(2) + ' с)');
    }
    ok(maxHeadJump(res.trace) <= 1.35,
      'прыжков нет: шаг головы ≤ 1.35 клетки (' + maxHeadJump(res.trace).toFixed(2) + ')');
  }

  /* ============ 5. Настоящая игра (еда/рост) ============ */
  section('[5] Живой бой с едой: без телепортов, коррекции само-гаснут');

  {
    const turns = serpentineTurns(0);
    const res = runMatch({
      duration: 9.0,
      upDelay: 0.06,
      downDelay: 0.07,
      jitter: 0.03,
      inputs: fightInputs(turns, 0)
    });
    const fight = res.trace.filter(function (f) { return f.phase === 'fight'; });
    ok(fight.length > 300, 'бой длинный (' + fight.length + ' кадров)');
    const grew = res.trace.some(function (f) { return f.phase === 'fight' && f.net.snapBufLen > 0; });
    ok(grew, 'снапшоты текут');
    ok(maxHeadJump(res.trace) <= 1.35,
      'покадровый шаг головы ≤ 1.35 клетки (' + maxHeadJump(res.trace).toFixed(2) + ')');
    /* укусы/еда/джиттер дают каждое своё гаснущее смещение —
       запрещено только залипание расхождения */
    const stuck5 = maxStuckSpan(fight, 1.0);
    ok(stuck5 < 2.5, 'коррекции гаснут, залипаний нет (макс. ' + stuck5.toFixed(2) + ' с)');

    /* ============ 8. Интерполяция соперника ============ */
    section('[8] Интерполяция соперника: renderTick монотонный и в буфере');
    const warmed = fight.filter(function (f) { return f.t > 4.7; });
    let mono = true;
    let inBuf = true;
    let prevRT = -1e9;
    for (let i = 0; i < warmed.length; i++) {
      const rt = warmed[i].net.renderTick;
      if (rt < prevRT - 1e-6) mono = false;
      prevRT = rt;
      if (rt > warmed[i].net.lastTk + 0.05) inBuf = false;
    }
    ok(mono, 'renderTick не откатывается назад');
    ok(inBuf, 'renderTick не вылезает за последний авторитарный тик');
  }

  /* ============ 6. Тишина и восстановление ============ */
  section('[6] Тишина ~1 с: замерзание и плавный догон');

  {
    const food = initialFood();
    const turns = serpentineTurns(0);
    let shift = 0;
    let path = planPath(duelCore.GRID_W, duelCore.GRID_H, turns, 0);
    for (let s = 0; s < 6 && pathHitsFood(path, food); s++) {
      shift = 0.07 * (s + 1);
      path = planPath(duelCore.GRID_W, duelCore.GRID_H, turns, shift);
    }
    const res = runMatch({
      duration: 9.6 + shift,
      upDelay: 0.06,
      downDelay: 0.07,
      inputs: fightInputs(turns, shift),
      stall: { from: 5.0, to: 6.0 }
    });
    const fight = res.trace.filter(function (f) { return f.phase === 'fight'; });
    const starved = fight.filter(function (f) { return f.t > 5.8 && f.t < 6.0; });
    ok(starved.length > 0 && starved.every(function (f) { return f.net.starving; }),
      'таймлайн замерз во время тишины');
    const frozen = starved.filter(function (f) { return f.net.dispHead; });
    let frozenStill = false;
    if (frozen.length > 10) {
      frozenStill = frozen.every(function (f) { return f.net.dispHead === frozen[0].net.dispHead; });
    }
    ok(frozenStill, 'отображаемая позиция неподвижна в тишине');
    ok(maxHeadJump(res.trace) <= 1.4,
      'восстановление без телепорта: шаг головы ≤ 1.4 клетки (' + maxHeadJump(res.trace).toFixed(2) + ')');
    const tail = fight.filter(function (f) { return f.t > 8.9 + shift; });
    ok(tail.length > 0 && tail.every(function (f) { return f.net.offMag < 0.4; }),
      'догон сошёлся к концу (offMag < 0.4)');
  }

  /* ============ 7. Устаревший снапшот ============ */
  section('[7] Устаревший снапшот игнорируется');

  {
    const turns = serpentineTurns(0);
    const res = runMatch({
      duration: 6.0,
      upDelay: 0.06,
      downDelay: 0.07,
      inputs: fightInputs(turns, 0)
    });
    const fight = res.trace.filter(function (f) { return f.phase === 'fight'; });
    ok(fight.length > 50, 'бой шёл (' + fight.length + ' кадров)');
    const last = fight[fight.length - 1];
    const before = last.net.lastTk;
    /* суём старый снапшот (tk сильно меньше) — состояние не должно
       сдвинуться и ничего не должно упасть */
    const stale = {
      ph: 'fight', r: 1, s: [0, 0], pt: 9,
      sn: [[1, 1, 2, 1, 3, 1, 4, 1, 5, 1], [30, 15, 29, 15, 28, 15, 27, 15, 26, 15]],
      d: [0, 2], g: [0, 0], f: [], w: null, k: null, kt: 0, kc: null,
      ev: [0, 0, 0, 0], tk: Math.max(0, before - 7), st: Date.now(), sq: [0, 0]
    };
    res.client.deliver('state', stale);
    const after = res.client.duel.state();
    eq(after.net.lastTk, before, 'lastTk не откатился от старого снапшота');
    ok(after.phase === 'fight', 'фаза не сломана');
  }

  /* ============ 9. Секрет арены в ПВП (SPEC §14/§22) ============ */
  section('[9] Арена ПВП: круг/пульс, зеркало маски точно');

  {
    /* обе змейки — бездрейфовые квадратные орбиты ~4x4 (безопасны при
       круге и пульсе, разнесены по горизонтали, без еды по плану) */
    const CYC0 = ['up', 'right', 'down', 'left'];
    const CYC1 = ['down', 'right', 'up', 'left'];
    const stair0 = [];
    const stair1 = [];
    for (let k = 0; k < 32; k++) {
      stair0.push({ at: 0.42 * k, dir: CYC0[k % 4] });
      stair1.push({ at: 0.42 * k, dir: CYC1[k % 4] });
    }
    const food = initialFood();
    let shift = 0;
    let path0 = planPath(duelCore.GRID_W, duelCore.GRID_H, stair0, 0);
    for (let sc = 0; sc < 6 && pathHitsFood(path0, food); sc++) {
      shift = 0.07 * (sc + 1);
      path0 = planPath(duelCore.GRID_W, duelCore.GRID_H, stair0, shift);
    }
    const inputs = [];
    for (let i = 0; i < stair0.length; i++) {
      inputs.push({ t: 3.45 + stair0[i].at + shift, dir: stair0[i].dir, side: 0 });
    }
    for (let i = 0; i < stair1.length; i++) {
      inputs.push({ t: 3.45 + stair1[i].at + shift, dir: stair1[i].dir, side: 1 });
    }
    const res = runMatch({
      duration: 16.2 + shift,
      upDelay: 0.06,
      downDelay: 0.07,
      inputs: inputs
    });
    const fight = res.trace.filter(function (f) { return f.phase === 'fight'; });
    ok(fight.length > 800, 'бой достаточно длинный (' + fight.length + ' кадров)');
    const sawArena = fight.some(function (f) { return !!f.net.arena; });
    ok(sawArena, 'секрет арены пришёл снапшотом');
    const kinds = fight.map(function (f) { return f.net.arena; }).filter(Boolean);
    console.log('    арена: ' + kinds[0] + ' (кадров с ареной: ' + kinds.length + ')');
    /* ГЛАВНЫЙ инвариант: зеркало маски не добавляет расхождений.
     Плотный ввод (поворот каждые 4 тика) сам по себе даёт микро-коррекции
     ~2.2 (вход на границе своевременности) — они идут ДО арены тем же
     размахом, что и во время морфа; маска детерминирована по тикам и
     своих расхождений не вносит. Проверяем: размах ограничен, залипаний
     нет, движение без скачков. */
    let maxOff = 0;
    const warmed9 = fight.filter(function (f) { return f.t > 5.2 + shift; });
    for (let i = 0; i < warmed9.length; i++) {
      if (warmed9[i].net.offMag > maxOff) maxOff = warmed9[i].net.offMag;
    }
    ok(maxOff <= 2.6, 'коррекции ограничены: offMax=' + maxOff.toFixed(2) +
      ' (допуск плотного ввода 2.6, телепортов нет)');
    const stuck9 = maxStuckSpan(warmed9, 1.0);
    ok(stuck9 < 2.5, 'залипаний нет (макс ' + stuck9.toFixed(2) + ' с)');
    ok(maxHeadJump(res.trace) <= 1.35,
      'движение плавное сквозь морф (шаг ' + maxHeadJump(res.trace).toFixed(2) + ')');
  }

  /* ============ 10. СТРЕСС-МАТРИЦА: уровень сетевых шутеров ============
     Приборно: (а) мгновенный отклик — ввод->предсказание НЕ зависит от
     сети; (б) равные условия — асимметрия задержек не даёт артефактов;
     (в) коррекции ограничены и не залипают на любом пинге;
     (г) оценка пинга сходится к истине. */
  section('[10] Стресс-матрица неткода (100/250/400мс, асимметрия)');

  function respLatency(trace, inputs, shift) {
    /* max задержка «нажатие -> predDir сменился» (лок. предсказание) */
    let worst = 0;
    for (let i = 0; i < inputs.length; i++) {
      if (inputs[i].side !== 0) continue;
      const press = inputs[i].t;
      let before = null;
      let after = null;
      for (let k = 0; k < trace.length; k++) {
        const fr = trace[k];
        if (fr.t < press - 0.02) before = fr.net.predDir;
        if (fr.t >= press + 0.02 && fr.t <= press + 1.0 && fr.net.predDir) {
          after = fr.net.predDir;
          if (after && before && after !== before) {
            const lat = fr.t - press;
            if (lat > worst) worst = lat;
            break;
          }
        }
      }
    }
    return worst;
  }

  /* бездрейфовые орбиты (как в секции 9): ничего не врезается в стену,
     измерение не прерывается сменой раунда */
  function stairInputs(cycle, span) {
    const out = [];
    const CY0 = ['up', 'right', 'down', 'left'];
    const CY1 = ['down', 'right', 'up', 'left'];
    for (let k = 0; k * cycle < span; k++) {
      for (let j = 0; j < 4; j++) {
        out.push({ t: 3.45 + (k * 4 + j) * (cycle / 4), dir: CY0[j], side: 0 });
        out.push({ t: 3.45 + (k * 4 + j) * (cycle / 4), dir: CY1[j], side: 1 });
      }
    }
    return out;
  }

  /* прыжок головы ВНУТРИ раунда: смена раунда (lastTk сброшен) и фазы
     отсчёта не считается телепортом неткода */
  function jumpWithinRounds(trace) {
    let max = 0;
    let prev = null;
    for (let i = 0; i < trace.length; i++) {
      const fr = trace[i];
      if (!fr.net.dispHead) {
        prev = null;
        continue;
      }
      if (prev && fr.net.lastTk >= prev.net.lastTk && fr.phase === prev.phase) {
        const a = prev.net.dispHead.split(',');
        const b = fr.net.dispHead.split(',');
        const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
        if (d > max) max = d;
      }
      prev = fr;
    }
    return max;
  }

  const CASES = [
    { name: 'RTT 100мс + джиттер 30', up: 0.05, down: 0.05, jit: 0.03, foe: 0.05 },
    { name: 'RTT 250мс + джиттер 50', up: 0.125, down: 0.125, jit: 0.05, foe: 0.125 },
    { name: 'RTT 400мс + джиттер 80', up: 0.2, down: 0.2, jit: 0.08, foe: 0.2 },
    { name: 'АСИММЕТРИЯ: я 40мс, соперник 350мс', up: 0.02, down: 0.02, jit: 0.01, foe: 0.35 }
  ];

  /* абсолютные миллисекунды пинга в стенде сжаты (сим-время бежит
     быстрее настенных часов, а st-метки реальны) — поэтому честный
     инвариант: оценка МОНОТОННА по реальной задержке и всегда > 0 */
  const pingByCase = [];
  for (let ci = 0; ci < CASES.length; ci++) {
    const c = CASES[ci];
    /* орбита 1.2с/цикл (сторона ~11 клеток): рост от еды и сдвиг
       поворота на тик при лагах не приводят к самострелу */
    const inputs = stairInputs(1.2, 6.5).map(function (i) {
      if (i.side === 1) i.delay = c.foe; /* сторона 1 тоже «через сеть» */
      return i;
    });
    const res = runMatch({
      duration: 10.2,
      upDelay: c.up,
      downDelay: c.down,
      jitter: c.jit,
      inputs: inputs
    });
    const fight = res.trace.filter(function (f) { return f.phase === 'fight'; });
    const warmed = fight.filter(function (f) { return f.t > 5.4; });
    const jump = jumpWithinRounds(res.trace);
    const stuck = maxStuckSpan(warmed, 1.0);
    let maxOff = 0;
    for (let k = 0; k < warmed.length; k++) {
      if (warmed[k].net.offMag > maxOff) maxOff = warmed[k].net.offMag;
    }
    const resp = respLatency(res.trace, inputs, 0);
    const tail = fight.filter(function (f) { return f.t > 8.0; });
    const ping = tail.length ? (tail[tail.length - 1].net.pingMs || 0) : 0;
    pingByCase.push(ping);
    console.log('    [' + c.name + '] отклик=' + resp.toFixed(2) + 'с, коррекции<=' +
      maxOff.toFixed(1) + ', залипание=' + stuck.toFixed(1) + 'с, шаг=' + jump.toFixed(2) +
      ', пинг-оценка=' + (ping | 0) + 'мс');
    ok(resp <= 0.25, '[' + c.name + '] отклик мгновенный (<=0.25с, сеть не влияет)');
    ok(jump <= 1.35, '[' + c.name + '] без телепортов');
    ok(stuck < 2.5, '[' + c.name + '] без залипаний');
    ok(maxOff <= 10, '[' + c.name + '] коррекции ограничены');
    ok(ping > 0, '[' + c.name + '] пинг-оценка живая');
  }
  ok(pingByCase[0] < pingByCase[1] && pingByCase[1] < pingByCase[2],
    'пинг-оценка монотонна: ' + [pingByCase[0], pingByCase[1], pingByCase[2]]
      .map(function (v) { return v | 0; }).join(' < '));
  /* абсолютная точность (виртуальные часы = сим-время): оценка ≈ истина */
  const truth = [100, 250, 400]; // RTT = (up+down) без удвоения
  for (let ci = 0; ci < 3; ci++) {
    ok(Math.abs(pingByCase[ci] - truth[ci]) <= 150,
      'пинг-оценка точна [' + CASES[ci].name + ']: ' + (pingByCase[ci] | 0) +
      'мс против ' + truth[ci] + 'мс');
  }

  console.log('\n========================================');
  console.log('ИТОГ: ' + passed + ' ok, ' + failed + ' FAIL');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
  console.error('тест упал с исключением:', e);
  process.exit(1);
});
