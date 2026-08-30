#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""NEON://SNAKE — обновление бота на VPS (обход блокировки через TG_API_IP).

  python deploy/deploy-bot.py --host <IP> --port 2222 --user root \\
      --password '...' [--bot-token 'НОВЫЙ_ТОКЕН'] [--api-ip 149.154.167.220]

Делает:
  1. Убирает cloudflare-warp (поставили для теста — провайдер блокирует
     и его API, пакет бесполезен; чужие сервисы не затрагиваются)
  2. Загружает свежий server/bot.js
  3. Пишет в .env: TG_API_IP (закреплённый незаблокированный IP),
     при --bot-token заменяет токен
  4. Перезапускает контейнер и проверяет getMe через закреплённый IP
"""
import argparse
import base64
import posixpath
import sys
import time

try:
    import paramiko
except ImportError:
    print('Нужен paramiko: pip install paramiko')
    sys.exit(1)

REMOTE_DIR = '/opt/neon-snake'
DEFAULT_IP = '149.154.167.220'   # незаблокированный адрес api.telegram.org


def log(m):
    print('[bot] ' + m)
    sys.stdout.flush()


def sh(ssh, cmd, timeout=600, check=True):
    _, o, e = ssh.exec_command(cmd, timeout=timeout)
    code = o.channel.recv_exit_status()
    out = o.read().decode('utf-8', 'replace').strip()
    err = e.read().decode('utf-8', 'replace').strip()
    if check and code != 0:
        raise RuntimeError('провал (%d): %s\n%s' % (code, cmd, (out + err)[-800:]))
    return code, (out + ('\n' + err if err else '')).strip()


def q(s):
    return "'" + s.replace("'", "'\\''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', required=True)
    ap.add_argument('--port', type=int, default=2222)
    ap.add_argument('--user', default='root')
    ap.add_argument('--password', required=True)
    ap.add_argument('--bot-token', default='')
    ap.add_argument('--api-ip', default=DEFAULT_IP)
    ap.add_argument('--keep-warp', action='store_true')
    args = ap.parse_args()

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    log('SSH %s@%s:%d …' % (args.user, args.host, args.port))
    ssh.connect(args.host, port=args.port, username=args.user,
                password=args.password, timeout=20,
                look_for_keys=False, allow_agent=False)

    # ---------- 1. убрать WARP ----------
    if not args.keep_warp:
        code, out = sh(ssh, 'dpkg -s cloudflare-warp >/dev/null 2>&1 && echo YES || echo NO', check=False)
        if out == 'YES':
            log('удаляю cloudflare-warp (не работает у этого провайдера)')
            sh(ssh, 'systemctl disable --now warp-svc 2>/dev/null; '
                    'apt-get remove -y cloudflare-warp >/dev/null 2>&1; '
                    'rm -f /etc/apt/sources.list.d/cloudflare-client.list '
                    '/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg')
            log('пакет удалён')
        else:
            log('cloudflare-warp не установлен — чисто')

    # ---------- 2. bot.js ----------
    sftp = ssh.open_sftp()
    rdir = REMOTE_DIR + '/server'
    try:
        sftp.stat(rdir)
    except FileNotFoundError:
        sftp.mkdir(rdir)
    sftp.put('server/bot.js', rdir + '/bot.js')
    sftp.close()
    log('bot.js обновлён')

    # ---------- 3. .env ----------
    code, env = sh(ssh, 'cat %s/.env' % REMOTE_DIR)
    lines = []
    for line in env.splitlines():
        if line.startswith('WARP_PROXY_') or line.startswith('TG_API_IP'):
            continue
        if args.bot_token and line.startswith('BOT_TOKEN='):
            lines.append('BOT_TOKEN=' + args.bot_token)
            continue
        lines.append(line)
    if not any(l.startswith('BOT_TOKEN=') for l in lines):
        lines.append('BOT_TOKEN=' + args.bot_token)
    lines.append('TG_API_IP=' + args.api_ip)
    content = '\n'.join(lines).strip() + '\n'
    b64 = base64.b64encode(content.encode('utf-8')).decode('ascii')
    sh(ssh, 'echo %s | base64 -d > %s/.env && chmod 600 %s/.env' % (b64, REMOTE_DIR, REMOTE_DIR))
    log('.env: TG_API_IP=%s, токен %s' % (args.api_ip, 'обновлён' if args.bot_token else 'без изменений'))

    # ---------- 4. перезапуск ----------
    sh(ssh, 'cd %s && docker compose -f docker-compose.vps.yml up -d --build' % REMOTE_DIR, timeout=900)
    time.sleep(6)

    # ---------- 5. проверка ----------
    code, out = sh(ssh, 'TOKEN=$(grep ^BOT_TOKEN %s/.env | cut -d= -f2); '
                        'curl -s --resolve api.telegram.org:443:%s -m 10 '
                        '"https://api.telegram.org/bot$TOKEN/getMe" | head -c 200'
                        % (REMOTE_DIR, args.api_ip), check=False)
    log('getMe: ' + out)
    ok_me = '"ok":true' in out.replace(' ', '')
    code, out = sh(ssh, 'cd %s && docker compose -f docker-compose.vps.yml logs game --since 1m 2>&1 | grep -i bot | tail -5' % REMOTE_DIR, check=False)
    log('логи: ' + out.replace('\n', ' | '))
    log('========================================')
    log('БОТ ЖИВ ✓' if ok_me else 'БОТ ЕЩЁ НЕ ОТВЕЧАЕТ (токен?) — получите новый в BotFather и повторите с --bot-token')
    ssh.close()
    sys.exit(0 if ok_me else 2)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('\n[bot] ОСТАНОВЛЕНО: %s' % e)
        sys.exit(1)
