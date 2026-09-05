#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""NEON://SNAKE — обновление серверных файлов на VPS (без nginx/certbot).

  python deploy/deploy-server.py --host <IP> --port 2222 --user root --password '...'
Загружает server.js/store.js/bot.js, пересобирает контейнер, проверяет health.
"""
import argparse
import sys
import time

try:
    import paramiko
except ImportError:
    print('Нужен paramiko: pip install paramiko')
    sys.exit(1)

REMOTE_DIR = '/opt/neon-snake'
FILES = ['server/server.js', 'server/store.js', 'server/bot.js',
         'docker-compose.vps.yml', 'Dockerfile']


def log(m):
    print('[srv] ' + m)
    sys.stdout.flush()


def sh(ssh, cmd, timeout=900, check=True):
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
    args = ap.parse_args()

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    log('SSH %s@%s:%d …' % (args.user, args.host, args.port))
    ssh.connect(args.host, port=args.port, username=args.user,
                password=args.password, timeout=20,
                look_for_keys=False, allow_agent=False)

    sftp = ssh.open_sftp()
    import posixpath
    for f in FILES:
        remote = REMOTE_DIR + '/' + f
        rdir = posixpath.dirname(remote)
        parts = rdir.strip('/').split('/')
        cur = ''
        for p in parts:
            cur += '/' + p
            try:
                sftp.stat(cur)
            except FileNotFoundError:
                sftp.mkdir(cur)
        sftp.put(f, remote)
        log('  + ' + remote)
    sftp.close()

    log('docker compose up -d --build …')
    sh(ssh, 'cd %s && docker compose -f docker-compose.vps.yml up -d --build' % REMOTE_DIR)
    time.sleep(5)
    code, out = sh(ssh, 'curl -s -m 6 http://127.0.0.1:8177/api/health', check=False)
    log('health: ' + out)
    ok = '"ok":true' in out.replace(' ', '')
    log('СЕРВЕР ОБНОВЛЁН' if ok else 'ПРОВЕРКА ПРОВАЛЕНА — смотрите docker logs')
    ssh.close()
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('\n[srv] ОСТАНОВЛЕНО: %s' % e)
        sys.exit(1)
