#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""NEON://SNAKE — разворачивание на VPS с ЧУЖИМ nginx (порты 80/443 заняты).

  python deploy/deploy-nginx.py --host 144.31.61.4 --port 2222 \\
      --user root --password '...' --bot-token '...'

Принцип «не трогать чужое»:
  - существующие сайты/конфиги nginx НЕ изменяются (только +1 новый файл
    sites-available/neon-snake и симлинк);
  - контейнер игры слушает 127.0.0.1:8090 (8080 упомянут в чужом конфиге,
    8000 занят чужим контейнером);
  - перед reload обязательно nginx -t; reload мягкий (без даунтайма);
  - сертификат — certbot certonly --webroot (не правит nginx сам);
  - ничего не удаляется: только добавляется /opt/neon-snake, volume, cert.
"""
import argparse
import posixpath
import sys
import time

try:
    import paramiko
except ImportError:
    print('Нужен paramiko: pip install paramiko')
    sys.exit(1)

REMOTE_DIR = '/opt/neon-snake'
GAME_PORT_DEFAULT = 8090  # хостовый порт контейнера (только localhost)
NGINX_SITE = '/etc/nginx/sites-available/neon-snake'
NGINX_LINK = '/etc/nginx/sites-enabled/neon-snake'
ACME_ROOT = '/var/www/neon-acme'

NGINX_CONF_80 = """# NEON://SNAKE — vhost игры (добавлено автоматически; чужие сайты не трогать)
# Шаг 1: только ACME-путь, чтобы выпустить сертификат
server {{
    listen 80;
    server_name {host};

    location /.well-known/acme-challenge/ {{
        root {acme};
    }}

    location / {{
        return 301 https://$host$request_uri;
    }}
}}
"""

NGINX_CONF_FULL = """# NEON://SNAKE — vhost игры (добавлено автоматически; чужие сайты не трогать)
server {{
    listen 80;
    server_name {host};

    location /.well-known/acme-challenge/ {{
        root {acme};
    }}

    location / {{
        return 301 https://$host$request_uri;
    }}
}}

server {{
    listen 443 ssl http2;
    server_name {host};

    ssl_certificate /etc/letsencrypt/live/{host}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{host}/privkey.pem;

    # API + WebSocket — один upstream
    location / {{
        proxy_pass http://127.0.0.1:{port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
    }}
}}

map $http_upgrade $connection_upgrade {{
    default upgrade;
    ''      close;
}}
"""


def log(m):
    print('[deploy] ' + m)
    sys.stdout.flush()


def sh(ssh, cmd, timeout=600, check=True, show=False):
    _, o, e = ssh.exec_command(cmd, timeout=timeout)
    code = o.channel.recv_exit_status()
    out = o.read().decode('utf-8', 'replace').strip()
    err = e.read().decode('utf-8', 'replace').strip()
    if show and out:
        log(out[-1500:])
    if check and code != 0:
        raise RuntimeError('команда провалилась (%d): %s\n%s' % (code, cmd, out + err))
    return code, (out + ('\n' + err if err else '')).strip()


def q(s):
    return "'" + s.replace("'", "'\\''") + "'"


def write_remote(ssh, path, content, mode=None):
    """Пишет файл на VPS через base64 — кириллица и кавычки не ломаются."""
    import base64
    b64 = base64.b64encode(content.encode('utf-8')).decode('ascii')
    sh(ssh, 'mkdir -p %s && echo %s | base64 -d > %s'
       % (q(posixpath.dirname(path)), b64, q(path)))
    if mode:
        sh(ssh, 'chmod %s %s' % (mode, q(path)))


def ensure_dir(sftp, path):
    parts = path.strip('/').split('/')
    cur = ''
    for p in parts:
        cur += '/' + p
        try:
            sftp.stat(cur)
        except FileNotFoundError:
            sftp.mkdir(cur)


def upload(sftp, local, remote):
    import os
    if os.path.isdir(local):
        ensure_dir(sftp, remote)
        for name in sorted(os.listdir(local)):
            upload(sftp, os.path.join(local, name), remote + '/' + name)
    else:
        ensure_dir(sftp, posixpath.dirname(remote))
        sftp.put(local, remote)
        log('  + ' + remote)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', required=True)
    ap.add_argument('--port', type=int, default=2222)
    ap.add_argument('--user', default='root')
    ap.add_argument('--password', required=True)
    ap.add_argument('--bot-token', default='')
    ap.add_argument('--game-port', type=int, default=GAME_PORT_DEFAULT)
    args = ap.parse_args()
    game_port = args.game_port

    public_host = args.host.replace('.', '-') + '.sslip.io'

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    log('SSH %s@%s:%d …' % (args.user, args.host, args.port))
    ssh.connect(args.host, port=args.port, username=args.user,
                password=args.password, timeout=20,
                look_for_keys=False, allow_agent=False)

    log('проверяю предусловия')
    _, out = sh(ssh, 'ss -tln | grep -q ":%d " && echo BUSY || echo FREE' % game_port)
    if out == 'BUSY':
        # занят НАШИМ контейнером с прошлого запуска — это повторный
        # деплой, всё в порядке; чужой процесс — стоп
        _, dock = sh(ssh, 'docker ps --filter publish=%d --format "{{.Names}}"' % game_port)
        if 'neon-snake' not in dock:
            raise RuntimeError('порт %d занят чужим процессом — запустите с другим --game-port' % game_port)
        log('порт %d занят нашим контейнером — повторное разворачивание' % game_port)
    _, out = sh(ssh, 'test -e %s && echo EXISTS || echo NEW' % NGINX_SITE)
    log('vhost nginx: ' + out)

    # ---------- файлы ----------
    log('загружаю файлы в ' + REMOTE_DIR)
    sh(ssh, 'mkdir -p ' + REMOTE_DIR)
    sftp = ssh.open_sftp()
    upload(sftp, 'server/server.js', REMOTE_DIR + '/server/server.js')
    upload(sftp, 'server/store.js', REMOTE_DIR + '/server/store.js')
    upload(sftp, 'server/bot.js', REMOTE_DIR + '/server/bot.js')
    upload(sftp, 'server/ws', REMOTE_DIR + '/server/ws')
    upload(sftp, 'Dockerfile', REMOTE_DIR + '/Dockerfile')
    upload(sftp, 'docker-compose.vps.yml', REMOTE_DIR + '/docker-compose.vps.yml')
    sftp.close()

    env = ('BOT_TOKEN=%s\nGAME_URL=https://windsp85.github.io/cyber-snake/\nGAME_PORT=%d\n'
           % (args.bot_token, game_port))
    write_remote(ssh, REMOTE_DIR + '/.env', env, mode='600')
    log('.env записан (600)')

    # ---------- контейнер (nginx ещё не трогаем) ----------
    log('docker compose up -d --build …')
    sh(ssh, 'cd %s && docker compose -f docker-compose.vps.yml up -d --build' % REMOTE_DIR,
       timeout=900, show=True)
    time.sleep(4)
    _, out = sh(ssh, 'curl -s -m 6 http://127.0.0.1:%d/api/health' % game_port)
    log('health (локально): ' + out)
    if '"ok":true' not in out.replace(' ', ''):
        raise RuntimeError('контейнер игры не отвечает; смотрите docker logs')

    # ---------- nginx: шаг 1 — ACME ----------
    log('nginx: ставлю временный блок только для ACME')
    sh(ssh, 'mkdir -p %s' % ACME_ROOT)
    write_remote(ssh, NGINX_SITE, NGINX_CONF_80.format(host=public_host, acme=ACME_ROOT))
    sh(ssh, 'ln -sfn %s %s' % (NGINX_SITE, NGINX_LINK))
    _, out = sh(ssh, 'nginx -t 2>&1')
    log('nginx -t: ' + out.splitlines()[-1])
    sh(ssh, 'systemctl reload nginx')
    log('nginx перезагружен (мягко), ваши сайты не менялись')

    # ---------- сертификат ----------
    log('certbot: выпускаю сертификат для ' + public_host)
    _, out = sh(ssh, 'curl -s -m 6 -o /dev/null -w "%%{http_code}" -H "Host: %s" http://127.0.0.1/.well-known/acme-challenge/probe' % public_host, check=False)
    log('ACME-путь доступен: HTTP ' + out)
    code, out = sh(ssh, 'certbot certonly --webroot -w %s -d %s --non-interactive --agree-tos '
                        '--keep-until-expiring' % (ACME_ROOT, public_host), check=False)
    log(out[-600:])
    _, live = sh(ssh, 'ls /etc/letsencrypt/live/%s/fullchain.pem 2>/dev/null && echo CERT-OK || echo CERT-FAIL'
                 % public_host)
    if 'CERT-OK' not in live:
        raise RuntimeError('сертификат не выпущен — смотрите вывод certbot выше')

    # ---------- nginx: шаг 2 — полный vhost ----------
    log('nginx: включаю HTTPS-прокси на игру')
    write_remote(ssh, NGINX_SITE, NGINX_CONF_FULL.format(host=public_host, acme=ACME_ROOT, port=game_port))
    _, out = sh(ssh, 'nginx -t 2>&1')
    log('nginx -t: ' + out.splitlines()[-1])
    sh(ssh, 'systemctl reload nginx')

    # ---------- проверка снаружи ----------
    ok_https = False
    for attempt in range(6):
        code, out = sh(ssh, 'curl -sk -m 8 https://%s/api/health' % public_host, check=False)
        if '"ok":true' in out.replace(' ', ''):
            ok_https = True
            break
        log('  жду HTTPS… (%d/6)' % (attempt + 1))
        time.sleep(8)
    if not ok_https:
        _, out = sh(ssh, 'tail -5 /var/log/nginx/error.log', check=False)
        log('HTTPS не отвечает. nginx error.log:\n' + out)
        raise RuntimeError('https://%s/api/health недоступен' % public_host)
    log('health (HTTPS): OK')

    # ---------- бот ----------
    _, out = sh(ssh, 'curl -s -m 8 https://api.telegram.org/ -o /dev/null -w "%%{http_code}"', check=False)
    log('api.telegram.org с VPS: HTTP ' + out + ' (000/timeout = заблокирован)')
    _, out = sh(ssh, 'cd %s && docker compose -f docker-compose.vps.yml logs game 2>&1 | grep -i bot | tail -5' % REMOTE_DIR, check=False)
    log('лог бота: ' + (out.replace('\n', ' | ') or '(пока пусто)'))

    log('========================================')
    log('ГОТОВО. Для js/config.js:')
    log('  apiBase: https://' + public_host)
    log('  wsUrl:   wss://' + public_host + '/ws')
    ssh.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('\n[deploy] ОСТАНОВЛЕНО: %s' % e)
        sys.exit(1)
