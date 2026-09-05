#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""NEON://SNAKE — игра со своего VPS (SPEC §28): ститика + API + WS на
одном домене https://<ip>.sslip.io. Решает недоступность github.io с
мобильных операторов РФ: телефон получает всё с сервера в 3 мс.

  python deploy/deploy-site.py --host <IP> --port 2222 --user root --password '...'

Что делает (только наши файлы, чужие сайты не трогаются):
  1. Загружает все файлы игры из git (git ls-files) в /opt/neon-snake/site
  2. Обновляет НАШ vhost: / и ститика, /api/ и /ws — в контейнер
  3. nginx -t + мягкий reload
  4. Проверяет https://<host>/ и /api/health снаружи
"""
import argparse
import base64
import sys
import time

try:
    import paramiko
except ImportError:
    print('Нужен paramiko: pip install paramiko')
    sys.exit(1)

SITE_DIR = '/opt/neon-snake/site'

NGINX_SITE = """# NEON://SNAKE — vhost игры (добавлено автоматически; чужие сайты не трогать)
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

    # API рекордов/дуэлей/ПВП
    location /api/ {{
        proxy_pass http://127.0.0.1:{port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }}

    # WebSocket дуэлей + лобби
    location /ws {{
        proxy_pass http://127.0.0.1:{port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
    }}

    # сама игра — ститика с диска (github.io с мобильных РФ недоступен)
    location / {{
        root {site};
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
    }}
}}

map $http_upgrade $connection_upgrade {{
    default upgrade;
    ''      close;
}}
"""


def log(m):
    print('[site] ' + m)
    sys.stdout.flush()


def sh(ssh, cmd, timeout=600, check=True):
    _, o, e = ssh.exec_command(cmd, timeout=timeout)
    code = o.channel.recv_exit_status()
    out = o.read().decode('utf-8', 'replace').strip()
    err = e.read().decode('utf-8', 'replace').strip()
    if check and code != 0:
        raise RuntimeError('провал (%d): %s\n%s' % (code, cmd, (out + err)[-800:]))
    return code, (out + ('\n' + err if err else '')).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', required=True)
    ap.add_argument('--port', type=int, default=2222)
    ap.add_argument('--user', default='root')
    ap.add_argument('--password', required=True)
    ap.add_argument('--game-port', type=int, default=8177)
    args = ap.parse_args()

    public_host = args.host.replace('.', '-') + '.sslip.io'

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    log('SSH %s@%s:%d …' % (args.user, args.host, args.port))
    ssh.connect(args.host, port=args.port, username=args.user,
                password=args.password, timeout=20,
                look_for_keys=False, allow_agent=False)

    # ---------- файлы игры из git ----------
    code, files_raw = sh(ssh, 'true', check=False)  # warm
    import subprocess
    files = subprocess.run(['git', 'ls-files'], capture_output=True,
                           text=True, check=True).stdout.split()
    files = [f for f in files if not f.startswith(('server/', 'deploy/', '.'))
             and f not in ('Dockerfile', 'docker-compose.yml',
                           'docker-compose.vps.yml', 'check-i18n.js',
                           'check-secrets.js')]
    log('файлов игры: %d' % len(files))

    sh(ssh, 'mkdir -p %s' % SITE_DIR)
    sftp = ssh.open_sftp()
    import posixpath
    for f in files:
        remote = SITE_DIR + '/' + f
        rdir = posixpath.dirname(remote)
        if rdir:
            parts = rdir.strip('/').split('/')
            cur = ''
            for p in parts:
                cur += '/' + p
                try:
                    sftp.stat(cur)
                except FileNotFoundError:
                    sftp.mkdir(cur)
        sftp.put(f, remote)
    sftp.close()
    log('игра загружена в ' + SITE_DIR)

    # ---------- vhost: ститика + api + ws ----------
    conf = NGINX_SITE.format(host=public_host, port=args.game_port,
                             site=SITE_DIR, acme='/var/www/neon-acme')
    b64 = base64.b64encode(conf.encode('utf-8')).decode('ascii')
    sh(ssh, 'echo %s | base64 -d > /etc/nginx/sites-available/neon-snake' % b64)
    _, out = sh(ssh, 'nginx -t 2>&1')
    log('nginx -t: ' + out.splitlines()[-1])
    sh(ssh, 'systemctl reload nginx')
    log('nginx перезагружен (мягко)')

    # ---------- проверки снаружи ----------
    time.sleep(2)
    _, out = sh(ssh, 'curl -sk -m 8 https://%s/api/health' % public_host, check=False)
    log('api/health: ' + out[:120])
    _, out = sh(ssh, 'curl -sk -m 8 -o /dev/null -w "%%{http_code}" https://%s/' % public_host, check=False)
    log('главная: HTTP ' + out)
    _, out = sh(ssh, 'curl -sk -m 8 https://%s/js/config.js | grep build' % public_host, check=False)
    log('сборка на сайте: ' + out)

    log('========================================')
    log('ИГРА ЖИВЁТ НА: https://%s/' % public_host)
    ssh.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('\n[site] ОСТАНОВЛЕНО: %s' % e)
        sys.exit(1)
