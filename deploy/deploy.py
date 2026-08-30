#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""NEON://SNAKE — разворачивание игрового сервера на VPS (Ubuntu).

Использование:
  python deploy/deploy.py --host 203.0.113.10 --user root \
      --password 'ПАРОЛЬ' --bot-token 'ТОКЕН'

Что делает:
  1. Ставит Docker, если его нет (get.docker.com)
  2. Загружает server/ + Dockerfile + docker-compose.yml в /opt/neon-snake
  3. Пишет .env (PUBLIC_HOST = <ip>.sslip.io, BOT_TOKEN)
  4. docker compose up -d --build
  5. Проверяет /api/health изнутри и снаружи

Секрет (пароль/токен) не попадает в репозиторий: пароль передаётся
аргументом, .env пишется прямо на VPS и в .gitignore.
"""
import argparse
import posixpath
import stat
import sys
import time

try:
    import paramiko
except ImportError:
    print('Нужен paramiko: pip install paramiko')
    sys.exit(1)

REMOTE_DIR = '/opt/neon-snake'

# что загружаем на VPS (локальный путь → путь относительно REMOTE_DIR)
UPLOAD = [
    ('server/server.js', 'server/server.js'),
    ('server/store.js', 'server/store.js'),
    ('server/bot.js', 'server/bot.js'),
    ('server/Caddyfile', 'server/Caddyfile'),
    ('server/ws', 'server/ws'),          # каталог целиком
    ('Dockerfile', 'Dockerfile'),
    ('docker-compose.yml', 'docker-compose.yml'),
    ('.env.example', '.env.example'),
]


def log(msg):
    print('[deploy] ' + msg)


def run(ssh, cmd, timeout=300):
    """Команда с выводом; возвращает (код, вывод)."""
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    code = stdout.channel.recv_exit_status()
    out = stdout.read().decode('utf-8', 'replace').strip()
    err = stderr.read().decode('utf-8', 'replace').strip()
    return code, (out + ('\n' + err if err else '')).strip()


def sudo_run(ssh, cmd, timeout=300, password=None):
    """sudo -S: пароль подаётся в stdin, если он нужен."""
    if password:
        full = "sudo -S -p '' bash -c " + shell_quote(cmd)
        stdin, stdout, stderr = ssh.exec_command(full, timeout=timeout)
        stdin.write(password + '\n')
        stdin.flush()
        code = stdout.channel.recv_exit_status()
        out = stdout.read().decode('utf-8', 'replace').strip()
        err = stderr.read().decode('utf-8', 'replace').strip()
        return code, (out + ('\n' + err if err else '')).strip()
    return run(ssh, cmd, timeout)


def shell_quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


def upload_file(sftp, local, remote):
    rdir = posixpath.dirname(remote)
    ensure_dir(sftp, rdir)
    sftp.put(local, remote)
    log('  + ' + remote)


def ensure_dir(sftp, path):
    parts = path.strip('/').split('/')
    cur = ''
    for p in parts:
        cur += '/' + p
        try:
            sftp.stat(cur)
        except FileNotFoundError:
            sftp.mkdir(cur)


def upload_dir(sftp, local, remote):
    import os
    ensure_dir(sftp, remote)
    for name in sorted(os.listdir(local)):
        lp = os.path.join(local, name)
        rp = remote + '/' + name
        if os.path.isdir(lp):
            upload_dir(sftp, lp, rp)
        else:
            upload_file(sftp, lp, rp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', required=True)
    ap.add_argument('--user', default='root')
    ap.add_argument('--password', default='')
    ap.add_argument('--bot-token', default='', dest='bot_token')
    ap.add_argument('--skip-install', action='store_true',
                    help='не ставить Docker (уже стоит)')
    args = ap.parse_args()

    if not args.password:
        print('Укажите --password (пароль VPS)')
        sys.exit(1)

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    log('Подключаюсь к ' + args.user + '@' + args.host + ' …')
    ssh.connect(args.host, username=args.user, password=args.password,
                timeout=20, look_for_keys=False, allow_agent=False)

    code, out = run(ssh, "cat /etc/os-release | head -1; uname -m")
    log('ОС: ' + out)
    if 'Ubuntu' not in out and 'Debian' not in out:
        log('ВНИМАНИЕ: ждали Ubuntu/Debian — продолжаю, но не гарантирую')

    # --- Docker ---
    code, out = run(ssh, 'docker --version')
    if code == 0 and 'Docker' in out:
        log('Docker уже стоит: ' + out)
    elif not args.skip_install:
        log('Ставлю Docker (get.docker.com)…')
        code, out = sudo_run(ssh, 'curl -fsSL https://get.docker.com | sh',
                             timeout=600, password=None if args.user == 'root' else args.password)
        if code != 0:
            log('ОШИБКА установки Docker:\n' + out)
            sys.exit(1)
        log('Docker установлен')

    sudo = (lambda c, t=300: sudo_run(ssh, c, timeout=t, password=None)) \
        if args.user == 'root' else \
        (lambda c, t=300: sudo_run(ssh, c, timeout=t, password=args.password))

    # --- файлы ---
    log('Загружаю файлы в ' + REMOTE_DIR)
    sudo('mkdir -p ' + REMOTE_DIR)
    # владение под пользователя, чтобы sftp мог писать
    sudo('chown ' + args.user + ' ' + REMOTE_DIR)
    sftp = ssh.open_sftp()
    import os
    for local, remote in UPLOAD:
        rp = REMOTE_DIR + '/' + remote
        if os.path.isdir(local):
            upload_dir(sftp, local, rp)
        else:
            upload_file(sftp, local, rp)
    sftp.close()

    # --- публичный IP и PUBLIC_HOST ---
    code, pub_ip = run(ssh, "curl -s -m 8 https://api.ipify.org || curl -s -m 8 ifconfig.me")
    if not pub_ip or len(pub_ip.split('.')) != 4:
        pub_ip = args.host  # fallback: подключались же по нему
    public_host = pub_ip.replace('.', '-') + '.sslip.io'
    log('Публичный адрес: https://' + public_host)

    # --- .env ---
    env_lines = [
        'PUBLIC_HOST=' + public_host,
        'BOT_TOKEN=' + args.bot_token,
        'GAME_URL=https://windsp85.github.io/cyber-snake/',
    ]
    env_cmd = ('printf %s > ' + REMOTE_DIR + '/.env && chmod 600 ' + REMOTE_DIR + '/.env') \
        % shell_quote('\n'.join(env_lines) + '\n')
    code, out = run(ssh, env_cmd)
    if code != 0:
        log('ОШИБКА записи .env: ' + out)
        sys.exit(1)
    log('.env записан (600, токен не в репозитории)')

    # --- порты firewall (ufw может быть активен) ---
    sudo('ufw status | grep -q "80/tcp" || ufw allow 80/tcp >/dev/null 2>&1 || true')
    sudo('ufw status | grep -q "443/tcp" || ufw allow 443/tcp >/dev/null 2>&1 || true')

    # --- запуск ---
    log('docker compose up -d --build …')
    code, out = sudo('cd ' + REMOTE_DIR + ' && docker compose up -d --build', timeout=600)
    if code != 0:
        log('ОШИБКА compose:\n' + out)
        sys.exit(1)
    log(out[-500:] if len(out) > 500 else out)

    # --- проверка изнутри ---
    log('Проверяю /api/health изнутри…')
    time.sleep(5)
    code, out = sudo('cd ' + REMOTE_DIR + ' && docker compose ps --format "{{.Name}} {{.Status}}"')
    log('Контейнеры: ' + out.replace('\n', ' | '))
    code, out = sudo("cd " + REMOTE_DIR + " && docker compose exec -T game node -e \"fetch('http://127.0.0.1:8080/api/health').then(r=>r.text()).then(console.log)\"")
    log('health (внутри): ' + out)

    # --- проверка снаружи (с VPS, через Caddy и HTTPS) ---
    for attempt in range(6):
        code, out = run(ssh, 'curl -sk -m 8 https://' + public_host + '/api/health')
        if code == 0 and '"ok":true' in out.replace(' ', ''):
            log('health (снаружи, HTTPS): OK')
            break
        log('  жду HTTPS-сертификат… (' + str(attempt + 1) + '/6)')
        time.sleep(10)
    else:
        log('HTTPS ещё не отвечает: смотрю логи Caddy')
        sudo('cd ' + REMOTE_DIR + ' && docker compose logs caddy --tail 15')

    log('ГОТОВО. Адреса для игры:')
    log('  apiBase: https://' + public_host)
    log('  wsUrl:   wss://' + public_host + '/ws')
    ssh.close()


if __name__ == '__main__':
    main()
