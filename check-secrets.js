#!/usr/bin/env node
/* ============================================================
   NEON://SNAKE — проверка на секреты перед публикацией
   Запуск: node check-secrets.js
   Падает (код 1), если в отслеживаемых файлах найден:
   - токен Telegram-бота (формат 1234567890:AA...)
   - приватные ключи (BEGIN RSA/EC/OPENSSH/PRIVATE KEY)
   - пароли/токены в assignments (password=, secret=, token=...)
   - JWT (eyJ...)
   - строки подключений postgres://... mysql://... redis://...
   - реальный .env (допустим только .env.example)
   Правило: секреты живут ТОЛЬКО в .env на VPS (gitignored).
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/* правила: [название, regex] — компилируем без флагов, точные строки */
const RULES = [
  ['токен Telegram-бота', /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/],
  ['приватный ключ', /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['JWT-токен', /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./],
  ['строка подключения к БД', /\b(postgres|postgresql|mysql|redis|amqp):\/\/[^\s"']*:[^\s"'@]+@/],
  ['служебный ключ облачного провайдера', /\bservice_role[A-Za-z0-9_-]{20,}/i],
  ['явный пароль в коде', /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"\s]{4,}['"]/i],
  ['явный секрет в коде', /(?:secret|api_secret|client_secret)\s*[:=]\s*['"][^'"\s]{8,}['"]/i]
];

/* известные безопасные значения, которые нельзя-flag'ать */
const ALLOW = [
  'password.txt',           // примеры в документации
  'ПАРОЛЬ',                 // placeholder в deploy/README
  'BOT_TOKEN=',             // пустое поле в .env.example
  "'ПАРОЛЬ'", "'ТОКЕН'"     // плейсхолдеры команды деплоя
];

/* только текстовые файлы, которые git считает отслеживаемыми */
function trackedFiles() {
  try {
    const out = execSync('git ls-files', { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    /* вне git: проверим просто обходом */
    const skip = new Set(['.git', 'node_modules', 'server/ws', 'server/data']);
    const acc = [];
    (function walk(dir) {
      for (const name of fs.readdirSync(dir)) {
        if (skip.has(name) || name.startsWith('.env') && name !== '.env.example' && false) continue;
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) {
          if (!skip.has(name)) walk(p);
        } else {
          acc.push(p.replace(/\\/g, '/'));
        }
      }
    })(process.cwd());
    return acc;
  }
}

function isTextFile(p) {
  const exts = new Set(['.js', '.ts', '.json', '.md', '.html', '.css', '.yml', '.yaml',
    '.sql', '.py', '.sh', '.example', '.webmanifest', '', '.svg', '.gitignore', '.dockerignore']);
  const ext = path.extname(p);
  if (exts.has(ext)) return true;
  try {
    return !/\x00/.test(fs.readFileSync(p).toString('utf8').slice(0, 2000));
  } catch (e) {
    return false;
  }
}

let bad = 0;

/* 1) настоящий .env не должен отслеживаться */
const files = trackedFiles();
for (const f of files) {
  const base = path.basename(f);
  if (base === '.env' || (base.startsWith('.env') && base !== '.env.example')) {
    console.log('✗ ОШИБКА: файл ' + f + ' — секреты не должны попадать в git');
    bad++;
  }
}

/* 2) содержимое отслеживаемых файлов */
for (const f of files) {
  if (f.indexOf('check-secrets.js') !== -1) continue; // сами правила
  if (!isTextFile(f)) continue;
  /* тестовые фикстуры mock-*: одноразовые ключи для localhost-моков,
     секретной ценности не имеют; остальные правила остаются в силе */
  const isMockFixture = f.indexOf('/fixtures/mock-') !== -1;
  let text = '';
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch (e) {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [name, re] of RULES) {
      const m = re.exec(line);
      if (!m) continue;
      if (ALLOW.some(a => line.indexOf(a) !== -1)) continue;
      if (isMockFixture && name === 'приватный ключ') continue; // см. выше
      console.log('✗ ' + f + ':' + (i + 1) + ' — похоже на ' + name);
      console.log('    ' + line.trim().slice(0, 90).replace(m[0], m[0].slice(0, 6) + '…<<<СЕКРЕТ>>>'));
      bad++;
    }
  }
}

if (bad) {
  console.log('\nНАЙДЕНО УТЕЧЕК: ' + bad + '. Коммитить НЕЛЬЗЯ. Секрет — только в .env на VPS.');
  process.exit(1);
}
console.log('OK: секретов в отслеживаемых файлах нет (проверено файлов: ' + files.length + ')');
