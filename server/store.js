/* ============================================================
   NEON://SNAKE — серверное хранилище (VPS)
   Store: таблица рекордов + история дуэлей в JSON-файлах.

   Никаких зависимостей: массив в памяти + атомарная запись
   (tmp + rename) с дебаунсом. Для масштабов змейки этого хватает
   с большим запасом: запись рекорда — редкое событие.

   Ограничения (защита от переполнения диска):
   - scores: топ-500 за каждый сезон (месяц)
   - duels: последние 5000 матчей
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const FLUSH_DELAY = 500;   // мс между записью в памяти и на диск
const SEASON_TOP = 500;    // максимум строк одного сезона
const DUELS_MAX = 5000;    // максимум строк истории дуэлей

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function Store(dir) {
  this.dir = dir;
  this.scores = [];
  this.duels = [];
  this._dirty = { scores: false, duels: false };
  this._timer = null;
  this._pvpTimer = null;
  this.onError = null;      // опционально:cb(e) — ошибка записи на диск
  this._writeWarned = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    /* каталог уже существует или недоступен — увидим на загрузке */
  }
  this.scores = this._load('scores.json');
  this.duels = this._load('duels.json');
}

/* ---------- загрузка / сохранение ---------- */

Store.prototype._file = function (name) {
  return path.join(this.dir, name);
};

Store.prototype._load = function (name) {
  try {
    const raw = fs.readFileSync(this._file(name), 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      const out = [];
      for (let i = 0; i < data.length; i++) {
        if (isObj(data[i])) out.push(data[i]);
      }
      return out;
    }
  } catch (e) {
    /* нет файла или битый JSON — начинаем с пустого списка */
  }
  return [];
};

/* атомарно: пишем во временный файл, затем rename поверх старого;
   при провале — один громкий отчёт (молчаливая потеря диска недопустима) */
Store.prototype._write = function (name, data) {
  try {
    const tmp = this._file(name + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, this._file(name));
  } catch (e) {
    if (!this._writeWarned) {
      this._writeWarned = true;
      if (typeof this.onError === 'function') this.onError(e);
    }
    throw e;
  }
};

Store.prototype._schedule = function () {
  if (this._timer) return;
  const self = this;
  this._timer = setTimeout(function () {
    self._timer = null;
    try {
      if (self._dirty.scores) self._write('scores.json', self.scores);
      if (self._dirty.duels) self._write('duels.json', self.duels);
      self._dirty.scores = false;
      self._dirty.duels = false;
    } catch (e) {
      /* диск недоступен: данные остаются в памяти, попробуем позже */
      self._dirty.scores = true;
      self._dirty.duels = true;
    }
  }, FLUSH_DELAY);
  if (typeof this._timer.unref === 'function') this._timer.unref();
};

/* принудительная синхронизация (для тестов и аккуратной остановки) */
Store.prototype.flush = function () {
  if (this._timer) {
    clearTimeout(this._timer);
    this._timer = null;
  }
  try {
    if (this._dirty.scores) this._write('scores.json', this.scores);
    if (this._dirty.duels) this._write('duels.json', this.duels);
    if (this._dirtyPvp) this._write('pvp.json', this.pvp);
  } catch (e) {
    /* уже описано выше */
  }
  this._dirty.scores = false;
  this._dirty.duels = false;
  this._dirtyPvp = false;
};

/* ---------- рекорды ---------- */

/* entry: {name, score, level, season}; created_at ставит сервер */
Store.prototype.addScore = function (entry) {
  if (!isObj(entry)) return false;
  const row = {
    name: String(entry.name || '').slice(0, 20),
    score: Math.max(0, Math.min(999999, Math.floor(Number(entry.score) || 0))),
    level: Math.max(1, Math.min(999, Math.floor(Number(entry.level) || 1))),
    season: String(entry.season || ''),
    created_at: new Date().toISOString()
  };
  this.scores.push(row);
  this._trimScores();
  this._dirty.scores = true;
  this._schedule();
  return true;
};

/* в каждом сезоне оставляем только топ по очкам */
Store.prototype._trimScores = function () {
  if (this.scores.length <= SEASON_TOP) return;
  const bySeason = {};
  for (let i = 0; i < this.scores.length; i++) {
    const s = this.scores[i].season || 'other';
    if (!bySeason[s]) bySeason[s] = [];
    bySeason[s].push(this.scores[i]);
  }
  const out = [];
  for (const s in bySeason) {
    if (!Object.prototype.hasOwnProperty.call(bySeason, s)) continue;
    const rows = bySeason[s];
    rows.sort(function (a, b) { return b.score - a.score; });
    for (let i = 0; i < rows.length && i < SEASON_TOP; i++) out.push(rows[i]);
  }
  this.scores = out;
};

/* топ сезона (или общий), отсортирован по очкам, максимум limit */
Store.prototype.top = function (season, limit) {
  const n = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
  let rows = this.scores;
  if (season) rows = rows.filter(function (r) { return r.season === season; });
  return rows.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, n);
};

/* ---------- дуэли ---------- */

Store.prototype.addDuel = function (rec) {
  if (!isObj(rec)) return false;
  this.duels.push({
    winner: String(rec.winner || '').slice(0, 20),
    loser: String(rec.loser || '').slice(0, 20),
    rounds: String(rec.rounds || '').slice(0, 9),
    created_at: new Date().toISOString()
  });
  if (this.duels.length > DUELS_MAX) this.duels = this.duels.slice(-DUELS_MAX);
  this._dirty.duels = true;
  this._schedule();
  return true;
};

/* ---------- ПВП: рейтинг, статистика, статусы (SPEC §28) ----------
   pvp.json: { players: { имя: запись } }. Рейтинг — Эло (старт 1000,
   K=32) с «очковым коэффициентом»: победа 2:0 даёт бонус +6, 2:1 —
   +3, а поражение 2:1 бьёт по рейтингу мягче (×0.8). Статусы
   вычисляются из записи на сервере — с клиента их не прислать. */

const RATING_START = 1000;
const RATING_K = 32;
const PVP_CAUSES = ['bite', 'loop', 'headon', 'crash']; // способы побед в раунде
const PVP_OPPONENTS_MAX = 200; // сколько разных побеждённых помнить

function dayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
    '-' + String(d.getDate()).padStart(2, '0');
}

Store.prototype._pvpLoad = function () {
  if (this.pvp) return;
  const data = this._load('pvp.json');
  this.pvp = isObj(data) && isObj(data.players) ? data : { players: {} };
  this._dirtyPvp = false;
};

Store.prototype._pvpPlayer = function (name) {
  this._pvpLoad();
  const key = String(name || '').slice(0, 20);
  if (!this.pvp.players[key]) {
    this.pvp.players[key] = {
      rating: RATING_START, bestRating: RATING_START,
      wins: 0, losses: 0, matches: 0,
      streakBest: 0, streakCur: 0,
      cleanWins: 0, comeback: 0,
      biteWins: 0, loopWins: 0, headonWins: 0,
      roundsWon: 0, roundsLost: 0,
      opponents: {},
      prev: '',                 // результат прошлого матча: win|loss|draw
      dayKey: '', winsToday: 0
    };
  }
  return this.pvp.players[key];
};

Store.prototype._schedulePvp = function () {
  if (this._pvpTimer) return;
  const self = this;
  this._pvpTimer = setTimeout(function () {
    self._pvpTimer = null;
    try {
      if (self._dirtyPvp) self._write('pvp.json', self.pvp);
    } catch (e) {
      /* диск недоступен: данные в памяти, попробуем позже */
      self._dirtyPvp = true;
    }
    self._dirtyPvp = false;
  }, FLUSH_DELAY);
  if (typeof this._pvpTimer.unref === 'function') this._pvpTimer.unref();
};

/* итог матча: rec = {winner, loser, wRounds, lRounds, causes:[...]}
   causes — способы победы ПОБЕДИТЕЛЯ по раундам (bite/loop/headon/crash) */
Store.prototype.addPvpResult = function (rec) {
  if (!isObj(rec)) return false;
  const winner = String(rec.winner || '').slice(0, 20);
  const loser = String(rec.loser || '').slice(0, 20);
  if (!winner || !loser) return false;
  const wR = Math.max(0, Math.min(9, Math.floor(Number(rec.wRounds) || 0)));
  const lR = Math.max(0, Math.min(9, Math.floor(Number(rec.lRounds) || 0)));
  const causes = Array.isArray(rec.causes)
    ? rec.causes
        .map(function (c) { return String(c); })
        .filter(function (c) { return PVP_CAUSES.indexOf(c) !== -1; })
        .slice(0, 7)
    : [];

  const W = this._pvpPlayer(winner);
  const L = this._pvpPlayer(loser);

  /* счётчики «за сегодня» перекатываются на новый день */
  const today = dayKey();
  if (W.dayKey !== today) { W.dayKey = today; W.winsToday = 0; }
  if (L.dayKey !== today) { L.dayKey = today; L.winsToday = 0; }

  W.matches++;
  L.matches++;
  W.roundsWon += wR; W.roundsLost += lR;
  L.roundsWon += lR; L.roundsLost += wR;

  if (wR === lR) {
    /* ничья: рейтинг не трогаем, серии не ломаем */
  } else {
    /* Эло + очковый коэффициент (размах по раундам) */
    const ew = 1 / (1 + Math.pow(10, (L.rating - W.rating) / 400));
    const spread = wR - lR; // >= 1 у победителя
    W.rating = Math.max(100, Math.round(W.rating + RATING_K * (1 - ew) + (spread >= 2 ? 6 : 3)));
    L.rating = Math.max(100, Math.round(L.rating - RATING_K * ew * (spread >= 2 ? 1 : 0.8)));
    W.bestRating = Math.max(W.bestRating, W.rating);

    W.wins++;
    L.losses++;
    W.winsToday++;
    W.streakCur = W.streakCur >= 0 ? W.streakCur + 1 : 1;
    W.streakBest = Math.max(W.streakBest, W.streakCur);
    L.streakCur = 0;
    if (W.prev === 'loss') W.comeback++; // победа сразу после своего поражения
    if (spread >= 2) W.cleanWins++;
    for (let i = 0; i < causes.length; i++) {
      if (causes[i] === 'bite') W.biteWins++;
      else if (causes[i] === 'loop') W.loopWins++;
      else if (causes[i] === 'headon') W.headonWins++;
    }
    /* галерея разных побеждённых соперников */
    if (!W.opponents[loser] && Object.keys(W.opponents).length < PVP_OPPONENTS_MAX) {
      W.opponents[loser] = 1;
    }
  }

  W.prev = wR === lR ? W.prev : 'win';
  L.prev = wR === lR ? L.prev : 'loss';

  this._dirtyPvp = true;
  this._schedulePvp();
  return true;
};

/* статусы 1..20 — только по фактической статистике; тексты
   согласованы с семейством pvpS1..pvpS20 в js/i18n.js */
Store.prototype.pvpStatuses = function (p) {
  const ids = [];
  const oppCount = Object.keys(p.opponents || {}).length;
  if (p.matches >= 1) ids.push(1);            // Новобранец Сети
  if (p.wins >= 1) ids.push(2);               // Первая кровь
  if (p.matches >= 10) ids.push(3);           // Дуэлянт
  if (p.wins >= 10) ids.push(4);              // Охотник
  if (p.streakBest >= 3) ids.push(5);         // Серийный
  if (p.biteWins >= 5) ids.push(6);           // Кусака
  if (p.loopWins >= 3) ids.push(7);           // Кольцевик
  if (p.matches >= 25) ids.push(8);           // Ветеран арены
  if (p.bestRating >= 1200) ids.push(9);      // Хромир
  if (p.wins >= 25) ids.push(10);             // Гладиатор
  if (p.cleanWins >= 10) ids.push(11);        // Разрушитель
  if (p.comeback >= 5) ids.push(12);          // Мститель
  if (p.bestRating >= 1400) ids.push(13);     // Неоновый
  if (p.winsToday >= 3) ids.push(14);         // Ночной штурм
  if (p.roundsWon >= 30) ids.push(15);        // Тактик
  if (p.bestRating >= 1600) ids.push(16);     // Титан
  if (p.wins >= 100) ids.push(17);            // Легенда арены
  if (p.streakBest >= 10) ids.push(18);       // Идеальная серия
  if (oppCount >= 10) ids.push(19);           // Пожиратель чемпионов
  if (p.bestRating >= 1800) ids.push(20);     // Абсолют
  return ids;
};

/* публичная карточка игрока для /api/pvp?name= */
Store.prototype.pvpPublic = function (name) {
  this._pvpLoad();
  const p = this.pvp.players[String(name || '').slice(0, 20)];
  if (!p) return null;
  return {
    name: String(name).slice(0, 20),
    rating: p.rating,
    wins: p.wins,
    losses: p.losses,
    matches: p.matches,
    streakBest: p.streakBest,
    bestRating: p.bestRating,
    statuses: this.pvpStatuses(p)
  };
};

/* топ по рейтингу; у каждой строки — старший достигнутый статус */
Store.prototype.pvpTop = function (limit) {
  this._pvpLoad();
  const n = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
  const rows = [];
  for (const name in this.pvp.players) {
    if (!Object.prototype.hasOwnProperty.call(this.pvp.players, name)) continue;
    const p = this.pvp.players[name];
    if (p.matches < 1) continue;
    const st = this.pvpStatuses(p);
    rows.push({
      name: name,
      rating: p.rating,
      wins: p.wins,
      losses: p.losses,
      status: st.length ? st[st.length - 1] : 0
    });
  }
  rows.sort(function (a, b) { return b.rating - a.rating; });
  return rows.slice(0, n);
};

module.exports = Store;
