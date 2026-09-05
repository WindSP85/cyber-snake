#!/usr/bin/env node
/* ============================================================
   NEON://SNAKE — проверка двуязычности (правило №1 из AGENTS.md)
   node check-i18n.js
   Выход: 0 = OK, 1 = есть проблемы (коммитить нельзя).
   Проверяет:
   1) симметрию словарей ru/en в js/i18n.js;
   2) каждый data-i18n / data-i18n-title в index.html имеет ключ;
   3) динамические вызовы CS.I18N.t()/t()/tr() с литеральным ключом;
   4) семейства boss1..8 и p<Тип> существуют целиком.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname);
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

let problems = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); problems++; };

/* ---------- 1. словари ---------- */
const src = read('js/i18n.js');
const dictStart = src.indexOf('ru: {');
const dictEnd = src.indexOf('const listeners');
if (dictStart < 0 || dictEnd < 0) fail('не найдены словари в js/i18n.js');
const dictBody = src.slice(dictStart, dictEnd);
const ruBlock = dictBody.slice(dictBody.indexOf('ru: {') + 5, dictBody.indexOf('en: {'));
const enBlock = dictBody.slice(dictBody.indexOf('en: {') + 5, dictBody.lastIndexOf('}'));
const keysOf = (b) => new Set([...b.matchAll(/^\s{6}([A-Za-z0-9_]+):\s*['"]/gm)].map((m) => m[1]));
const ru = keysOf(ruBlock);
const en = keysOf(enBlock);
if (ru.size === 0) fail('словарь ru пуст или не распарсен');
if (en.size === 0) fail('словарь en пуст или не распарсен');
for (const k of ru) if (!en.has(k)) fail('ключ "' + k + '" есть в ru, нет в en');
for (const k of en) if (!ru.has(k)) fail('ключ "' + k + '" есть в en, нет в ru');

/* ---------- 2. data-i18n в html ---------- */
const html = read('index.html');
const attrs = [...html.matchAll(/data-i18n(?:-title)?="([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
if (!attrs.length) fail('в index.html не найдено ни одного data-i18n');
for (const k of attrs) {
  if (!ru.has(k)) fail('data-i18n "' + k + '" без ключа в словаре');
}

/* ---------- 3. литеральные вызовы в js ---------- */
for (const f of ['js/game.js', 'js/ui.js', 'js/bosses.js', 'js/leaderboard.js']) {
  const s = read(f);
  // литеральные ключи; префиксы динамической склейки ('boss' + n) пропускаются
  const calls = [...s.matchAll(/\b(?:tr|t)\(\s*'([A-Za-z0-9_]{2,})'(?!\s*\+)/g)].map((m) => m[1]);
  for (const k of new Set(calls)) {
    if (!ru.has(k)) fail(f + ': вызов с ключом "' + k + '", которого нет в словаре');
  }
}

/* ---------- 4. семейства ---------- */
const families = {
  boss: ['boss1', 'boss2', 'boss3', 'boss4', 'boss5', 'boss6', 'boss7', 'boss8'],
  pickup: ['pVirus', 'pGolden', 'pSurge', 'pSlow', 'pMagnet', 'pLife'],
};
for (const group of Object.values(families)) {
  for (const k of group) if (!ru.has(k) || !en.has(k)) fail('семейство: нет ключа "' + k + '" в обоих языках');
}

/* ---------- итог ---------- */
if (problems === 0) {
  console.log('OK: ' + ru.size + ' ключей симметричны (ru=en), ' + attrs.length + ' data-i18n покрыты, семейства целы');
  process.exit(0);
}
console.error('Проблем: ' + problems + ' — переведи на оба языка и повтори (AGENTS.md, правило №1)');
process.exit(1);
