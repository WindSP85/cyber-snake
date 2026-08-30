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

/* атомарно: пишем во временный файл, затем rename поверх старого */
Store.prototype._write = function (name, data) {
  const tmp = this._file(name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, this._file(name));
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
  } catch (e) {
    /* уже описано выше */
  }
  this._dirty.scores = false;
  this._dirty.duels = false;
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

module.exports = Store;
