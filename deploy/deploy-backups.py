#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Раскладка автобэкапов данных NEON://SNAKE на VPS.

Аддитивно (ничего чужого не трогаем):
  1. /opt/neon-snake/backup/               — каталог копий
  2. /etc/cron.d/neon-snake-backup         — ежедневная копия в 04:00
     (хранятся последние 14 копий pvp/scores/duels json)
  3. сразу выполняет одну копию и показывает результат

Запуск: python deploy/deploy-backups.py --host <IP> --port 2222 \
            --user root --password '...'
"""
import argparse
import sys
import time

try:
    import paramiko
except ImportError:
    print('Нужен paramiko: pip install paramiko')
    sys.exit(1)

DATA_DIR = '/var/lib/docker/volumes/neon-snake_game-data/_data'
BACKUP_DIR = '/opt/neon-snake/backup'
# cron: % обязан экранироваться как \% внутри crontab
CRON = (
    '# NEON://SNAKE -ежедневный бэкап данных игры (04:00, хранить 14)\n'
    'SHELL=/bin/sh\n'
    '0 4 * * * root tar -czf {bd}/data-$(date +\\%Y\\%m\\%d).tar.gz '
    '-C {dd} pvp.json scores.json duels.json 2>/dev/null; '
    'ls -1t {bd}/data-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -f\n'
).format(bd=BACKUP_DIR, dd=DATA_DIR)


def log(m):
    print('[bak] ' + m)
    sys.stdout.flush()


def sh(ssh, cmd, timeout=60, check=True):
    _, o, e = ssh.exec_command(cmd, timeout=timeout)
    code = o.channel.recv_exit_status()
    out = o.read().decode('utf-8', 'replace').strip()
    err = e.read().decode('utf-8', 'replace').strip()
    if check and code != 0:
        raise RuntimeError('провал (%d): %s\n%s' % (code, cmd, (out + err)[-500:]))
    return out + (('\n' + err) if err else '')


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

    log('каталог ' + BACKUP_DIR)
    sh(ssh, 'mkdir -p ' + BACKUP_DIR)

    log('crontab /etc/cron.d/neon-snake-backup')
    sftp = ssh.open_sftp()
    with sftp.open('/etc/cron.d/neon-snake-backup', 'w') as f:
        f.write(CRON)
    sftp.close()
    sh(ssh, 'chmod 644 /etc/cron.d/neon-snake-backup')

    log('пробная копия…')
    today = time.strftime('%Y%m%d')
    sh(ssh, 'tar -czf {bd}/data-{d}.tar.gz -C {dd} pvp.json scores.json duels.json '
            '2>/dev/null || tar -czf {bd}/data-{d}.tar.gz -C {dd} .'.format(
        bd=BACKUP_DIR, d=today, dd=DATA_DIR))
    out = sh(ssh, 'ls -lh %s/ | tail -3' % BACKUP_DIR)
    log('готово:\n' + out)
    ssh.close()
    log('БЭКАПЫ НАСТРОЕНЫ')


if __name__ == '__main__':
    main()
